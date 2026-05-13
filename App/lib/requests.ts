import crypto from 'crypto';
import type { Client } from 'pg';
import type { AccessContext } from './access';

export type KnowledgeRequestStatus = 'open' | 'claimed' | 'fulfilled' | 'validated' | 'closed' | 'rejected';

export type KnowledgeRequestInput = {
  query: string;
  requester?: AccessContext;
  sourceRequestId?: string | null;
  priority?: string | null;
  desiredOutput?: string | null;
  missingTopics?: string[];
  notes?: string | null;
  coverage?: Record<string, unknown>;
  metadata?: Record<string, unknown>;
  allowDuplicate?: boolean;
};

export function knowledgeRequestId() {
  return `kneed_${crypto.randomUUID()}`;
}

export function normalizeTopic(query: string) {
  return query
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9\s:_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .slice(0, 240);
}

export function cleanPriority(value: unknown) {
  const text = String(value || 'normal').toLowerCase().trim();
  if (['low', 'normal', 'high', 'urgent'].includes(text)) return text;
  return 'normal';
}

export function cleanDesiredOutput(value: unknown) {
  const text = String(value || 'brief').toLowerCase().trim().replace(/[^a-z0-9:_-]+/g, '-');
  return text || 'brief';
}

export function cleanStringArray(value: unknown, max = 12) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item || '').trim()).filter(Boolean).slice(0, max);
}

export function publicKnowledgeRequest(row: Record<string, unknown>) {
  return {
    id: row.id,
    query: row.query,
    normalizedTopic: row.normalized_topic,
    status: row.status,
    priority: row.priority,
    desiredOutput: row.desired_output,
    missingTopics: Array.isArray(row.missing_topics) ? row.missing_topics : [],
    requesterAgentId: row.requester_agent_id ?? null,
    organizationScope: row.organization_id ? 'organization' : null,
    claimedByAgentId: row.claimed_by_agent_id ?? null,
    fulfilledByAgentId: row.fulfilled_by_agent_id ?? null,
    fulfillmentItemIds: Array.isArray(row.fulfillment_item_ids) ? row.fulfillment_item_ids : [],
    coverage: row.coverage ?? {},
    metadata: row.metadata ?? {},
    createdAt: row.created_at,
    claimedAt: row.claimed_at ?? null,
    fulfilledAt: row.fulfilled_at ?? null,
    validatedAt: row.validated_at ?? null,
    updatedAt: row.updated_at,
  };
}

export async function createKnowledgeRequest(client: Client, input: KnowledgeRequestInput) {
  const query = input.query.trim();
  const normalizedTopic = normalizeTopic(query);
  const priority = cleanPriority(input.priority);
  const desiredOutput = cleanDesiredOutput(input.desiredOutput);
  const missingTopics = input.missingTopics?.length ? input.missingTopics.slice(0, 12) : [normalizedTopic].filter(Boolean);
  const requester = input.requester;

  if (!input.allowDuplicate) {
    const existing = await client.query(
      `SELECT *
       FROM knowledge_requests
       WHERE normalized_topic = $1
         AND status IN ('open', 'claimed')
         AND coalesce(organization_id, '') = coalesce($2, '')
       ORDER BY created_at DESC
       LIMIT 1`,
      [normalizedTopic, requester?.organizationIds[0] || null]
    );
    if (existing.rowCount) {
      return { row: existing.rows[0], created: false };
    }
  }

  const id = knowledgeRequestId();
  const result = await client.query(
    `INSERT INTO knowledge_requests
      (id, query, normalized_topic, requester_agent_id, requester_wallet, requester_erc8004_identity, organization_id,
       source_request_id, status, priority, desired_output, missing_topics, notes, coverage, metadata)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'open',$9,$10,$11,$12,$13,$14)
     RETURNING *`,
    [
      id,
      query,
      normalizedTopic,
      requester?.agentId || null,
      requester?.wallet || null,
      requester?.erc8004Identity || null,
      requester?.organizationIds[0] || null,
      input.sourceRequestId || null,
      priority,
      desiredOutput,
      missingTopics,
      input.notes || null,
      input.coverage || {},
      input.metadata || {},
    ]
  );

  return { row: result.rows[0], created: true };
}
