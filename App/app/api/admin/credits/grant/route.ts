/**
 * Admin: grant credits to a wallet (top-up / deposit / research stipend).
 *
 *   POST /api/admin/credits/grant   body: { wallet, amount, reason?, agentId? }
 *
 * Used to seed balances, settle off-chain deposits, or pay research agents a
 * credit stipend. The on-chain deposit flow (verify an x402 receipt -> credit)
 * lands later; this is the trusted admin path. Admin-token gated.
 */
import { requireAdmin } from "../../../../../lib/admin";
import { credit } from "../../../../../lib/credits";
import { withDb } from "../../../../../lib/db";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const unauthorized = requireAdmin(request);
  if (unauthorized) return unauthorized;

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const wallet = typeof body.wallet === "string" ? body.wallet.trim() : "";
  const amount = Number(body.amount);
  if (!wallet) {
    return Response.json({ ok: false, error: "wallet_required" }, { status: 400 });
  }
  if (!Number.isFinite(amount) || amount <= 0) {
    return Response.json({ ok: false, error: "amount_must_be_positive" }, { status: 400 });
  }
  const reason = typeof body.reason === "string" && body.reason.trim() ? body.reason.trim() : "grant";
  const agentId = typeof body.agentId === "string" ? body.agentId : null;
  const deposited = reason === "deposit" || body.deposited === true;

  const balance = await withDb((client) =>
    credit(client, { wallet, agentId, amount, reason, deposited }),
  );

  return Response.json({ ok: true, wallet: wallet.toLowerCase(), granted: amount, reason, balance });
}
