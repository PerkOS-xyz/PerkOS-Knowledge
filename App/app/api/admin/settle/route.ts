/**
 * Admin: settle (pay out) a provider's accrued credits.
 *
 *   GET  /api/admin/settle?wallet=0x..   → recent settlements (all if no wallet)
 *   POST /api/admin/settle               body: { wallet, amount? }
 *
 * POST pays out `amount` (or the full balance) from the treasury to the
 * provider on-chain in USDC, then debits the paid-out credits. Without a
 * treasury key it records the settlement as `recorded` (manual payout) and
 * leaves the balance untouched. Admin-token gated.
 */
import { requireAdmin } from "../../../../lib/admin";
import { canSettleOnChain, listSettlements, settleProvider } from "../../../../lib/settlement";
import { withDb } from "../../../../lib/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const unauthorized = requireAdmin(request);
  if (unauthorized) return unauthorized;

  const wallet = new URL(request.url).searchParams.get("wallet");
  const rows = await withDb((client) => listSettlements(client, wallet || null));
  return Response.json({ ok: true, onChain: canSettleOnChain(), count: rows.length, settlements: rows });
}

export async function POST(request: Request) {
  const unauthorized = requireAdmin(request);
  if (unauthorized) return unauthorized;

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const wallet = typeof body.wallet === "string" ? body.wallet.trim() : "";
  if (!wallet) {
    return Response.json({ ok: false, error: "wallet_required" }, { status: 400 });
  }
  const amount = body.amount === undefined ? undefined : Number(body.amount);
  if (amount !== undefined && (!Number.isFinite(amount) || amount <= 0)) {
    return Response.json({ ok: false, error: "amount_must_be_positive" }, { status: 400 });
  }
  const requestedBy = String(request.headers.get("x-admin-actor") || "admin");

  const result = await withDb((client) => settleProvider(client, { wallet, amount, requestedBy }));
  return Response.json({ ...result }, { status: result.ok ? 200 : 400 });
}
