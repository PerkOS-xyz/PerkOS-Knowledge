import crypto from 'crypto';
import type { Client } from 'pg';

export type ProviderVisibilityInput = 'public' | 'private' | 'public_candidate';
export type StoredVisibility = 'public' | 'private';

export const PROVIDER_SCOPES = [
  'research:submit',
  'knowledge:contribute',
  'knowledge:private',
  'knowledge:public_candidate',
  'ingest',
] as const;

export type ProviderIdentity = {
  agentId: string | null;
  organizationId: string | null;
  wallet: string | null;
  erc8004Identity: string | null;
  identityChain: string | null;
};

export function textOrNull(value: unknown) {
  const text = String(value || '').trim();
  return text || null;
}

export function normalizeProviderVisibility(value: unknown): ProviderVisibilityInput {
  const text = String(value || '').trim().toLowerCase();
  if (text === 'public') return 'public';
  if (text === 'public_candidate') return 'public_candidate';
  return 'private';
}

export function storedVisibility(value: ProviderVisibilityInput): StoredVisibility {
  return value === 'public' ? 'public' : 'private';
}

export function publicationStatus(value: ProviderVisibilityInput) {
  if (value === 'public') return 'published';
  if (value === 'public_candidate') return 'review_required';
  return 'private';
}

export function defaultSanitizationStatus(value: ProviderVisibilityInput, provided?: string | null) {
  if (provided) return provided;
  if (value === 'public') return 'sanitized';
  if (value === 'public_candidate') return 'pending';
  return 'internal';
}

export function defaultValidationStatus(provided?: string | null) {
  return provided || 'pending';
}

export function getProviderIdentity(request: Request, body: Record<string, unknown>): ProviderIdentity {
  return {
    agentId: textOrNull(request.headers.get('x-agent-id')) || textOrNull(body.contributor_agent_id) || textOrNull(body.agent_id),
    organizationId: textOrNull(request.headers.get('x-organization-id')) || textOrNull(body.organization_id),
    wallet: textOrNull(request.headers.get('x-agent-wallet')) || textOrNull(body.contributor_wallet),
    erc8004Identity: textOrNull(request.headers.get('x-agent-erc8004')) || textOrNull(body.contributor_erc8004_identity),
    identityChain: textOrNull(request.headers.get('x-agent-chain')) || textOrNull(body.identity_chain),
  };
}

export function contributionId(source: string, organizationId: string | null, path: string) {
  const hash = crypto.createHash('sha256').update(`${source}:${organizationId || 'public'}:${path}`).digest('hex').slice(0, 16);
  return `kitem_${hash}`;
}

export async function assertProviderCanSubmit(
  client: Client,
  identity: ProviderIdentity,
  stored: StoredVisibility,
  publication: string
): Promise<{ ok: true; scopes: string[]; role: string | null } | { ok: false; error: string; status: number }> {
  if (!identity.agentId) {
    return { ok: false, error: 'x_agent_id_required', status: 400 };
  }

  const agent = await client.query(
    `SELECT id, status, agent_type FROM agents WHERE id = $1`,
    [identity.agentId]
  );
  if (!agent.rowCount || agent.rows[0].status !== 'active') {
    return { ok: false, error: 'provider_agent_not_registered_or_inactive', status: 403 };
  }

  if (stored === 'private' && !identity.organizationId) {
    return { ok: false, error: 'private_provider_items_require_organization_id', status: 400 };
  }

  if (!identity.organizationId) {
    return { ok: true, scopes: [], role: null };
  }

  const membership = await client.query(
    `SELECT role, scopes, status
     FROM organization_agents
     WHERE organization_id = $1 AND agent_id = $2`,
    [identity.organizationId, identity.agentId]
  );

  if (!membership.rowCount || membership.rows[0].status !== 'active') {
    return { ok: false, error: 'provider_agent_not_member_of_organization', status: 403 };
  }

  const scopes = Array.isArray(membership.rows[0].scopes) ? membership.rows[0].scopes as string[] : [];
  const role = String(membership.rows[0].role || 'member');
  const allowedByScope = scopes.some((scope) => ['research:submit', 'knowledge:contribute', 'ingest'].includes(scope));
  const allowedByRole = ['owner', 'admin', 'contributor', 'researcher'].includes(role);

  if (!allowedByScope && !allowedByRole) {
    return { ok: false, error: 'provider_agent_missing_research_submit_scope', status: 403 };
  }

  if (stored === 'private' && !scopes.includes('knowledge:private') && !allowedByRole) {
    return { ok: false, error: 'provider_agent_missing_private_scope', status: 403 };
  }

  if (publication === 'review_required' && !scopes.includes('knowledge:public_candidate') && !allowedByRole) {
    return { ok: false, error: 'provider_agent_missing_public_candidate_scope', status: 403 };
  }

  return { ok: true, scopes, role };
}
