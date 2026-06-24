/**
 * GET /api/admin/rewards/drop?month=YYYY-MM&chain=base|celo — DRY-RUN of the
 * monthly $PERKOS usage drop. Read-only: shows the budget (5% accrued that
 * month), the platform/user split, and each wallet's usage-weighted share. No
 * trade, no writes — what a buyback WOULD pay. Admin-gated.
 *
 * `month` defaults to the current UTC month; `chain` defaults to base.
 */
import { requireAdmin } from "../../../../../lib/admin";
import { withDb } from "../../../../../lib/db";
import { computeMonthlyDrop } from "../../../../../lib/rewardsDrop";

export const dynamic = "force-dynamic";

function currentMonthUtc(): string {
  const now = new Date();
  const y = now.getUTCFullYear();
  const m = String(now.getUTCMonth() + 1).padStart(2, "0");
  return `${y}-${m}`;
}

export async function GET(request: Request) {
  const unauthorized = requireAdmin(request);
  if (unauthorized) return unauthorized;

  const url = new URL(request.url);
  const month = url.searchParams.get("month")?.trim() || currentMonthUtc();
  const chain = url.searchParams.get("chain")?.trim() || "base";

  try {
    const drop = await withDb((c) => computeMonthlyDrop(c, { month, chain }));
    return Response.json({ ok: true, dryRun: true, drop, ts: new Date().toISOString() });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : "compute_failed" },
      { status: 400 },
    );
  }
}
