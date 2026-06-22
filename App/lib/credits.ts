/**
 * Credit / billing layer — the prepaid-balance money model for the two-sided
 * knowledge market.
 *
 * - A balance lives at the OWNER wallet (agent_accounts). Consumers debit it
 *   per query; providers are credited when their items are consumed.
 * - The whitelist is `agent_billing.exempt` (+ a platform-wide env list):
 *   exempt agents query for free — for PerkOS internal / research agents.
 * - Every movement is journaled in credit_ledger (audit trail behind balances).
 *
 * Charging is gated by KNOWLEDGE_X402_MODE=credit + a non-zero price; default
 * metered_free leaves all of this inert (amount 0 → no balance change), so the
 * machinery ships safely and "turns on" the moment prices are set.
 */
import type { Client } from "pg";

/** Platform-wide exempt wallets (e.g. the PerkOS platform wallet). Env list. */
export function exemptWallets(): Set<string> {
  return new Set(
    (process.env.KNOWLEDGE_EXEMPT_WALLETS || "")
      .split(",")
      .map((w) => w.trim().toLowerCase())
      .filter(Boolean),
  );
}

/** True if this caller queries for free — whitelisted agent, or platform-exempt wallet. */
export async function isExempt(
  client: Client,
  agentId: string | null,
  wallet: string | null,
): Promise<boolean> {
  const w = (wallet || "").toLowerCase();
  if (w && exemptWallets().has(w)) return true;
  if (!agentId) return false;
  const r = await client.query(
    `SELECT exempt FROM agent_billing WHERE agent_id = $1`,
    [agentId],
  );
  return r.rows[0]?.exempt === true;
}

/** Balance lives PER (wallet, chain) — a consumer who deposits on Celo has Celo
 *  credits; spending them earns providers on Celo. chain defaults to 'base'. */
export async function getBalance(client: Client, wallet: string, chain = "base"): Promise<number> {
  const r = await client.query(
    `SELECT balance::float8 AS balance FROM agent_accounts WHERE lower(wallet) = lower($1) AND chain = $2`,
    [wallet, chain],
  );
  return r.rows[0]?.balance ?? 0;
}

async function ensureAccount(client: Client, wallet: string, chain: string): Promise<void> {
  await client.query(
    `INSERT INTO agent_accounts (wallet, chain) VALUES (lower($1), $2) ON CONFLICT (wallet, chain) DO NOTHING`,
    [wallet, chain],
  );
}

export type DebitResult =
  | { ok: true; balanceAfter: number }
  | { ok: false; reason: "insufficient"; balance: number };

/**
 * Atomically debit a (wallet, chain) balance. Overdraft-safe: the UPDATE only
 * matches when balance >= amount, so a concurrent double-spend can't drive it
 * negative. amount<=0 is a no-op success.
 */
export async function debit(
  client: Client,
  input: {
    wallet: string;
    agentId: string | null;
    amount: number;
    reason: string;
    requestId?: string | null;
    chain?: string;
  },
): Promise<DebitResult> {
  const chain = input.chain ?? "base";
  if (!(input.amount > 0)) {
    return { ok: true, balanceAfter: await getBalance(client, input.wallet, chain) };
  }
  await ensureAccount(client, input.wallet, chain);
  const upd = await client.query(
    `UPDATE agent_accounts
        SET balance = balance - $3, total_spent = total_spent + $3, updated_at = now()
      WHERE lower(wallet) = lower($1) AND chain = $2 AND balance >= $3
      RETURNING balance::float8 AS balance`,
    [input.wallet, chain, input.amount],
  );
  if (!upd.rowCount) {
    return { ok: false, reason: "insufficient", balance: await getBalance(client, input.wallet, chain) };
  }
  const balanceAfter = upd.rows[0].balance as number;
  await client.query(
    `INSERT INTO credit_ledger (wallet, chain, agent_id, kind, amount, reason, request_id, balance_after)
     VALUES (lower($1), $2, $3, 'debit', $4, $5, $6, $7)`,
    [input.wallet, chain, input.agentId ?? null, input.amount, input.reason, input.requestId ?? null, balanceAfter],
  );
  return { ok: true, balanceAfter };
}

/** Credit a (wallet, chain) balance (provider earnings, deposit, or admin grant). */
export async function credit(
  client: Client,
  input: {
    wallet: string;
    agentId?: string | null;
    amount: number;
    reason: string;
    requestId?: string | null;
    x402ReceiptId?: string | null;
    earned?: boolean;
    deposited?: boolean;
    chain?: string;
  },
): Promise<number> {
  const chain = input.chain ?? "base";
  if (!(input.amount > 0)) return getBalance(client, input.wallet, chain);
  await ensureAccount(client, input.wallet, chain);
  const extra =
    (input.earned ? ", total_earned = total_earned + $3" : "") +
    (input.deposited ? ", total_deposited = total_deposited + $3" : "");
  const upd = await client.query(
    `UPDATE agent_accounts
        SET balance = balance + $3${extra}, updated_at = now()
      WHERE lower(wallet) = lower($1) AND chain = $2
      RETURNING balance::float8 AS balance`,
    [input.wallet, chain, input.amount],
  );
  const balanceAfter = upd.rows[0].balance as number;
  await client.query(
    `INSERT INTO credit_ledger (wallet, chain, agent_id, kind, amount, reason, request_id, x402_receipt_id, balance_after)
     VALUES (lower($1), $2, $3, 'credit', $4, $5, $6, $7, $8)`,
    [
      input.wallet,
      chain,
      input.agentId ?? null,
      input.amount,
      input.reason,
      input.requestId ?? null,
      input.x402ReceiptId ?? null,
      balanceAfter,
    ],
  );
  return balanceAfter;
}

