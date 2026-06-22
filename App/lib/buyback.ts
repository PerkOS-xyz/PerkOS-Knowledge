/**
 * $PERKOS buyback-and-distribute — SCAFFOLD, intentionally OFF.
 *
 * The reward pool (lib/tokenomics.accrueReward) collects the per-query reward
 * share in USDC. Once per epoch — when the pool clears the configured threshold
 * — this would market-buy $PERKOS on a Base DEX for the accrued USDC and
 * distribute the bought token pro-rata to the epoch's requesters + researchers
 * (per each row's `researcher_bps`), generating real buy pressure + on-chain
 * token transactions.
 *
 * It is gated three ways and ships as a no-op:
 *   1. `tokenomics.buybackEnabled` must be true (admin flag), AND
 *   2. a 32-byte `KNOWLEDGE_TREASURY_PRIVATE_KEY` must be set, AND
 *   3. the on-chain execution leg is deliberately not wired — buying your own
 *      token with user fees + distributing it as a reward needs a legal review
 *      first (securities / market-manipulation framing). See docs/TOKENOMICS.md.
 *
 * Until all three clear, the 5% simply accrues as a tracked liability; nothing
 * irreversible happens.
 */
import type { Client } from "pg";

import { loadTokenomics } from "./tokenomics";

export function buybackTreasuryKey(): string {
  return (process.env.KNOWLEDGE_TREASURY_PRIVATE_KEY || "").trim();
}

export type BuybackResult = { ran: boolean; reason: string; pending?: number };

/** Returns why the buyback is (still) disabled; never executes a trade yet. */
export async function runBuybackEpoch(client: Client): Promise<BuybackResult> {
  const cfg = await loadTokenomics(client);
  if (!cfg.buybackEnabled) return { ran: false, reason: "buyback_disabled" };
  if (!/^0x[0-9a-fA-F]{64}$/.test(buybackTreasuryKey()))
    return { ran: false, reason: "treasury_key_missing" };

  const r = await client.query(
    `SELECT coalesce(sum(amount),0)::float8 p FROM reward_pool WHERE status = 'pending'`,
  );
  const pending = r.rows[0]?.p ?? 0;
  if (pending < cfg.buybackThreshold) return { ran: false, reason: "below_threshold", pending };

  // GATED: market-buy $PERKOS for `pending` USDC on a Base DEX, then distribute
  // pro-rata to requesters + researchers (reward_pool.researcher_bps), mark rows
  // 'distributed', and record token_rewards. Needs viem + treasury key + a router
  // + slippage guard + legal sign-off before it's wired.
  return { ran: false, reason: "execution_not_enabled", pending };
}
