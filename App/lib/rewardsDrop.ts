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

export type DropDistribution = {
  month: string;
  chain: string;
  perkosBought: string;
  platformPerkos: string;
  userPerkos: string;
  allocated: string;
  walletCount: number;
  rewardRowsMarked: number;
};

/**
 * Distribute a completed buyback's $PERKOS for a month/chain — call AFTER the
 * swap lands `perkosBoughtBaseUnits` $PERKOS (18-dec) in the treasury. Keeps the
 * platform cut, credits each wallet's usage-weighted share into token_rewards
 * (which `rollupEntries` turns into a claimable `cumReward`), and marks that
 * month's pending reward_pool rows distributed. Integer math; the rounding
 * remainder stays with the platform (never over-allocate vs what was bought).
 *
 * Idempotent guard is the caller's job (mark/record the buyback tx first) — this
 * function is the accounting half only; it does no on-chain work.
 */
export async function distributeDrop(
  client: Client,
  opts: { month: string; chain: string; perkosBoughtBaseUnits: bigint },
): Promise<DropDistribution> {
  const { start, end } = monthRange(opts.month);
  const chain = opts.chain === "celo" ? "celo" : "base";
  const drop = await computeMonthlyDrop(client, { month: opts.month, chain });

  const platformBps = BigInt(drop.platformBps);
  const platformPerkos = (opts.perkosBoughtBaseUnits * platformBps) / 10000n;
  const userPerkos = opts.perkosBoughtBaseUnits - platformPerkos;

  // Integer pro-rata by activity. Scale floats to 1e6 fixed-point for the ratio.
  const totalScaled = BigInt(Math.round(drop.totalActivity * 1e6));
  let allocated = 0n;
  for (const w of drop.wallets) {
    if (totalScaled <= 0n) break;
    const share = (userPerkos * BigInt(Math.round(w.activity * 1e6))) / totalScaled;
    if (share <= 0n) continue;
    allocated += share;
    await client.query(
      `INSERT INTO token_rewards (wallet, chain, cumulative_perkos)
         VALUES (lower($1), $2, $3)
       ON CONFLICT (wallet, chain)
         DO UPDATE SET cumulative_perkos = token_rewards.cumulative_perkos + EXCLUDED.cumulative_perkos, updated_at = now()`,
      [w.wallet, chain, share.toString()],
    );
  }

  const marked = await client.query(
    `UPDATE reward_pool SET status = 'distributed', epoch = $1
       WHERE chain = $2 AND status = 'pending' AND created_at >= $3 AND created_at < $4`,
    [opts.month, chain, start, end],
  );

  return {
    month: opts.month,
    chain,
    perkosBought: opts.perkosBoughtBaseUnits.toString(),
    platformPerkos: platformPerkos.toString(),
    userPerkos: userPerkos.toString(),
    allocated: allocated.toString(),
    walletCount: drop.wallets.length,
    rewardRowsMarked: marked.rowCount ?? 0,
  };
}
