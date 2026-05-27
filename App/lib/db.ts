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
