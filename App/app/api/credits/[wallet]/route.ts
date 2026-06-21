/**
 * GET /api/credits/:wallet — the money view for a wallet (dashboard data).
 *
 * Returns prepaid balance + totals + per-agent earnings (provider side) and
 * per-agent spend (consumer side) + recent ledger. Wallet-allowlist gated,
 * same as /api/usage and /api/earnings.
 */
import { isAllowedWallet } from "../../../../lib/auth";
import { getAccountSummary } from "../../../../lib/credits";
import { withDb } from "../../../../lib/db";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ wallet: string }> },
) {
  const { wallet } = await context.params;
  if (!isAllowedWallet(wallet)) {
    return Response.json({ ok: false, error: "wallet_not_allowed" }, { status: 403 });
  }

  const account = await withDb((client) => getAccountSummary(client, wallet));
  return Response.json({ ok: true, account, ts: new Date().toISOString() });
}
