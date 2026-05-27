/**
 * Lifecycle sweep — the executor for `planLifecycleTransitions`.
 *
 * Split deliberately from lib/lifecycle.ts:
 *
 *   lifecycle.ts   = pure decision logic (no DB, no I/O, easy to test)
 *   lifecycleSweep = the I/O layer (reads from Postgres, applies the
 *                    plan in a transaction, runs the retention sweep
 *                    that hard-deletes long-evicted rows)
 *
 * Why a hard-delete step lives here:
 *   evaluateLifecycleTier marks rows as "evicted" but never deletes
 *   anything. That's correct — eviction is the decision, retention
 *   is the policy. This sweep encodes the policy: rows that have
 *   been in "evicted" status longer than retentionDays are removed.
 *   See DATA-RETENTION.md for the why behind the default window.
 *
 * Cron contract:
 *   - Idempotent: re-runs are safe (transitions skip unchanged rows;
 *     hard-delete only touches rows past the cutoff).
 *   - Bounded: reads candidates in fixed-size batches to avoid loading
 *     the whole table when the dataset grows.
 *   - Transactional: each batch's UPDATEs run in a single transaction;
 *     a crash mid-sweep leaves the DB consistent.
 */
import type { Client } from "pg";

import {
  DEFAULT_LIFECYCLE_CONFIG,
  planLifecycleTransitions,
  type LifecycleConfig,
  type LifecycleItem,
  type LifecyclePlan,
} from "./lifecycle";

export type LifecycleSweepOptions = {
  /** Hard-delete rows whose evicted_at is older than this. Default 90. */
  retentionDays?: number;
  /** Candidate-page size; tune for large tables. Default 500. */
  batchSize?: number;
  /** If true, computes the plan but writes nothing. Useful for ops dry-runs. */
  dryRun?: boolean;
  /** Override the lifecycle decision config (mostly for tests). */
  config?: LifecycleConfig;
  /** Inject "now" for deterministic tests. */
  now?: Date;
};

export type VectorDeleteResult = {
  ok: boolean;
  deleted?: number;
  skipped?: boolean;
  error?: string;
};

export type LifecycleSweepDeps = {
  /**
   * Optional. When provided, the sweep calls this with the ids of
   * rows that were hard-deleted from Postgres so the matching points
   * can be removed from Qdrant. In prod this is `deleteVectors` from
   * lib/vector.ts. Tests can omit it or pass a stub.
   *
   * Errors don't fail the sweep — orphan points are recoverable
   * (re-run later, or run a one-shot janitor). Failing the sweep
   * here would leave Postgres in the correct state but break the
   * cron loop, which is worse.
   */
  deleteVectors?: (ids: string[]) => Promise<VectorDeleteResult>;
  /**
   * Optional. Called once per run with the final stats. Used to wire
   * Prometheus counters/histograms from lib/metrics.ts without
   * importing prom-client into this module (so unit tests don't drag
   * the metrics surface in).
   */
  recordStats?: (stats: LifecycleSweepStats) => void;
};

export type LifecycleSweepStats = {
  scanned: number;
  archived: number;
  evicted: number;
  revived: number;
  unchanged: number;
  hardDeleted: number;
  /** Points removed from Qdrant during the retention sweep (0 if no deps.deleteVectors). */
  vectorsDeleted: number;
  /** Best-effort error message if Qdrant cleanup failed. Orphan ids land back in the next sweep's input. */
  vectorsError: string | null;
  durationMs: number;
  startedAt: string;
  retentionDays: number;
  dryRun: boolean;
};

const DEFAULT_RETENTION_DAYS = 90;
const DEFAULT_BATCH_SIZE = 500;

type Row = {
  id: string;
  lifecycle_tier: string | null;
  created_at: Date | string | null;
  last_used_at: Date | string | null;
  quality_score: string | number | null;
  validation_status: string | null;
};

function rowToItem(row: Row): LifecycleItem {
  const score =
    row.quality_score == null
      ? null
      : typeof row.quality_score === "number"
        ? row.quality_score
        : Number(row.quality_score);
  return {
    id: row.id,
    currentTier:
      row.lifecycle_tier === "working" ||
      row.lifecycle_tier === "archived" ||
      row.lifecycle_tier === "evicted"
        ? row.lifecycle_tier
        : null,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    qualityScore: Number.isFinite(score as number) ? (score as number) : null,
    validationStatus: row.validation_status,
  };
}

/**
 * Applies a single plan's UPDATEs inside a transaction. The caller is
 * responsible for the overall sweep loop and stats aggregation.
 *
 * We set lifecycle_evaluated_at on every changed row so ops can tell
 * "when did this row last get re-tiered" from a single column.
 *
 * For rows transitioning INTO "evicted" we also stamp evicted_at —
 * that's the anchor the retention sweep uses to decide hard-delete.
 * Rows that revive OUT of "evicted" get evicted_at cleared so a
 * subsequent re-eviction starts the clock fresh.
 */
