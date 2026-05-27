/**
 * Offline re-embed pass — migrates research_items vectors from one
 * embedding provider to another (typically: hash → openai).
 *
 * Why this exists:
 *   When KNOWLEDGE_EMBEDDING_PROVIDER flipped to "openai", new rows
 *   started getting OpenAI vectors but the historical corpus stayed
 *   on hash vectors. A Qdrant collection with mixed vector spaces
 *   returns inconsistent similarity scores. This script catches up
 *   the legacy rows.
 *
 * Why it's a separate module from `upsertVectors`:
 *   `upsertVectors` is fired by every ingest call (one item at a
 *   time, latency-sensitive). The re-embed is a batch ETL —
 *   different shape, different error budget, different observability.
 *
 * Resumability + idempotency:
 *   The `vector_provider` column on research_items marks which
 *   encoder last wrote each row's Qdrant vector. The selector picks
 *   only rows that haven't been processed yet. So:
 *     - Crash mid-run? Re-run, picks up where it left off.
 *     - Run twice in a row? Second run scans 0 rows.
 *     - Switch back to hash later? Run with targetProvider="hash"
 *       and the rows currently marked "openai" will be re-processed.
 */
import type { Client } from "pg";

import type { VectorItem } from "./vector";

type ResearchItemRow = {
  id: string;
  source: string;
  date: string | null;
  track: string | null;
  title: string;
  path: string;
  agents: string[] | null;
  chains: string[] | null;
  summary: string | null;
  visibility: string | null;
  organization_id: string | null;
  contributor_agent_id: string | null;
  validation_status: string | null;
  sanitization_status: string | null;
};

export type ReembedUpsertResult = {
  ok: boolean;
  upserted?: number;
  error?: string;
};

export type ReembedDeps = {
  /**
   * Pluggable so tests don't need to mock fetch + Qdrant. In prod
   * this is `upsertVectors` from lib/vector.ts.
   */
  upsert: (items: VectorItem[]) => Promise<ReembedUpsertResult>;
};

export type ReembedOptions = {
  /** Provider tag to write to `vector_provider` on success. Default "openai". */
  targetProvider?: string;
  /** Rows per batch — also the Qdrant upsert payload size. Default 50. */
  batchSize?: number;
  /** Compute the batches + simulate upserts, but write nothing. Default false. */
  dryRun?: boolean;
  /** Safety cap on rows processed in one invocation. Default no cap. */
  limit?: number;
};

export type ReembedStats = {
  scanned: number;
  reembedded: number;
  failed: number;
  errors: Array<{ id: string; error: string }>;
  durationMs: number;
  startedAt: string;
  targetProvider: string;
  dryRun: boolean;
};

const DEFAULT_BATCH_SIZE = 50;
const DEFAULT_TARGET = "openai";
const MAX_ERROR_DETAIL = 50;

function rowToVectorItem(row: ResearchItemRow): VectorItem {
  return {
    id: row.id,
    source: row.source,
    date: row.date,
    track: row.track,
    title: row.title,
    path: row.path,
    agents: row.agents ?? [],
    chains: row.chains ?? [],
    summary: row.summary,
    visibility: row.visibility === "private" ? "private" : "public",
    organization_id: row.organization_id,
    contributor_agent_id: row.contributor_agent_id,
    validation_status: row.validation_status,
    sanitization_status: row.sanitization_status,
  };
}

/**
 * Selects up to `batchSize` rows whose vector_provider does not match
 * the target (NULL counts as not-matched, so legacy rows are picked
 * up by default). Ordering by id gives a stable cursor — successive
 * batches don't reshuffle, even though we don't carry an explicit
 * cursor (the WHERE clause is its own cursor: once a row is updated
 * it stops matching).
 */
async function selectBatch(
  client: Client,
  targetProvider: string,
  batchSize: number,
): Promise<ResearchItemRow[]> {
  const res = await client.query<ResearchItemRow>(
    `SELECT id, source, date, track, title, path, agents, chains, summary,
            visibility, organization_id, contributor_agent_id,
            validation_status, sanitization_status
       FROM research_items
      WHERE vector_provider IS DISTINCT FROM $1
      ORDER BY id
      LIMIT $2`,
    [targetProvider, batchSize],
  );
  return res.rows;
}

async function markRowsDone(
  client: Client,
  ids: string[],
  targetProvider: string,
): Promise<void> {
  if (!ids.length) return;
  await client.query(
    `UPDATE research_items
        SET vector_provider = $1,
            vector_embedded_at = NOW()
      WHERE id = ANY($2::text[])`,
    [targetProvider, ids],
  );
}

/**
 * Main entry. Pulls pending rows in batches, hands each batch to the
 * injected `upsert` (typically `upsertVectors` → Qdrant), and on
 * success marks the rows so a re-run won't reprocess them.
 *
 * Failures in a batch don't poison the whole run: the bad batch's
 * IDs land in `stats.errors` and the loop continues to the next
 * batch. We rely on the next invocation to retry them (they'll still
 * be selected because their vector_provider didn't get updated).
 */
export async function runReembed(
  client: Client,
  deps: ReembedDeps,
  opts: ReembedOptions = {},
): Promise<ReembedStats> {
  const targetProvider = opts.targetProvider ?? DEFAULT_TARGET;
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const dryRun = opts.dryRun ?? false;
  const limit = opts.limit;
  const startedAt = new Date().toISOString();
  const t0 = Date.now();

  const stats: ReembedStats = {
    scanned: 0,
    reembedded: 0,
    failed: 0,
    errors: [],
    durationMs: 0,
    startedAt,
    targetProvider,
    dryRun,
  };

  for (;;) {
    if (limit !== undefined && stats.scanned >= limit) break;

    const remaining =
      limit === undefined ? batchSize : Math.min(batchSize, limit - stats.scanned);
    const rows = await selectBatch(client, targetProvider, remaining);
    if (!rows.length) break;
    stats.scanned += rows.length;

    if (dryRun) {
      // We still count rows as "would be reembedded" so the operator
      // can preview the impact of a real run.
      stats.reembedded += rows.length;
      // dryRun must NOT mark rows done — otherwise a real run would
      // immediately skip them. Bail without touching state.
      // We also bail out of the loop because the next selectBatch
      // would return the same rows forever.
      break;
    }

    const items = rows.map(rowToVectorItem);
    let result: ReembedUpsertResult;
    try {
      result = await deps.upsert(items);
    } catch (err) {
      result = { ok: false, error: (err as Error).message };
    }

    if (result.ok) {
      await markRowsDone(client, rows.map((r) => r.id), targetProvider);
      stats.reembedded += rows.length;
    } else {
      stats.failed += rows.length;
      const detail = (result.error || "unknown_error").slice(0, MAX_ERROR_DETAIL);
      // Keep the per-id error list bounded so a runaway failure
      // doesn't OOM the response payload.
      for (const r of rows) {
        if (stats.errors.length >= 100) break;
        stats.errors.push({ id: r.id, error: detail });
      }
      // Break to avoid spinning on the same failing batch — the next
      // invocation can retry once the underlying cause is fixed.
      break;
    }
  }

  stats.durationMs = Date.now() - t0;
  return stats;
}
