import crypto from 'crypto';
import type { Client } from 'pg';
import { isAllowedWallet, normalizeWallet } from './auth';

export type AccessContext = {
  agentId: string | null;
  wallet: string | null;
  erc8004Identity: string | null;
  organizationIds: string[];
  isAdmin: boolean;
};

export type AccessWhere = {
  sql: string;
  params: unknown[];
};

function splitHeader(value: string | null) {
  return (value || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

export function requestId() {
  return `kreq_${crypto.randomUUID()}`;
}

export function hashQuery(query: string) {
  if (!query.trim()) return null;
  return crypto.createHash('sha256').update(query.trim()).digest('hex');
}

export async function getAccessContext(client: Client, request: Request): Promise<AccessContext> {
  const wallet = normalizeWallet(request.headers.get('x-agent-wallet') || request.headers.get('x-consumer-wallet')) || null;
  const erc8004Identity = (request.headers.get('x-agent-erc8004') || request.headers.get('x-consumer-erc8004') || '').trim() || null;
  const explicitAgentId = (request.headers.get('x-agent-id') || request.headers.get('x-consumer-agent-id') || '').trim() || null;
  const requestedOrgIds = splitHeader(request.headers.get('x-organization-id') || request.headers.get('x-org-id'));
  const isAdmin = Boolean(wallet && isAllowedWallet(wallet));

  let agentId = explicitAgentId;
  const orgs = new Set<string>();

  if (!agentId && (wallet || erc8004Identity)) {
    const identity = await client.query(
      `SELECT agent_id
       FROM agent_identities
       WHERE status = 'active'
         AND (($1::text IS NOT NULL AND lower(wallet) = lower($1))
          OR ($2::text IS NOT NULL AND erc8004_identity = $2))
       ORDER BY id ASC
       LIMIT 1`,
      [wallet, erc8004Identity]
    );
    agentId = identity.rows[0]?.agent_id || null;
  }

  // Only persist/use agent ids that are onboarded and active. Some runtimes
  // (OpenClaw/Hermes/LLM gateways) naturally send an `x-agent-id` before the
  // Knowledge service has onboarded that agent. Treat those callers as public
  // consumers instead of letting FK-backed usage/request writes fail with 500s.
  if (agentId) {
    const registered = await client.query(
      `SELECT id
       FROM agents
       WHERE id = $1 AND status = 'active'
       LIMIT 1`,
      [agentId]
    );
    if (!registered.rowCount) agentId = null;
  }

  if (agentId) {
    const memberships = await client.query(
      `SELECT organization_id
       FROM organization_agents
       WHERE agent_id = $1 AND status = 'active'`,
      [agentId]
    );
    for (const row of memberships.rows) orgs.add(row.organization_id);
  }

  if (isAdmin) {
    for (const orgId of requestedOrgIds) orgs.add(orgId);
  } else if (requestedOrgIds.length) {
    const requested = new Set(requestedOrgIds);
    for (const orgId of [...orgs]) {
      if (!requested.has(orgId)) orgs.delete(orgId);
    }
  }

  return {
    agentId,
    wallet,
    erc8004Identity,
    organizationIds: [...orgs],
    isAdmin,
  };
}

export function readableKnowledgeWhere(access: AccessContext, initialParams: unknown[] = []): AccessWhere {
  const params = [...initialParams];
  if (access.isAdmin) return { sql: 'TRUE', params };

  if (!access.organizationIds.length) {
    return { sql: `visibility = 'public'`, params };
  }

  params.push(access.organizationIds);
  return {
    sql: `(visibility = 'public' OR (visibility = 'private' AND organization_id = ANY($${params.length}::text[])))`,
    params,
  };
}

export function qdrantAccessFilter(access: AccessContext) {
  if (access.isAdmin) return undefined;
  const publicFilter = { key: 'visibility', match: { value: 'public' } };
  const legacyPublicFilter = { is_empty: { key: 'visibility' } };
  if (!access.organizationIds.length) return { should: [publicFilter, legacyPublicFilter] };
  return {
    should: [
      publicFilter,
      legacyPublicFilter,
      {
        must: [
          { key: 'visibility', match: { value: 'private' } },
          { key: 'organization_id', match: { any: access.organizationIds } },
        ],
      },
    ],
  };
}

export async function recordUsage(client: Client, event: {
  requestId: string;
  access: AccessContext;
  endpoint: string;
  query?: string;
  retrievedItemIds: string[];
  visibilityCounts: Record<string, number>;
  successStatus?: string;
  latencyMs?: number;
  x402ReceiptId?: string | null;
  amountPaid?: number | null;
  paymentChain?: string | null;
  paymentToken?: string | null;
}) {
  await client.query(
    `INSERT INTO knowledge_usage_events
      (request_id, consumer_agent_id, consumer_wallet, consumer_erc8004_identity, organization_id, endpoint, query_hash, retrieved_item_ids, visibility_counts, x402_receipt_id, amount_paid, payment_chain, payment_token, success_status, latency_ms)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
    [
      event.requestId,
      event.access.agentId,
      event.access.wallet,
      event.access.erc8004Identity,
      event.access.organizationIds[0] || null,
      event.endpoint,
      event.query ? hashQuery(event.query) : null,
      event.retrievedItemIds,
      event.visibilityCounts,
      event.x402ReceiptId || null,
      event.amountPaid ?? null,
      event.paymentChain || null,
      event.paymentToken || null,
      event.successStatus || 'ok',
      event.latencyMs || null,
    ]
  );

  if (event.retrievedItemIds.length) {
    await client.query(
      `UPDATE research_items SET usage_count = usage_count + 1 WHERE id = ANY($1::text[])`,
      [event.retrievedItemIds]
    );
  }
}

export function visibilityCounts(rows: Array<{ visibility?: string }>) {
  return rows.reduce<Record<string, number>>((acc, row) => {
    const key = row.visibility || 'unknown';
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

export function publicKnowledgeId(id: string) {
  return `kitem_${crypto.createHash('sha256').update(id).digest('hex').slice(0, 16)}`;
}

export function sanitizeKnowledgeRow<T extends Record<string, unknown>>(row: T) {
  const visibility = String(row.visibility || 'public');
  return {
    id: publicKnowledgeId(String(row.id || row.path || row.title || 'item')),
    source: 'research-sync',
    date: row.date ?? null,
    track: row.track ?? null,
    title: row.title ?? null,
    path: row.path ?? null,
    chains: Array.isArray(row.chains) ? row.chains : [],
    status: row.status ?? null,
    confidence: row.confidence ?? null,
    summary: row.summary ?? null,
    visibility,
    organizationScope: visibility === 'private' ? 'organization' : null,
    validationStatus: row.validation_status ?? null,
    sanitizationStatus: row.sanitization_status ?? null,
    qualityScore: row.quality_score ?? null,
    usageCount: row.usage_count ?? null,
    updatedAt: row.updated_at ?? null,
  };
}
