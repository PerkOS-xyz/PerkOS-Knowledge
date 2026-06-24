/**
 * Monthly $PERKOS usage drop — the CALCULATION (read-only, no on-chain, no writes).
 *
 * Budget   = the 5% reward accrued that month, per chain (reward_pool, pending).
 * Split    = rewardPlatformBps to the platform (default 40%), the rest to users.
 * User cut = split across every wallet by its TOTAL usage that month —
 *            activity(wallet) = USDC spent on paid queries + USDC earned from
 *            attributions (both sides of the market). Each wallet's share of the
 *            user budget is activity / Σ activity.
 *
 * This is the dry-run the admin inspects before any buyback runs: it shows what a
 * drop WOULD pay. The actual $PERKOS each wallet gets is decided when the buyback
 * swaps `userUsdc` → $PERKOS (price-dependent); here we report the USDC weighting.
 */
import type { Client } from "pg";

import { loadTokenomics } from "./tokenomics";

export type DropWallet = {
  wallet: string;
  spent: number;
  earned: number;
  activity: number;
  /** 0..1 — this wallet's fraction of the user drop pool. */
  sharePct: number;
  /** User-budget USDC weighting that converts to $PERKOS for this wallet. */
  usdcShare: number;
};

export type MonthlyDrop = {
  month: string; // YYYY-MM (UTC)
  chain: string;
  budgetUsdc: number;
  platformBps: number;
  platformUsdc: number;
  userUsdc: number;
  totalActivity: number;
  walletCount: number;
  wallets: DropWallet[];
};

/** [start, nextMonthStart) in UTC for a "YYYY-MM" string. */
function monthRange(month: string): { start: string; end: string } {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error("month must be YYYY-MM");
  const y = Number(m[1]);
  const mo = Number(m[2]);
  if (mo < 1 || mo > 12) throw new Error("month must be 01..12");
  return {
    start: new Date(Date.UTC(y, mo - 1, 1)).toISOString(),
    end: new Date(Date.UTC(y, mo, 1)).toISOString(),
  };
}

export async function computeMonthlyDrop(
  client: Client,
  opts: { month: string; chain: string },
): Promise<MonthlyDrop> {
  const { start, end } = monthRange(opts.month);
  const chain = opts.chain === "celo" ? "celo" : "base";
  const cfg = await loadTokenomics(client);

  // Budget: the 5% reward accrued this month on this chain, still pending payout.
  const b = await client.query(
    `SELECT coalesce(sum(amount),0)::float8 b FROM reward_pool
       WHERE chain = $1 AND status = 'pending' AND created_at >= $2 AND created_at < $3`,
    [chain, start, end],
  );
  const budgetUsdc = b.rows[0]?.b ?? 0;

  // Activity per wallet = spent (debits) + earned (attributions), this month/chain.
  const [spent, earned] = await Promise.all([
    client.query(
      `SELECT lower(wallet) w, coalesce(sum(amount),0)::float8 v FROM credit_ledger
         WHERE kind = 'debit' AND chain = $1 AND created_at >= $2 AND created_at < $3
         GROUP BY 1`,
      [chain, start, end],
    ),
    client.query(
      `SELECT lower(provider_wallet) w, coalesce(sum(amount),0)::float8 v FROM knowledge_attributions
         WHERE lower(chain) = $1 AND amount > 0 AND created_at >= $2 AND created_at < $3
         GROUP BY 1`,
      [chain, start, end],
    ),
  ]);

  const map = new Map<string, { spent: number; earned: number }>();
  for (const r of spent.rows) map.set(r.w, { spent: r.v, earned: 0 });
  for (const r of earned.rows) {
    const cur = map.get(r.w) ?? { spent: 0, earned: 0 };
    cur.earned += r.v;
    map.set(r.w, cur);
  }

  const platformBps = cfg.rewardPlatformBps;
  const platformUsdc = (budgetUsdc * platformBps) / 10000;
  const userUsdc = budgetUsdc - platformUsdc;

  const rows = [...map.entries()]
    .map(([wallet, x]) => ({ wallet, spent: x.spent, earned: x.earned, activity: x.spent + x.earned }))
    .filter((r) => r.activity > 0);
  const totalActivity = rows.reduce((a, r) => a + r.activity, 0);

  const wallets: DropWallet[] = rows
    .map((r) => {
      const sharePct = totalActivity > 0 ? r.activity / totalActivity : 0;
      return { ...r, sharePct, usdcShare: userUsdc * sharePct };
    })
    .sort((a, b) => b.activity - a.activity);

  return {
    month: opts.month,
    chain,
    budgetUsdc,
    platformBps,
    platformUsdc,
    userUsdc,
    totalActivity,
    walletCount: wallets.length,
    wallets,
  };
}
