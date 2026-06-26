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
import type { PayNetwork } from "../../../../../lib/payments";
import { computeMonthlyDrop } from "../../../../../lib/rewardsDrop";
import { quoteBuyback } from "../../../../../lib/uniswapTrade";

export const dynamic = "force-dynamic";

const TREASURY = (process.env.KNOWLEDGE_TREASURY_ADDRESS || "0x3f0D7b9916212fA0A9Ac0EF8f72a25EB56F7046C").trim();

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

    // Quote the budget → $PERKOS via the Uniswap Trading API (read-only, no
    // trade), then apply the platform/user split + per-wallet shares so the
    // admin sees exactly what $PERKOS each side would get. Best-effort: needs
    // UNISWAP_API_KEY; surfaces an `error` instead of failing the whole view.
    let buyback: unknown = null;
    if (drop.budgetUsdc > 0) {
      const q = await quoteBuyback({ chain: drop.chain as PayNetwork, amountUsdc: drop.budgetUsdc, swapper: TREASURY });
      if (q.ok && q.amountOutPerkosFloat != null) {
        const perkosTotal = q.amountOutPerkosFloat;
        const platformPerkos = (perkosTotal * drop.platformBps) / 10000;
        const userPerkos = perkosTotal - platformPerkos;
        buyback = {
          perkosTotal,
          platformPerkos,
          userPerkos,
          perWallet: drop.wallets.map((w) => ({ wallet: w.wallet, sharePct: w.sharePct, perkos: userPerkos * w.sharePct })),
        };
      } else {
        buyback = { error: q.error ?? "quote_failed" };
      }
    }

    return Response.json({ ok: true, dryRun: true, drop, buyback, ts: new Date().toISOString() });
  } catch (e) {
    return Response.json(
      { ok: false, error: e instanceof Error ? e.message : "compute_failed" },
      { status: 400 },
    );
  }
}
