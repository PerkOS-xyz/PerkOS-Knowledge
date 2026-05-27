/**
 * Admin-only endpoint that runs the offline re-embed pass.
 *
 * Triggered manually (or from a one-shot cron) when the embedding
 * provider changes — e.g. flipping KNOWLEDGE_EMBEDDING_PROVIDER from
 * "hash" to "openai" and needing to catch up the historical corpus.
 *
 *   curl -X POST \
 *     -H "Authorization: Bearer $KNOWLEDGE_ADMIN_TOKEN" \
 *     -H "content-type: application/json" \
 *     -d '{"dryRun": true}' \
 *     https://knowledge.perkos.xyz/api/admin/vectors/reembed
 *
 * Body fields (all optional):
 *   targetProvider string   — provider tag to stamp on success. Default "openai".
 *   batchSize      number   — rows per Qdrant upsert. Default 50.
 *   dryRun         boolean  — preview only; nothing is written. Default false.
 *   limit          number   — cap on rows processed in one invocation. Default no cap.
 *
 * The route is idempotent: re-running scans 0 rows once everything is
 * caught up. Long-running jobs can be sliced by passing `limit`; the
 * resumability comes from the `vector_provider` column.
 */
import { requireAdmin } from "../../../../../lib/admin";
import { withDb } from "../../../../../lib/db";
import { getMetrics } from "../../../../../lib/metrics";
import { runReembed, type ReembedStats } from "../../../../../lib/reembed";
import { upsertVectors } from "../../../../../lib/vector";

function recordReembedMetrics(stats: ReembedStats) {
  const m = getMetrics();
  const dryRun = stats.dryRun ? "true" : "false";
  m.reembedRunTotal.inc({ result: stats.failed > 0 ? "partial" : "ok", dryRun });
  m.reembedRunDuration.observe({ dryRun }, stats.durationMs / 1000);
  if (stats.reembedded) m.reembedItemsTotal.inc({ result: "reembedded" }, stats.reembedded);
  if (stats.failed) m.reembedItemsTotal.inc({ result: "failed" }, stats.failed);
}

export const dynamic = "force-dynamic";

function clamp(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(min, Math.min(value, max));
}

function nonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

export async function POST(request: Request) {
  const unauthorized = requireAdmin(request);
  if (unauthorized) return unauthorized;

  const body = await request.json().catch(() => ({}));
  const targetProvider = nonEmptyString(body.targetProvider ?? body.target_provider);
  const batchSize = clamp(body.batchSize ?? body.batch_size, 1, 500);
  const dryRun = body.dryRun === true || body.dry_run === true;
  const limit = clamp(body.limit, 1, 100_000);

  let stats: ReembedStats;
  try {
    stats = await withDb((client) =>
      runReembed(
        client,
        { upsert: upsertVectors, recordStats: recordReembedMetrics },
        { targetProvider, batchSize, dryRun, limit },
      ),
    );
  } catch (err) {
    getMetrics().reembedRunTotal.inc({
      result: "error",
      dryRun: dryRun ? "true" : "false",
    });
    throw err;
  }

  return Response.json({ ok: true, stats });
}
