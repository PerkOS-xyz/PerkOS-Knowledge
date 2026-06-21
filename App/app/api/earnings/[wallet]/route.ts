/**
 * GET /api/earnings/:wallet — accrued provider earnings (supply side).
 *
 * Returns what a provider wallet has earned from its contributed knowledge
 * being consumed: total + pending (unsettled) + breakdown by token/chain +
 * recent attributions. Wallet-allowlist gated, same as /api/usage. On-chain
 * payout (settlement) of `pending` is a separate job — see lib/attribution.ts.
 */
import { isAllowedWallet } from "../../../../lib/auth";
import { getProviderEarningsByWallet } from "../../../../lib/attribution";
import { withDb } from "../../../../lib/db";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ wallet: string }> },
) {
  const { wallet } = await context.params;
  if (!isAllowedWallet(wallet)) {
    return Response.json(
      { ok: false, error: "wallet_not_allowed" },
      { status: 403 },
    );
  }

  const earnings = await withDb((client) =>
    getProviderEarningsByWallet(client, wallet),
  );

  return Response.json({
    ok: true,
    wallet: earnings.wallet,
    earnings: {
      total: earnings.totalAmount,
      pendingSettlement: earnings.pendingAmount,
      settled: earnings.settledAmount,
      attributions: earnings.attributionCount,
      byToken: earnings.byToken,
      recent: earnings.recent,
    },
    note:
      "Amounts accrue per consumed item (equal split of each query's x402 amount). " +
      "While x402 runs in metered_free mode the amounts are 0 but attributions are still tracked; " +
      "they become earnings the moment prices are enabled. Payout of pendingSettlement is a separate job.",
    ts: new Date().toISOString(),
  });
}