async function applyPlan(
  client: Client,
  plan: LifecyclePlan,
): Promise<void> {
  if (!plan.toArchive.length && !plan.toEvict.length && !plan.toRevive.length) {
    return;
  }
  await client.query("BEGIN");
  try {
    if (plan.toArchive.length) {
      await client.query(
        `UPDATE research_items
            SET lifecycle_tier = 'archived',
                lifecycle_evaluated_at = NOW(),
                evicted_at = NULL
          WHERE id = ANY($1::text[])`,
        [plan.toArchive],
      );
    }
    if (plan.toEvict.length) {
      await client.query(
        `UPDATE research_items
            SET lifecycle_tier = 'evicted',
                lifecycle_evaluated_at = NOW(),
                evicted_at = COALESCE(evicted_at, NOW())
          WHERE id = ANY($1::text[])`,
        [plan.toEvict],
      );
    }
    if (plan.toRevive.length) {
      await client.query(
        `UPDATE research_items
            SET lifecycle_tier = 'working',
                lifecycle_evaluated_at = NOW(),
                evicted_at = NULL
          WHERE id = ANY($1::text[])`,
        [plan.toRevive],
      );
    }
    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  }
}

/**
 * Hard-delete rows that have been "evicted" longer than the retention
 * window. We never delete rows whose lifecycle_tier ≠ 'evicted' — even
 * if evicted_at is stale — because that would mean a revive happened
 * but evicted_at was not cleared (defense in depth against partial
 * writes from a previous version of this sweep).
 *
 * Returns the ids deleted so the caller can hand them to the Qdrant
 * point cleanup. Uses RETURNING so we capture exactly the rows that
 * the DELETE matched — no race with concurrent UPDATEs.
 */
async function hardDeleteExpired(
  client: Client,
  retentionDays: number,
): Promise<string[]> {
  const res = await client.query<{ id: string }>(
    `DELETE FROM research_items
      WHERE lifecycle_tier = 'evicted'
        AND evicted_at IS NOT NULL
        AND evicted_at < NOW() - ($1 || ' days')::interval
      RETURNING id`,
    [String(retentionDays)],
  );
  return res.rows.map((r) => r.id);
}

/**
 * Main entry point. Loops over research_items in batches, computes a
 * plan per batch via the pure decision module, applies it, and (unless
 * dryRun) hard-deletes evicted rows past retention.
 *
 * Returns aggregated stats so cron output / Prometheus exporters can
 * surface them. Designed to be called from `scripts/lifecycle-sweep.ts`
 * or an admin-triggered HTTP endpoint.
 */
export async function runLifecycleSweep(
  client: Client,
  deps: LifecycleSweepDeps = {},
  opts: LifecycleSweepOptions = {},
): Promise<LifecycleSweepStats> {
  const retentionDays = opts.retentionDays ?? DEFAULT_RETENTION_DAYS;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const config = opts.config ?? DEFAULT_LIFECYCLE_CONFIG;
  const now = opts.now ?? new Date();
  const dryRun = opts.dryRun ?? false;
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const stats: LifecycleSweepStats = {
    scanned: 0,
    archived: 0,
    evicted: 0,
    revived: 0,
    unchanged: 0,
    hardDeleted: 0,
    vectorsDeleted: 0,
    vectorsError: null,
    durationMs: 0,
    startedAt,
    retentionDays,
    dryRun,
  };

  // Page by primary key for a stable, indexable cursor. We never
  // re-visit a row in the same sweep — rows updated mid-sweep won't
  // shift our cursor because we order by id.
  let cursor: string | null = null;
  for (;;) {
    const params: Array<string | number> = [];
    const where: string[] = [];
    if (cursor !== null) {
      params.push(cursor);
      where.push(`id > $${params.length}`);
    }
    params.push(batchSize);
    const sql = `SELECT id,
                        lifecycle_tier,
                        created_at,
                        last_used_at,
                        quality_score,
                        validation_status
                   FROM research_items
                   ${where.length ? `WHERE ${where.join(" AND ")}` : ""}
                   ORDER BY id
                   LIMIT $${params.length}`;
    const res = await client.query<Row>(sql, params);
    if (!res.rowCount) break;
    stats.scanned += res.rowCount;

    const items = res.rows.map(rowToItem);
    const plan = planLifecycleTransitions(items, now, config);
    stats.archived += plan.toArchive.length;
    stats.evicted += plan.toEvict.length;
    stats.revived += plan.toRevive.length;
    stats.unchanged += plan.unchanged;

    if (!dryRun) {
      await applyPlan(client, plan);
    }

    cursor = res.rows[res.rows.length - 1]!.id;
    if (res.rowCount < batchSize) break;
  }

  if (!dryRun) {
    const deletedIds = await hardDeleteExpired(client, retentionDays);
    stats.hardDeleted = deletedIds.length;

    // Best-effort Qdrant cleanup. Failures don't fail the sweep:
    // the orphan points won't be selected next time (they're no
    // longer in Postgres), but a separate janitor / next-sweep run
    // can re-attempt cleanup if `vectorsError` shows up in stats.
    if (deletedIds.length && deps.deleteVectors) {
      try {
        const result = await deps.deleteVectors(deletedIds);
        if (result.ok) {
          stats.vectorsDeleted = result.deleted ?? deletedIds.length;
        } else if (!result.skipped) {
          stats.vectorsError = result.error ?? "vector_delete_failed";
        }
      } catch (err) {
        stats.vectorsError = (err as Error).message;
      }
    }
  }

  stats.durationMs = Date.now() - t0;
  if (deps.recordStats) {
    try {
      deps.recordStats(stats);
    } catch {
      // Never let a metrics writer break a successful sweep.
    }
  }
  return stats;
}
