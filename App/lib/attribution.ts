/**
 * Provider attribution + earnings ledger — the supply side of the two-sided
 * knowledge market.
 *
 * When a consumer query consumes items, the amount it paid (x402) is split
 * equally across the consumed items and credited to each item's CONTRIBUTOR
 * in `knowledge_attributions`. One row per consumed item that has a known
 * contributor (platform-seeded items with no contributor are simply not
 * credited).
 *
 * We record even when the amount is 0 (the current `metered_free` x402 mode),
 * so providers get a usage-attribution trail today that becomes real accrued
 * earnings the instant x402 prices are enabled — no backfill needed. Actual
 * on-chain payout (settlement) reads the unsettled rows and is a separate job;
 * the `settled`/`settled_at` columns are the hook for it.
 */
import type { Client } from "pg";

import type { AccessContext } from "./access";

/**
 * Equal split of a payment across N consumed items. Pure + deterministic.
 * Returns the per-item share; 0 for a non-positive amount or empty set. Full
 * numeric precision is kept (the column is numeric) — rounding happens at
 * payout time, not here, so shares always sum back to the original amount.
 */
export function splitAmount(amount: number, count: number): number {
  if (!Number.isFinite(amount) || amount <= 0 || count <= 0) return 0;
  return amount / count;
}

export type AttributionInput = {
  requestId: string;
  endpoint: string;
  /** The consumer (who ran the query / paid). */
  access: AccessContext;
  retrievedItemIds: string[];
  amountPaid: number;
  chain: string | null;
  token: string | null;
  x402ReceiptId: string | null;
};

const ATTRIBUTION_COLS =
  "(request_id, research_item_id, provider_agent_id, provider_wallet, organization_id, " +
  "consumer_agent_id, consumer_wallet, endpoint, amount, chain, token, x402_receipt_id)";

/**
 * Credit the contributors of the consumed items for one query. The amount is
 * split equally across ALL consumed ids, but only items with a contributor
 * (agent or wallet) get a ledger row. Returns the number of rows written.
 *
 * Best-effort by contract — the caller wraps this so an attribution failure
 * never breaks serving the query. Idempotent per query: each query has a
 * unique requestId, so a retry can't double-credit the same consumption.
 */
export async function recordAttributions(
  client: Client,
  input: AttributionInput,
): Promise<number> {
  const ids = input.retrievedItemIds.filter(Boolean);
  if (!ids.length) return 0;
  const share = splitAmount(input.amountPaid, ids.length);

  const res = await client.query(
    `SELECT id, contributor_agent_id, contributor_wallet, organization_id
       FROM research_items WHERE id = ANY($1::text[])`,
    [ids],
  );
  const credited = res.rows.filter(
    (r) => r.contributor_agent_id || r.contributor_wallet,
  );
  if (!credited.length) return 0;

  const values: unknown[] = [];
  const tuples: string[] = [];
  let p = 0;
  for (const r of credited) {
    const ph = Array.from({ length: 12 }, () => `$${++p}`).join(",");
    tuples.push(`(${ph})`);
    values.push(
      input.requestId,
      r.id,
      r.contributor_agent_id ?? null,
      r.contributor_wallet ?? null,
      r.organization_id ?? null,
      input.access.agentId ?? null,
      input.access.wallet ?? null,
      input.endpoint,
      share,
      input.chain ?? null,
      input.token ?? null,
      input.x402ReceiptId ?? null,
    );
  }

  await client.query(
    `INSERT INTO knowledge_attributions ${ATTRIBUTION_COLS} VALUES ${tuples.join(",")}`,
    values,
  );
  return credited.length;
}

export type ProviderEarnings = {
  wallet: string;
  totalAmount: number;
  pendingAmount: number;
  settledAmount: number;
  attributionCount: number;
  byToken: Array<{ token: string | null; chain: string | null; amount: number; count: number }>;
  recent: Array<{
    researchItemId: string | null;
    amount: number;
    token: string | null;
    chain: string | null;
    endpoint: string;
    settled: boolean;
    createdAt: string | null;
  }>;
};

/**
 * Accrued earnings for a provider wallet — totals + pending (unsettled) +
 * a breakdown by token/chain + the most recent attributions.
 */
export async function getProviderEarningsByWallet(
  client: Client,
  wallet: string,
  limit = 25,
): Promise<ProviderEarnings> {
  const w = wallet.toLowerCase();
  const [summary, byToken, recent] = await Promise.all([
    client.query(
      `SELECT coalesce(sum(amount), 0)::float8 AS total,
              coalesce(sum(amount) FILTER (WHERE NOT settled), 0)::float8 AS pending,
              coalesce(sum(amount) FILTER (WHERE settled), 0)::float8 AS settled,
              count(*)::int AS n
         FROM knowledge_attributions WHERE lower(provider_wallet) = $1`,
      [w],
    ),
    client.query(
      `SELECT token, chain, coalesce(sum(amount), 0)::float8 AS amount, count(*)::int AS count
         FROM knowledge_attributions WHERE lower(provider_wallet) = $1
        GROUP BY token, chain ORDER BY amount DESC`,
      [w],
    ),
    client.query(
      `SELECT research_item_id, amount::float8 AS amount, token, chain, endpoint, settled, created_at
         FROM knowledge_attributions WHERE lower(provider_wallet) = $1
        ORDER BY created_at DESC LIMIT $2`,
      [w, limit],
    ),
  ]);

  const s = summary.rows[0];
  return {
    wallet: w,
    totalAmount: s.total,
    pendingAmount: s.pending,
    settledAmount: s.settled,
    attributionCount: s.n,
    byToken: byToken.rows.map((r) => ({
      token: r.token ?? null,
      chain: r.chain ?? null,
      amount: r.amount,
      count: r.count,
    })),
    recent: recent.rows.map((r) => ({
      researchItemId: r.research_item_id ?? null,
      amount: r.amount,
      token: r.token ?? null,
      chain: r.chain ?? null,
      endpoint: r.endpoint,
      settled: r.settled,
      createdAt: r.created_at ?? null,
    })),
  };
}
