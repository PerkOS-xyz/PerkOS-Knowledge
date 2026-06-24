/**
 * Tokenomics — the admin-editable economics of the two-sided knowledge market.
 *
 * One config row (`tokenomics_config` id='default') holds the tunable knobs:
 * the per-tier prices, the fee waterfall (how each paid query splits into
 * provider payout / platform take / $PERKOS reward), the reward split between
 * the researcher and the requester, and the buyback flag. Anything unset in the
 * row falls back to the decided defaults below, so the table can stay empty and
 * still run the agreed model — and the admin UI tunes it without a redeploy.
 *
 * Per paid query of price P:
 *   provider payout  = P * feeProviderBps   (split across the items that answered)
 *   platform revenue = P * feePlatformBps   (PerkOS keeps — recorded in platform_revenue)
 *   reward pool      = P * feeRewardBps      (accrued in reward_pool; later a batched
 *                                             $PERKOS buyback distributes it to the
 *                                             researcher + requester)
 * bps = basis points (10000 = 100%); the three fee shares must sum to 10000.
 */
import type { Client } from "pg";

import type { X402Tier } from "./x402";

export type TokenomicsConfig = {
  mode: "metered_free" | "enforce" | "credit";
  /** Per-tier price (USDC), as a number. */
  prices: Record<X402Tier, number>;
  /** Fee waterfall in basis points; sums to 10000. */
  feeProviderBps: number;
  feePlatformBps: number;
  feeRewardBps: number;
  /** Researcher's share of the reward pool (bps); requester gets the rest. */
  rewardResearcherBps: number;
  /** Platform's share of the BOUGHT $PERKOS (bps); the rest drops to users.
   *  Applied at buyback/distribution time, not at accrual. Default 4000 = 40%. */
  rewardPlatformBps: number;
  buybackEnabled: boolean;
  /** Min accrued reward pool (USDC) before a buyback epoch fires. */
  buybackThreshold: number;
  updatedBy: string | null;
  updatedAt: string | null;
};

function envMode(): TokenomicsConfig["mode"] {
  const m = (process.env.KNOWLEDGE_X402_MODE || "").trim();
  return m === "enforce" ? "enforce" : m === "credit" ? "credit" : "metered_free";
}

/**
 * Decided defaults (2026-06-22): public $0 / private $0.01 / premium $0.02 /
 * enterprise(validated) $0.10; waterfall 75% provider / 20% platform / 5%
 * reward; reward split 60% researcher / 40% requester; buyback off.
 */
export function defaultTokenomics(): TokenomicsConfig {
  return {
    mode: envMode(),
    prices: { public: 0, private: 0.01, premium: 0.02, enterprise: 0.1 },
    feeProviderBps: 7500,
    feePlatformBps: 2000,
    feeRewardBps: 500,
    rewardResearcherBps: 6000,
    rewardPlatformBps: 4000,
    buybackEnabled: false,
    buybackThreshold: 100,
    updatedBy: null,
    updatedAt: null,
  };
}

