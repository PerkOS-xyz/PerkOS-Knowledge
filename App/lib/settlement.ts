/**
 * F4 — provider settlement (payout). Converts a provider's accrued credit
 * balance into an on-chain USDC transfer from the PerkOS treasury, then debits
 * the paid-out credits and records the tx.
 *
 * Safety: the on-chain transfer only fires when a treasury private key is
 * configured (`KNOWLEDGE_TREASURY_PRIVATE_KEY`, a server secret). Without it,
 * a settlement is *recorded* (status `recorded`) and the balance is NOT debited
 * — the credits are still owed and an operator pays out manually. So this ships
 * safely with only the treasury ADDRESS set.
 */
import crypto from "crypto";
import type { Client } from "pg";

import { debit, getBalance } from "./credits";

function treasury() {
  return {
    address: (process.env.KNOWLEDGE_TREASURY_ADDRESS || "").trim(),
    privateKey: (process.env.KNOWLEDGE_TREASURY_PRIVATE_KEY || "").trim(),
    rpcUrl: (process.env.KNOWLEDGE_BASE_RPC_URL || "https://mainnet.base.org").trim(),
    usdc: (process.env.KNOWLEDGE_USDC_ADDRESS || "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913").trim(),
    chain: process.env.KNOWLEDGE_X402_CHAIN || "base",
    token: process.env.KNOWLEDGE_X402_TOKEN || "USDC",
    currency: process.env.KNOWLEDGE_X402_CURRENCY || "USDC",
    decimals: Number(process.env.KNOWLEDGE_USDC_DECIMALS || 6),
  };
}

/** Can we actually send on-chain right now (treasury key + address present)? */
export function canSettleOnChain(): boolean {
  const t = treasury();
  return Boolean(t.address && /^0x[0-9a-fA-F]{64}$/.test(t.privateKey));
}

/** Pure: how much to pay out — capped at the available balance. */
export function computePayout(requested: number | undefined, balance: number): number {
  const bal = Number(balance) || 0;
  if (bal <= 0) return 0;
  if (requested === undefined || requested === null) return bal;
  if (!(requested > 0)) return 0;
  return Math.min(requested, bal);
}

const ERC20_ABI = [
  {
    type: "function",
    name: "transfer",
    stateMutability: "nonpayable",
    inputs: [
      { name: "to", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
] as const;

/** On-chain USDC transfer treasury -> recipient. Returns the tx hash. */
async function transferUsdc(to: string, amount: number): Promise<string> {
  const t = treasury();
  const { createWalletClient, http, parseUnits } = await import("viem");
  const { privateKeyToAccount } = await import("viem/accounts");
  const { base } = await import("viem/chains");
  const account = privateKeyToAccount(t.privateKey as `0x${string}`);
  const client = createWalletClient({ account, chain: base, transport: http(t.rpcUrl) });
  const value = parseUnits(amount.toFixed(t.decimals), t.decimals);
  return client.writeContract({
    address: t.usdc as `0x${string}`,
    abi: ERC20_ABI,
    functionName: "transfer",
    args: [to as `0x${string}`, value],
  });
}

export type SettlementResult = {
  ok: boolean;
  status: string;
  settlementId: string;
  amount: number;
  txHash?: string;
  error?: string;
  balance?: number;
};

/**
 * Pay out a provider. Records the settlement, transfers USDC (if the treasury
 * key is set), debits the paid-out credits, and stamps the tx hash.
 */
export async function settleProvider(
  client: Client,
  input: { wallet: string; amount?: number; requestedBy?: string },
): Promise<SettlementResult> {
  const t = treasury();
  const balance = await getBalance(client, input.wallet);
  const payout = computePayout(input.amount, balance);
  const settlementId = `stl_${crypto.randomUUID()}`;
  if (payout <= 0) {
    return { ok: false, status: "nothing_to_settle", settlementId, amount: 0, balance };
  }

  await client.query(
    `INSERT INTO settlements (id, provider_wallet, amount, currency, chain, token, treasury, status, requested_by)
     VALUES ($1, lower($2), $3, $4, $5, $6, $7, 'pending', $8)`,
    [settlementId, input.wallet, payout, t.currency, t.chain, t.token, t.address || null, input.requestedBy ?? null],
  );

  if (!canSettleOnChain()) {
    // No treasury key -> record only; an operator executes the transfer. Don't
    // debit — the credits are still owed until actually paid.
    await client.query(`UPDATE settlements SET status='recorded' WHERE id=$1`, [settlementId]);
    return { ok: true, status: "recorded_pending_payout", settlementId, amount: payout, balance };
  }

  try {
    const txHash = await transferUsdc(input.wallet, payout);
    await debit(client, { wallet: input.wallet, agentId: null, amount: payout, reason: "settlement", requestId: settlementId });
    await client.query(`UPDATE settlements SET status='sent', tx_hash=$2, settled_at=now() WHERE id=$1`, [settlementId, txHash]);
    return { ok: true, status: "sent", settlementId, amount: payout, txHash };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    await client.query(`UPDATE settlements SET status='failed', error=$2 WHERE id=$1`, [settlementId, msg.slice(0, 300)]);
    return { ok: false, status: "failed", settlementId, amount: payout, error: msg.slice(0, 200), balance };
  }
}

export async function listSettlements(
  client: Client,
  wallet: string | null,
  limit = 50,
): Promise<Record<string, unknown>[]> {
  const res = wallet
    ? await client.query(
        `SELECT id, provider_wallet, amount::float8 amount, currency, status, tx_hash, created_at, settled_at
           FROM settlements WHERE lower(provider_wallet) = lower($1) ORDER BY created_at DESC LIMIT $2`,
        [wallet, limit],
      )
    : await client.query(
        `SELECT id, provider_wallet, amount::float8 amount, currency, status, tx_hash, created_at, settled_at
           FROM settlements ORDER BY created_at DESC LIMIT $1`,
        [limit],
      );
  return res.rows;
}
