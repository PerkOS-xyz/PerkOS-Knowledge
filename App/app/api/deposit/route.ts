/**
 * POST /api/deposit — on-chain USDC top-up of a prepaid balance, via x402.
 *
 * x402 flow:
 *  1. No `X-PAYMENT` header → HTTP 402 with `accepts` = payment requirements for
 *     the chosen network (or both Base + Celo). The payer's x402 client signs a
 *     gasless USDC authorization and retries.
 *  2. `X-PAYMENT` header present → we settle it through PerkOS Stack
 *     (stack.perkos.xyz facilitator) on the payment's network, then credit the
 *     VERIFIED on-chain payer's balance by the deposit amount.
 *
 * Networks: Base + Celo mainnet (USDC). Replay-safe: re-submitting a settled
 * authorization fails on-chain (EIP-3009 nonce) and we also de-dup by tx hash.
 */
import { credit } from "../../../lib/credits";
import { withDb } from "../../../lib/db";
import {
  buildPaymentRequirements,
  decodePaymentHeader,
  isPayNetwork,
  networkKeyFor,
  settleViaStack,
  treasuryPayTo,
  type PayNetwork,
} from "../../../lib/payments";

export const dynamic = "force-dynamic";

const RESOURCE = "https://knowledge.perkos.xyz/api/deposit";
const ALL_NETS: PayNetwork[] = ["base", "celo"];

export async function POST(request: Request) {
  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const wallet = String(body.wallet || "").trim();
  const amount = Number(body.amount);

  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    return Response.json({ ok: false, error: "bad_wallet" }, { status: 400 });
  }
  if (!(amount > 0)) {
    return Response.json({ ok: false, error: "amount_must_be_positive" }, { status: 400 });
  }
  if (!treasuryPayTo()) {
    return Response.json({ ok: false, error: "treasury_not_configured" }, { status: 500 });
  }

  const payload = decodePaymentHeader(
    request.headers.get("x-payment") || request.headers.get("x-payment-payload"),
  );

  // Step 1 — no payment yet: return the 402 challenge with payment requirements.
  if (!payload) {
    const nets = isPayNetwork(body.network) ? [body.network] : ALL_NETS;
    return Response.json(
      {
        ok: false,
        x402Version: 1,
        error: "payment_required",
        accepts: nets.map((n) => buildPaymentRequirements(n, amount, RESOURCE)),
      },
      { status: 402 },
    );
  }

  // Step 2 — settle the payment on its network, then credit the payer.
  const net =
    networkKeyFor((payload as Record<string, unknown>).network) ??
    (isPayNetwork(body.network) ? body.network : "base");
  const requirements = buildPaymentRequirements(net, amount, RESOURCE);
  const settle = await settleViaStack(payload, requirements);
  if (!settle.ok) {
    return Response.json({ ok: false, error: "settlement_failed", reason: settle.error }, { status: 402 });
  }

  // Who gets the credit: an explicit `creditTo` (fund someone else — e.g. your
  // agent's wallet, your money your choice), else the verified on-chain payer,
  // else the body wallet. Supports both the shared-owner-wallet (A) and the
  // per-agent-wallet (B) models, plus human→agent top-ups.
  const creditTo = typeof body.creditTo === "string" ? body.creditTo.trim() : "";
  const payee = /^0x[0-9a-fA-F]{40}$/.test(creditTo)
    ? creditTo
    : settle.payer && /^0x[0-9a-fA-F]{40}$/.test(settle.payer)
      ? settle.payer
      : wallet;

  const result = await withDb(async (c) => {
    // De-dup: a settled tx credits at most once.
    if (settle.transaction) {
      const dup = await c.query(`SELECT 1 FROM credit_ledger WHERE x402_receipt_id = $1 LIMIT 1`, [
        settle.transaction,
      ]);
      if (dup.rowCount) {
        const r = await c.query(`SELECT balance::float8 b FROM agent_accounts WHERE lower(wallet)=lower($1) AND chain=$2`, [payee, net]);
        return { balance: r.rows[0]?.b ?? 0, deduped: true };
      }
    }
    // Credit the deposit ON THE CHAIN it was paid — that's the chain those
    // credits will earn providers on when spent.
    const balance = await credit(c, {
      wallet: payee,
      amount,
      reason: "deposit",
      deposited: true,
      x402ReceiptId: settle.transaction,
      chain: net,
    });
    return { balance, deduped: false };
  });

  return Response.json({
    ok: true,
    credited: result.deduped ? 0 : amount,
    balance: result.balance,
    network: net,
    payer: payee,
    transaction: settle.transaction,
  });
}