/** Load the live config: the DB row's non-null columns merged over defaults. */
export async function loadTokenomics(client: Client): Promise<TokenomicsConfig> {
  const d = defaultTokenomics();
  const r = await client.query(
    `SELECT mode, price_public, price_private, price_premium, price_enterprise,
            fee_provider_bps, fee_platform_bps, fee_reward_bps, reward_researcher_bps,
            reward_platform_bps, buyback_enabled, buyback_threshold, updated_by, updated_at
       FROM tokenomics_config WHERE id = 'default'`,
  );
  const row = r.rows[0];
  if (!row) return d;
  const num = (v: unknown, fb: number) =>
    v === null || v === undefined ? fb : Number(v);
  return {
    mode: (row.mode as TokenomicsConfig["mode"]) ?? d.mode,
    prices: {
      public: num(row.price_public, d.prices.public),
      private: num(row.price_private, d.prices.private),
      premium: num(row.price_premium, d.prices.premium),
      enterprise: num(row.price_enterprise, d.prices.enterprise),
    },
    feeProviderBps: num(row.fee_provider_bps, d.feeProviderBps),
    feePlatformBps: num(row.fee_platform_bps, d.feePlatformBps),
    feeRewardBps: num(row.fee_reward_bps, d.feeRewardBps),
    rewardResearcherBps: num(row.reward_researcher_bps, d.rewardResearcherBps),
    rewardPlatformBps: num(row.reward_platform_bps, d.rewardPlatformBps),
    buybackEnabled: row.buyback_enabled ?? d.buybackEnabled,
    buybackThreshold: num(row.buyback_threshold, d.buybackThreshold),
    updatedBy: row.updated_by ?? null,
    updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

export type TokenomicsPatch = Partial<{
  mode: string;
  prices: Partial<Record<string, number>>;
  feeProviderBps: number;
  feePlatformBps: number;
  feeRewardBps: number;
  rewardResearcherBps: number;
  rewardPlatformBps: number;
  buybackEnabled: boolean;
  buybackThreshold: number;
}>;

/** Validate a fee waterfall: each share 0..10000 and the three sum to 10000. */
export function validateFees(provider: number, platform: number, reward: number): string | null {
  for (const [k, v] of [
    ["provider", provider],
    ["platform", platform],
    ["reward", reward],
  ] as const) {
    if (!Number.isInteger(v) || v < 0 || v > 10000) return `${k} bps must be an integer 0..10000`;
  }
  if (provider + platform + reward !== 10000) return "provider + platform + reward bps must sum to 10000";
  return null;
}

/** Upsert the config row. Caller validates fees first (see validateFees). */
export async function saveTokenomics(
  client: Client,
  patch: TokenomicsPatch,
  updatedBy: string | null,
): Promise<void> {
  const cur = await loadTokenomics(client);
  const merged = {
    mode: (patch.mode as TokenomicsConfig["mode"]) ?? cur.mode,
    prices: { ...cur.prices, ...(patch.prices ?? {}) },
    feeProviderBps: patch.feeProviderBps ?? cur.feeProviderBps,
    feePlatformBps: patch.feePlatformBps ?? cur.feePlatformBps,
    feeRewardBps: patch.feeRewardBps ?? cur.feeRewardBps,
    rewardResearcherBps: patch.rewardResearcherBps ?? cur.rewardResearcherBps,
    rewardPlatformBps: patch.rewardPlatformBps ?? cur.rewardPlatformBps,
    buybackEnabled: patch.buybackEnabled ?? cur.buybackEnabled,
    buybackThreshold: patch.buybackThreshold ?? cur.buybackThreshold,
  };
  await client.query(
    `INSERT INTO tokenomics_config
       (id, mode, price_public, price_private, price_premium, price_enterprise,
        fee_provider_bps, fee_platform_bps, fee_reward_bps, reward_researcher_bps,
        reward_platform_bps, buyback_enabled, buyback_threshold, updated_by, updated_at)
     VALUES ('default',$1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now())
     ON CONFLICT (id) DO UPDATE SET
       mode=$1, price_public=$2, price_private=$3, price_premium=$4, price_enterprise=$5,
       fee_provider_bps=$6, fee_platform_bps=$7, fee_reward_bps=$8, reward_researcher_bps=$9,
       reward_platform_bps=$10, buyback_enabled=$11, buyback_threshold=$12, updated_by=$13, updated_at=now()`,
    [
      merged.mode,
      merged.prices.public,
      merged.prices.private,
      merged.prices.premium,
      merged.prices.enterprise,
      merged.feeProviderBps,
      merged.feePlatformBps,
      merged.feeRewardBps,
      merged.rewardResearcherBps,
      merged.rewardPlatformBps,
      merged.buybackEnabled,
      merged.buybackThreshold,
      updatedBy,
    ],
  );
}

export function priceForTier(cfg: TokenomicsConfig, tier: X402Tier): number {
  return cfg.prices[tier] ?? 0;
}

export type Waterfall = { provider: number; platform: number; reward: number };

/**
 * Pure split of a charged amount into provider / platform / reward. The
 * provider takes the remainder so the three always sum back to `amount` (no
 * rounding leak). amount<=0 → all zeros.
 */
export function feeWaterfall(amount: number, cfg: TokenomicsConfig): Waterfall {
  if (!(amount > 0)) return { provider: 0, platform: 0, reward: 0 };
  const platform = (amount * cfg.feePlatformBps) / 10000;
  const reward = (amount * cfg.feeRewardBps) / 10000;
  const provider = amount - platform - reward;
  return { provider, platform, reward };
}

/** Researcher / requester split of a reward amount (researcher takes remainder-safe). */
export function rewardSplit(
  reward: number,
  cfg: TokenomicsConfig,
): { researcher: number; requester: number } {
  if (!(reward > 0)) return { researcher: 0, requester: 0 };
  const requester = (reward * (10000 - cfg.rewardResearcherBps)) / 10000;
  return { researcher: reward - requester, requester };
}

/** Record the platform's recognized fee for a query (PerkOS revenue). */
export async function recordPlatformRevenue(
  client: Client,
  input: { requestId: string; tier: string; amount: number; currency: string },
): Promise<void> {
  if (!(input.amount > 0)) return;
  await client.query(
    `INSERT INTO platform_revenue (request_id, tier, amount, currency) VALUES ($1,$2,$3,$4)`,
    [input.requestId, input.tier, input.amount, input.currency],
  );
}

/** Accrue a query's reward budget into the pool for the next buyback epoch. */
export async function accrueReward(
  client: Client,
  input: {
    requestId: string;
    amount: number;
    currency: string;
    requesterWallet: string | null;
    researcherWallets: string[];
    researcherBps: number;
    /** Chain the query paid on — the reward buys that chain's $PERKOS. */
    chain?: string;
  },
): Promise<void> {
  if (!(input.amount > 0)) return;
  await client.query(
    `INSERT INTO reward_pool
       (request_id, chain, amount, currency, requester_wallet, researcher_wallets, researcher_bps, status)
     VALUES ($1,$2,$3,$4,$5,$6::jsonb,$7,'pending')`,
    [
      input.requestId,
      input.chain ?? "base",
      input.amount,
      input.currency,
      input.requesterWallet,
      JSON.stringify(input.researcherWallets),
      input.researcherBps,
    ],
  );
}

export type TokenomicsSummary = {
  platformRevenue: { total: number; byTier: Array<{ tier: string; amount: number; count: number }> };
  rewardPool: { pending: number; pendingCount: number; distributed: number };
  currency: string;
};

/** Totals for the admin view — how much PerkOS has earned + the reward backlog. */
export async function tokenomicsSummary(client: Client): Promise<TokenomicsSummary> {
  const [rev, revByTier, pool] = await Promise.all([
    client.query(`SELECT coalesce(sum(amount),0)::float8 t FROM platform_revenue`),
    client.query(
      `SELECT tier, coalesce(sum(amount),0)::float8 amount, count(*)::int count
         FROM platform_revenue GROUP BY tier ORDER BY amount DESC`,
    ),
    client.query(
      `SELECT
         coalesce(sum(amount) FILTER (WHERE status='pending'),0)::float8 pending,
         count(*) FILTER (WHERE status='pending')::int pending_count,
         coalesce(sum(amount) FILTER (WHERE status='distributed'),0)::float8 distributed
       FROM reward_pool`,
    ),
  ]);
  return {
    platformRevenue: {
      total: rev.rows[0]?.t ?? 0,
      byTier: revByTier.rows.map((r) => ({ tier: r.tier, amount: r.amount, count: r.count })),
    },
    rewardPool: {
      pending: pool.rows[0]?.pending ?? 0,
      pendingCount: pool.rows[0]?.pending_count ?? 0,
      distributed: pool.rows[0]?.distributed ?? 0,
    },
    currency: process.env.KNOWLEDGE_X402_CURRENCY || "USDC",
  };
}
