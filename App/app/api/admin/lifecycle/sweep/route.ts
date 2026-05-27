/**
 * Admin-only endpoint that runs the knowledge-item lifecycle sweep.
 *
 * Designed to be triggered by an external cron (e.g. cronjob on the
 * VPS hosting knowledge.perkos.xyz) rather than a built-in scheduler,
 * so the Next.js server stays stateless.
 *
 * Example invocation (production):
 *
 *   curl -X POST \
 *     -H "Authorization: Bearer $KNOWLEDGE_ADMIN_TOKEN" \
 *     -H "content-type: application/json" \
 *     -d '{"dryRun": false}' \
 *     https://knowledge.perkos.xyz/api/admin/lifecycle/sweep
 *
 * Body fields (all optional):
 *   dryRun        boolean   — compute the plan, write nothing. Default false.
 *   retentionDays number    — override the hard-delete window. Default 90.
 *   batchSize     number    — candidate page size. Default 500.
 *
 * Always returns stats (scanned / archived / evicted / revived /
 * unchanged / hardDeleted / durationMs). Even a dry-run returns the
 * counts that WOULD have been applied — useful for sanity-checking
 * before flipping cron from `--dry-run` to live.
 */
import { requireAdmin } from "../../../../../lib/admin";
import { withDb } from "../../../../../lib/db";
import { runLifecycleSweep } from "../../../../../lib/lifecycleSweep";
import { deleteVectors } from "../../../../../lib/vector";

export const dynamic = "force-dynamic";

function clampNumber(value: unknown, min: number, max: number): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(min, Math.min(value, max));
}

export async function POST(request: Request) {
  const unauthorized = requireAdmin(request);
  if (unauthorized) return unauthorized;

  const body = await request.json().catch(() => ({}));
  const dryRun = body.dryRun === true || body.dry_run === true;
  const retentionDays = clampNumber(body.retentionDays ?? body.retention_days, 1, 3650);
  const batchSize = clampNumber(body.batchSize ?? body.batch_size, 10, 5000);
  // Optional: skip Qdrant cleanup entirely if the operator wants to
  // run a Postgres-only sweep (rare; mostly useful when Qdrant is
  // down and we don't want hardDeleted = 0 just because cleanup
  // would have errored).
  const skipVectorCleanup = body.skipVectorCleanup === true || body.skip_vector_cleanup === true;

  const stats = await withDb((client) =>
    runLifecycleSweep(
      client,
      { deleteVectors: skipVectorCleanup ? undefined : deleteVectors },
      { dryRun, retentionDays, batchSize },
    ),
  );

  return Response.json({ ok: true, stats });
}