/** Upsert a per-agent billing/whitelist row. */
export async function setBilling(
  client: Client,
  input: {
    agentId: string;
    wallet?: string | null;
    exempt?: boolean;
    role?: string;
    note?: string | null;
    updatedBy?: string | null;
  },
): Promise<void> {
  const role = ["consumer", "provider", "both"].includes(String(input.role))
    ? String(input.role)
    : "consumer";
  await client.query(
    `INSERT INTO agent_billing (agent_id, wallet, exempt, role, note, updated_by, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6, now())
     ON CONFLICT (agent_id) DO UPDATE SET
       wallet = COALESCE(EXCLUDED.wallet, agent_billing.wallet),
       exempt = EXCLUDED.exempt,
       role = EXCLUDED.role,
       note = COALESCE(EXCLUDED.note, agent_billing.note),
       updated_by = EXCLUDED.updated_by,
       updated_at = now()`,
    [input.agentId, input.wallet ?? null, input.exempt === true, role, input.note ?? null, input.updatedBy ?? null],
  );
}

export type AccountSummary = {
  wallet: string;
  balance: number;
  currency: string;
  totalEarned: number;
  totalSpent: number;
  totalDeposited: number;
  byChain: Array<{ chain: string; balance: number; totalEarned: number; totalSpent: number; totalDeposited: number }>;
  earningsByAgent: Array<{ agentId: string | null; amount: number; count: number }>;
  spendByAgent: Array<{ agentId: string | null; amount: number; count: number }>;
  recent: Array<{
    kind: string;
    amount: number;
    reason: string;
    agentId: string | null;
    balanceAfter: number | null;
    createdAt: string | null;
  }>;
};

/** Full money view for a wallet — balance + per-agent earnings/spend + ledger. */
export async function getAccountSummary(
  client: Client,
  wallet: string,
  limit = 25,
): Promise<AccountSummary> {
  const w = wallet.toLowerCase();
  const [acct, byChain, earned, spent, recent] = await Promise.all([
    client.query(
      `SELECT coalesce(sum(balance),0)::float8 b, max(currency) currency, coalesce(sum(total_earned),0)::float8 te,
              coalesce(sum(total_spent),0)::float8 ts, coalesce(sum(total_deposited),0)::float8 td
         FROM agent_accounts WHERE lower(wallet) = $1`,
      [w],
    ),
    client.query(
      `SELECT chain, balance::float8 b, total_earned::float8 te, total_spent::float8 ts, total_deposited::float8 td
         FROM agent_accounts WHERE lower(wallet) = $1 ORDER BY chain`,
      [w],
    ),
    client.query(
      `SELECT provider_agent_id AS agent_id, coalesce(sum(amount),0)::float8 AS amount, count(*)::int AS count
         FROM knowledge_attributions WHERE lower(provider_wallet) = $1 GROUP BY 1 ORDER BY amount DESC`,
      [w],
    ),
    client.query(
      `SELECT agent_id, coalesce(sum(amount),0)::float8 AS amount, count(*)::int AS count
         FROM credit_ledger WHERE lower(wallet) = $1 AND kind = 'debit' GROUP BY 1 ORDER BY amount DESC`,
      [w],
    ),
    client.query(
      `SELECT kind, amount::float8 amount, reason, agent_id, balance_after::float8 balance_after, created_at
         FROM credit_ledger WHERE lower(wallet) = $1 ORDER BY created_at DESC LIMIT $2`,
      [w, limit],
    ),
  ]);
  const a = acct.rows[0];
  return {
    wallet: w,
    balance: a?.b ?? 0,
    currency: a?.currency ?? "USDC",
    totalEarned: a?.te ?? 0,
    totalSpent: a?.ts ?? 0,
    totalDeposited: a?.td ?? 0,
    byChain: byChain.rows.map((r) => ({ chain: r.chain, balance: r.b, totalEarned: r.te, totalSpent: r.ts, totalDeposited: r.td })),
    earningsByAgent: earned.rows.map((r) => ({ agentId: r.agent_id ?? null, amount: r.amount, count: r.count })),
    spendByAgent: spent.rows.map((r) => ({ agentId: r.agent_id ?? null, amount: r.amount, count: r.count })),
    recent: recent.rows.map((r) => ({
      kind: r.kind,
      amount: r.amount,
      reason: r.reason,
      agentId: r.agent_id ?? null,
      balanceAfter: r.balance_after ?? null,
      createdAt: r.created_at ?? null,
    })),
  };
}
