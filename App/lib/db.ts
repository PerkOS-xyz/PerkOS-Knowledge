import { Client } from 'pg';

export type QueryValue = string | number | boolean | null | string[];

function connection() {
  return {
    host: process.env.POSTGRES_HOST || 'localhost',
    port: Number(process.env.POSTGRES_PORT || 5432),
    database: process.env.POSTGRES_DB,
    user: process.env.POSTGRES_USER,
    password: process.env.POSTGRES_PASSWORD,
  };
}

export async function withDb<T>(fn: (client: Client) => Promise<T>) {
  const client = new Client(connection());
  await client.connect();
  try {
    await ensureSchema(client);
    return await fn(client);
  } finally {
    await client.end();
  }
}

export async function ensureSchema(client: Client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS organizations (
      id text PRIMARY KEY,
      name text NOT NULL,
      slug text UNIQUE,
      status text NOT NULL DEFAULT 'active',
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS agents (
      id text PRIMARY KEY,
      display_name text NOT NULL,
      agent_type text NOT NULL DEFAULT 'consumer',
      status text NOT NULL DEFAULT 'active',
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_identities (
      id bigserial PRIMARY KEY,
      agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      wallet text,
      erc8004_identity text,
      chain text,
      status text NOT NULL DEFAULT 'active',
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE(agent_id, wallet),
      UNIQUE(agent_id, erc8004_identity)
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS organization_agents (
      organization_id text NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
      agent_id text NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
      role text NOT NULL DEFAULT 'member',
      scopes text[] NOT NULL DEFAULT '{}',
      status text NOT NULL DEFAULT 'active',
      created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY (organization_id, agent_id)
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS research_items (
      id text PRIMARY KEY,
      source text NOT NULL,
      date text,
      track text,
      title text NOT NULL,
      path text NOT NULL,
      agents text[] NOT NULL DEFAULT '{}',
      chains text[] NOT NULL DEFAULT '{}',
      status text,
      confidence text,
      summary text,
      raw jsonb NOT NULL DEFAULT '{}'::jsonb,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await client.query(`ALTER TABLE research_items ADD COLUMN IF NOT EXISTS visibility text NOT NULL DEFAULT 'public'`);
  await client.query(`ALTER TABLE research_items ADD COLUMN IF NOT EXISTS organization_id text REFERENCES organizations(id) ON DELETE SET NULL`);
  await client.query(`ALTER TABLE research_items ADD COLUMN IF NOT EXISTS contributor_agent_id text REFERENCES agents(id) ON DELETE SET NULL`);
  await client.query(`ALTER TABLE research_items ADD COLUMN IF NOT EXISTS contributor_wallet text`);
  await client.query(`ALTER TABLE research_items ADD COLUMN IF NOT EXISTS contributor_erc8004_identity text`);
  await client.query(`ALTER TABLE research_items ADD COLUMN IF NOT EXISTS validation_status text NOT NULL DEFAULT 'unvalidated'`);
  await client.query(`ALTER TABLE research_items ADD COLUMN IF NOT EXISTS sanitization_status text NOT NULL DEFAULT 'unspecified'`);
  await client.query(`ALTER TABLE research_items ADD COLUMN IF NOT EXISTS quality_score numeric`);
  await client.query(`ALTER TABLE research_items ADD COLUMN IF NOT EXISTS usage_count integer NOT NULL DEFAULT 0`);
  await client.query(`ALTER TABLE research_items ADD COLUMN IF NOT EXISTS contribution_type text NOT NULL DEFAULT 'research'`);
  await client.query(`ALTER TABLE research_items ADD COLUMN IF NOT EXISTS publication_status text NOT NULL DEFAULT 'private'`);
  await client.query(`ALTER TABLE research_items ADD COLUMN IF NOT EXISTS content_hash text`);
  await client.query(`ALTER TABLE research_items ADD COLUMN IF NOT EXISTS evidence jsonb NOT NULL DEFAULT '[]'::jsonb`);
  await client.query(`ALTER TABLE research_items ADD COLUMN IF NOT EXISTS quality_reasons text[] NOT NULL DEFAULT '{}'`);
  await client.query(`ALTER TABLE research_items ADD COLUMN IF NOT EXISTS confidence_percent integer`);
  await client.query(`ALTER TABLE research_items ADD COLUMN IF NOT EXISTS trust_tier text NOT NULL DEFAULT 'untrusted'`);
  await client.query(`ALTER TABLE research_items ADD COLUMN IF NOT EXISTS submitted_at timestamptz`);
  await client.query(`ALTER TABLE research_items ADD COLUMN IF NOT EXISTS validated_at timestamptz`);
  // Originally the table only carried updated_at. The lifecycle sweep
  // (#28) judges age by createdAt, so we add a real created_at and
  // backfill legacy rows from updated_at as the historical proxy.
  // Three-step idempotent migration:
  //   1) add nullable column
  //   2) backfill rows where it's still NULL
  //   3) set default + NOT NULL for forward writes
  // Re-running this block is a no-op once all rows have a value.
  await client.query(`ALTER TABLE research_items ADD COLUMN IF NOT EXISTS created_at timestamptz`);
  await client.query(`UPDATE research_items SET created_at = COALESCE(updated_at, NOW()) WHERE created_at IS NULL`);
  await client.query(`ALTER TABLE research_items ALTER COLUMN created_at SET DEFAULT NOW()`);
  await client.query(`ALTER TABLE research_items ALTER COLUMN created_at SET NOT NULL`);
  // Lifecycle tier — existing rows default to "working" so a sweep
  // can re-evaluate them later without a one-time backfill. See
  // lib/lifecycle.ts for the decision rules.
  await client.query(`ALTER TABLE research_items ADD COLUMN IF NOT EXISTS lifecycle_tier text NOT NULL DEFAULT 'working'`);
  await client.query(`ALTER TABLE research_items ADD COLUMN IF NOT EXISTS lifecycle_evaluated_at timestamptz`);
  await client.query(`ALTER TABLE research_items ADD COLUMN IF NOT EXISTS last_used_at timestamptz`);
  // Set ONLY when the sweep transitions a row into the "evicted" tier.
  // The hard-delete sweep uses this as the cutoff anchor — see
  // lib/lifecycleSweep.ts and DATA-RETENTION.md.
  await client.query(`ALTER TABLE research_items ADD COLUMN IF NOT EXISTS evicted_at timestamptz`);
  await client.query(`
    DO $$ BEGIN
      ALTER TABLE research_items ADD CONSTRAINT research_items_lifecycle_tier_check CHECK (lifecycle_tier IN ('working', 'archived', 'evicted'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);
  // Lets the per-sweep query rapidly find candidates eligible for
  // re-evaluation, sorted oldest-touched first.
  await client.query(`CREATE INDEX IF NOT EXISTS research_items_lifecycle_idx ON research_items (lifecycle_tier, last_used_at NULLS FIRST, created_at)`);
  // Hard-delete sweep scans evicted rows by their eviction timestamp.
  await client.query(`CREATE INDEX IF NOT EXISTS research_items_evicted_at_idx ON research_items (evicted_at) WHERE evicted_at IS NOT NULL`);

  // Tracks which embedding provider last wrote this row's vector in
  // Qdrant. Null = legacy (assumed hash). The re-embed offline pass
  // uses this to skip already-done rows on resume — see lib/reembed.ts.
  await client.query(`ALTER TABLE research_items ADD COLUMN IF NOT EXISTS vector_provider text`);
  await client.query(`ALTER TABLE research_items ADD COLUMN IF NOT EXISTS vector_embedded_at timestamptz`);
  await client.query(`CREATE INDEX IF NOT EXISTS research_items_vector_provider_idx ON research_items (vector_provider, id)`);

  await client.query(`
    DO $$ BEGIN
      ALTER TABLE research_items ADD CONSTRAINT research_items_visibility_check CHECK (visibility IN ('public', 'private'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS knowledge_usage_events (
      id bigserial PRIMARY KEY,
      request_id text NOT NULL,
      consumer_agent_id text REFERENCES agents(id) ON DELETE SET NULL,
      consumer_wallet text,
      consumer_erc8004_identity text,
      organization_id text REFERENCES organizations(id) ON DELETE SET NULL,
      endpoint text NOT NULL,
      query_hash text,
      query_metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      retrieved_item_ids text[] NOT NULL DEFAULT '{}',
      visibility_counts jsonb NOT NULL DEFAULT '{}'::jsonb,
      x402_receipt_id text,
      amount_paid numeric,
      payment_chain text,
      payment_token text,
      success_status text NOT NULL DEFAULT 'ok',
      latency_ms integer,
      served_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS x402_receipts (
      id text PRIMARY KEY,
      consumer_agent_id text REFERENCES agents(id) ON DELETE SET NULL,
      consumer_wallet text,
      organization_id text REFERENCES organizations(id) ON DELETE SET NULL,
      endpoint text,
      amount numeric,
      chain text,
      token text,
      currency text,
      raw jsonb NOT NULL DEFAULT '{}'::jsonb,
      status text NOT NULL DEFAULT 'received',
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await client.query(`ALTER TABLE x402_receipts ADD COLUMN IF NOT EXISTS currency text`);

  await client.query(`
    CREATE TABLE IF NOT EXISTS knowledge_requests (
      id text PRIMARY KEY,
      query text NOT NULL,
      normalized_topic text NOT NULL,
      requester_agent_id text REFERENCES agents(id) ON DELETE SET NULL,
      requester_wallet text,
      requester_erc8004_identity text,
      organization_id text REFERENCES organizations(id) ON DELETE SET NULL,
      source_request_id text,
      status text NOT NULL DEFAULT 'open',
      priority text NOT NULL DEFAULT 'normal',
      desired_output text NOT NULL DEFAULT 'brief',
      missing_topics text[] NOT NULL DEFAULT '{}',
      notes text,
      claimed_by_agent_id text REFERENCES agents(id) ON DELETE SET NULL,
      fulfilled_by_agent_id text REFERENCES agents(id) ON DELETE SET NULL,
      fulfillment_item_ids text[] NOT NULL DEFAULT '{}',
      validator_agent_id text REFERENCES agents(id) ON DELETE SET NULL,
      validation_notes text,
      coverage jsonb NOT NULL DEFAULT '{}'::jsonb,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now(),
      claimed_at timestamptz,
      fulfilled_at timestamptz,
      validated_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  await client.query(`
    DO $$ BEGIN
      ALTER TABLE knowledge_requests ADD CONSTRAINT knowledge_requests_status_check CHECK (status IN ('open', 'claimed', 'fulfilled', 'validated', 'closed', 'rejected'));
    EXCEPTION WHEN duplicate_object THEN NULL;
    END $$;
  `);

  await client.query(`
    CREATE TABLE IF NOT EXISTS contributor_quality_events (
      id bigserial PRIMARY KEY,
      research_item_id text REFERENCES research_items(id) ON DELETE CASCADE,
      contributor_agent_id text REFERENCES agents(id) ON DELETE SET NULL,
      event_type text NOT NULL,
      score numeric,
      metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  // Provider attribution / earnings ledger — credits an item's contributor
  // when their item is consumed by a (paid) query. See lib/attribution.ts.
  await client.query(`
    CREATE TABLE IF NOT EXISTS knowledge_attributions (
      id bigserial PRIMARY KEY,
      request_id text NOT NULL,
      research_item_id text REFERENCES research_items(id) ON DELETE SET NULL,
      provider_agent_id text REFERENCES agents(id) ON DELETE SET NULL,
      provider_wallet text,
      organization_id text REFERENCES organizations(id) ON DELETE SET NULL,
      consumer_agent_id text REFERENCES agents(id) ON DELETE SET NULL,
      consumer_wallet text,
      endpoint text NOT NULL,
      amount numeric NOT NULL DEFAULT 0,
      chain text,
      token text,
      x402_receipt_id text,
      settled boolean NOT NULL DEFAULT false,
      settled_at timestamptz,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS knowledge_attributions_provider_wallet_idx ON knowledge_attributions (lower(provider_wallet), created_at DESC)`);
  await client.query(`CREATE INDEX IF NOT EXISTS knowledge_attributions_provider_agent_idx ON knowledge_attributions (provider_agent_id, created_at DESC)`);
  await client.query(`CREATE INDEX IF NOT EXISTS knowledge_attributions_item_idx ON knowledge_attributions (research_item_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS knowledge_attributions_unsettled_idx ON knowledge_attributions (created_at) WHERE settled = false`);

  // --- Credit / billing system (the two-sided market money layer) ----------
  // Prepaid credit balance per OWNER wallet — the money lives at the wallet.
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_accounts (
      wallet text PRIMARY KEY,
      balance numeric NOT NULL DEFAULT 0,
      currency text NOT NULL DEFAULT 'USDC',
      total_earned numeric NOT NULL DEFAULT 0,
      total_spent numeric NOT NULL DEFAULT 0,
      total_deposited numeric NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  // Per-agent billing config = the whitelist. exempt agents query for free;
  // role marks providers (earn) vs consumers. PerkOS internal / research
  // agents are exempt:true, role 'provider' or 'both'.
  await client.query(`
    CREATE TABLE IF NOT EXISTS agent_billing (
      agent_id text PRIMARY KEY,
      wallet text,
      exempt boolean NOT NULL DEFAULT false,
      role text NOT NULL DEFAULT 'consumer',
      note text,
      updated_by text,
      updated_at timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  // Unified credit movements — the audit trail behind every balance change.
  await client.query(`
    CREATE TABLE IF NOT EXISTS credit_ledger (
      id bigserial PRIMARY KEY,
      wallet text NOT NULL,
      agent_id text,
      kind text NOT NULL,
      amount numeric NOT NULL,
      reason text NOT NULL,
      request_id text,
      x402_receipt_id text,
      balance_after numeric,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS credit_ledger_wallet_idx ON credit_ledger (lower(wallet), created_at DESC)`);
  await client.query(`CREATE INDEX IF NOT EXISTS credit_ledger_agent_idx ON credit_ledger (agent_id, created_at DESC)`);
  await client.query(`CREATE INDEX IF NOT EXISTS agent_billing_wallet_idx ON agent_billing (lower(wallet))`);

  // Provider payouts (F4 settlement) — on-chain USDC transfers treasury->provider.
  await client.query(`
    CREATE TABLE IF NOT EXISTS settlements (
      id text PRIMARY KEY,
      provider_wallet text NOT NULL,
      amount numeric NOT NULL,
      currency text NOT NULL DEFAULT 'USDC',
      chain text,
      token text,
      treasury text,
      tx_hash text,
      status text NOT NULL DEFAULT 'pending',
      error text,
      requested_by text,
      created_at timestamptz NOT NULL DEFAULT now(),
      settled_at timestamptz
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS settlements_provider_idx ON settlements (lower(provider_wallet), created_at DESC)`);

  // Tokenomics — admin-editable economics (prices, fee waterfall, reward split,
  // buyback). Single row ('default'); unset columns fall back to env defaults
  // in lib/tokenomics.ts. Editing this in the admin UI tunes pricing without a
  // redeploy. bps = basis points (10000 = 100%).
  await client.query(`
    CREATE TABLE IF NOT EXISTS tokenomics_config (
      id text PRIMARY KEY DEFAULT 'default',
      mode text,
      price_public numeric,
      price_private numeric,
      price_premium numeric,
      price_enterprise numeric,
      fee_provider_bps integer,
      fee_platform_bps integer,
      fee_reward_bps integer,
      reward_researcher_bps integer,
      buyback_enabled boolean,
      buyback_threshold numeric,
      updated_by text,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  // Recognized platform fee per paid query (the 20% take) — PerkOS revenue.
  await client.query(`
    CREATE TABLE IF NOT EXISTS platform_revenue (
      id bigserial PRIMARY KEY,
      request_id text,
      tier text,
      amount numeric NOT NULL,
      currency text NOT NULL DEFAULT 'USDC',
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS platform_revenue_created_idx ON platform_revenue (created_at DESC)`);

  // Accrued $PERKOS reward budget per paid query (the 5%). The buyback worker
  // (off until KMS key + legal) batches pending rows into a DEX buy, then
  // distributes the bought $PERKOS to the requester + researchers per the
  // recorded shares. Holds USDC-denominated amounts until then.
  await client.query(`
    CREATE TABLE IF NOT EXISTS reward_pool (
      id bigserial PRIMARY KEY,
      request_id text,
      amount numeric NOT NULL,
      currency text NOT NULL DEFAULT 'USDC',
      requester_wallet text,
      researcher_wallets jsonb NOT NULL DEFAULT '[]',
      researcher_bps integer,
      epoch text,
      status text NOT NULL DEFAULT 'pending',
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  await client.query(`CREATE INDEX IF NOT EXISTS reward_pool_status_idx ON reward_pool (status, created_at)`);

  // Claim distributions (pull model) — each row is a Merkle root the platform
  // posts to PerkosClaimVault. tree_dump holds the StandardMerkleTree so any
  // wallet's proof can be regenerated. Amounts are token base units (text).
  await client.query(`
    CREATE TABLE IF NOT EXISTS claim_distributions (
      id bigserial PRIMARY KEY,
      chain text NOT NULL DEFAULT 'base',
      root text NOT NULL,
      tree_dump jsonb NOT NULL,
      total_usdc text NOT NULL DEFAULT '0',
      total_reward text NOT NULL DEFAULT '0',
      entry_count integer NOT NULL DEFAULT 0,
      posted boolean NOT NULL DEFAULT false,
      tx_hash text,
      created_by text,
      created_at timestamptz NOT NULL DEFAULT now()
    )
  `);
  // Per-chain distributions: earnings are segregated by the consumer's payment
  // chain, so each chain has its own root (no cross-chain double-claim).
  await client.query(`ALTER TABLE claim_distributions ADD COLUMN IF NOT EXISTS chain text NOT NULL DEFAULT 'base'`);
  await client.query(`CREATE INDEX IF NOT EXISTS claim_distributions_created_idx ON claim_distributions (created_at DESC)`);

  // Cumulative $PERKOS reward owed per wallet (token base units, 18-dec). The
  // buyback worker fills this after converting the reward pool USDC → $PERKOS;
  // the claim roll-up reads it. Empty until the buyback is wired.
  await client.query(`
    CREATE TABLE IF NOT EXISTS token_rewards (
      wallet text PRIMARY KEY,
      cumulative_perkos numeric NOT NULL DEFAULT 0,
      updated_at timestamptz NOT NULL DEFAULT now()
    )
  `);


  await client.query(`CREATE INDEX IF NOT EXISTS research_items_agents_idx ON research_items USING gin (agents)`);
  await client.query(`CREATE INDEX IF NOT EXISTS research_items_chains_idx ON research_items USING gin (chains)`);
  await client.query(`CREATE INDEX IF NOT EXISTS research_items_visibility_org_idx ON research_items (visibility, organization_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS research_items_contributor_idx ON research_items (contributor_agent_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS research_items_publication_idx ON research_items (publication_status, updated_at DESC)`);
  await client.query(`CREATE INDEX IF NOT EXISTS research_items_contribution_type_idx ON research_items (contribution_type)`);
  await client.query(`CREATE INDEX IF NOT EXISTS research_items_quality_idx ON research_items (validation_status, quality_score DESC, confidence_percent DESC)`);
  await client.query(`CREATE INDEX IF NOT EXISTS research_items_search_idx ON research_items USING gin (to_tsvector('english', coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(track,'') || ' ' || coalesce(path,'')))`);
  await client.query(`CREATE INDEX IF NOT EXISTS agent_identities_wallet_idx ON agent_identities (lower(wallet))`);
  await client.query(`CREATE INDEX IF NOT EXISTS agent_identities_erc8004_idx ON agent_identities (erc8004_identity)`);
  await client.query(`CREATE INDEX IF NOT EXISTS organization_agents_agent_idx ON organization_agents (agent_id, status)`);
  await client.query(`CREATE INDEX IF NOT EXISTS knowledge_usage_events_request_idx ON knowledge_usage_events (request_id)`);
  await client.query(`CREATE INDEX IF NOT EXISTS knowledge_usage_events_consumer_idx ON knowledge_usage_events (consumer_agent_id, served_at DESC)`);
  await client.query(`CREATE INDEX IF NOT EXISTS knowledge_requests_status_idx ON knowledge_requests (status, priority, created_at DESC)`);
  await client.query(`CREATE INDEX IF NOT EXISTS knowledge_requests_topic_idx ON knowledge_requests (normalized_topic, status)`);
  await client.query(`CREATE INDEX IF NOT EXISTS knowledge_requests_requester_idx ON knowledge_requests (requester_agent_id, created_at DESC)`);
  await client.query(`CREATE INDEX IF NOT EXISTS knowledge_requests_claimed_idx ON knowledge_requests (claimed_by_agent_id, status)`);
  await client.query(`CREATE INDEX IF NOT EXISTS x402_receipts_consumer_idx ON x402_receipts (consumer_agent_id, created_at DESC)`);
}

export function normalizeValues(values: QueryValue[]) {
  return values;
}
