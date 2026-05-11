import { hashValue, publicAgent, requireAdmin, stableId } from '../../../../lib/admin';
import { normalizeWallet } from '../../../../lib/auth';
import { withDb } from '../../../../lib/db';

export const dynamic = 'force-dynamic';

type MembershipInput = {
  organizationId?: string;
  role?: string;
  scopes?: string[];
  status?: string;
};

type Body = {
  id?: string;
  displayName?: string;
  agentType?: string;
  status?: string;
  wallet?: string;
  erc8004Identity?: string;
  chain?: string;
  metadata?: Record<string, unknown>;
  memberships?: MembershipInput[];
  organizationId?: string;
  role?: string;
  scopes?: string[];
};

function cleanScopes(scopes?: unknown) {
  if (!Array.isArray(scopes)) return [];
  return scopes.map((scope) => String(scope).trim()).filter(Boolean).slice(0, 20);
}

export async function GET(request: Request) {
  const blocked = requireAdmin(request);
  if (blocked) return blocked;

  const url = new URL(request.url);
  const organizationId = (url.searchParams.get('organization_id') || url.searchParams.get('organizationId') || '').trim();

  const rows = await withDb(async (client) => {
    if (organizationId) {
      const res = await client.query(
        `SELECT a.id, a.display_name, a.agent_type, a.status, a.created_at, a.updated_at,
                oa.organization_id, oa.role, oa.scopes
         FROM agents a
         JOIN organization_agents oa ON oa.agent_id = a.id
         WHERE oa.organization_id = $1 AND oa.status = 'active'
         ORDER BY a.created_at DESC
         LIMIT 100`,
        [organizationId]
      );
      return res.rows;
    }

    const res = await client.query(
      `SELECT id, display_name, agent_type, status, created_at, updated_at
       FROM agents
       ORDER BY created_at DESC
       LIMIT 100`
    );
    return res.rows;
  });

  return Response.json({
    ok: true,
    count: rows.length,
    agents: rows.map((row) => ({
      ...publicAgent(row),
      organizationId: row.organization_id || undefined,
      role: row.role || undefined,
      scopes: row.scopes || undefined,
    })),
  });
}

export async function POST(request: Request) {
  const blocked = requireAdmin(request);
  if (blocked) return blocked;

  const body = await request.json().catch(() => ({})) as Body;
  const displayName = String(body.displayName || '').trim();
  if (!displayName) return Response.json({ ok: false, error: 'display_name_required' }, { status: 400 });

  const id = String(body.id || stableId('agent', displayName)).trim();
  const agentType = ['consumer', 'contributor', 'both'].includes(String(body.agentType)) ? String(body.agentType) : 'consumer';
  const status = ['active', 'inactive'].includes(String(body.status)) ? String(body.status) : 'active';
  const wallet = normalizeWallet(body.wallet) || null;
  const erc8004Identity = String(body.erc8004Identity || '').trim() || null;
  const chain = String(body.chain || '').trim() || null;
  const memberships = [
    ...(Array.isArray(body.memberships) ? body.memberships : []),
    ...(body.organizationId ? [{ organizationId: body.organizationId, role: body.role, scopes: body.scopes }] : []),
  ].filter((membership) => membership.organizationId);

  const result = await withDb(async (client) => {
    await client.query('BEGIN');
    try {
      const agentRes = await client.query(
        `INSERT INTO agents (id, display_name, agent_type, status, metadata, updated_at)
         VALUES ($1, $2, $3, $4, $5, now())
         ON CONFLICT (id) DO UPDATE SET
           display_name = EXCLUDED.display_name,
           agent_type = EXCLUDED.agent_type,
           status = EXCLUDED.status,
           metadata = agents.metadata || EXCLUDED.metadata,
           updated_at = now()
         RETURNING id, display_name, agent_type, status, created_at, updated_at`,
        [id, displayName, agentType, status, body.metadata || {}]
      );

      if (wallet || erc8004Identity) {
        await client.query(
          `INSERT INTO agent_identities (agent_id, wallet, erc8004_identity, chain, status)
           VALUES ($1, $2, $3, $4, 'active')
           ON CONFLICT DO NOTHING`,
          [id, wallet, erc8004Identity, chain]
        );
      }

      for (const membership of memberships) {
        const organizationId = String(membership.organizationId).trim();
        const role = String(membership.role || 'member').trim() || 'member';
        const memberStatus = ['active', 'inactive'].includes(String(membership.status)) ? String(membership.status) : 'active';
        await client.query(
          `INSERT INTO organization_agents (organization_id, agent_id, role, scopes, status)
           VALUES ($1, $2, $3, $4, $5)
           ON CONFLICT (organization_id, agent_id) DO UPDATE SET
             role = EXCLUDED.role,
             scopes = EXCLUDED.scopes,
             status = EXCLUDED.status`,
          [organizationId, id, role, cleanScopes(membership.scopes), memberStatus]
        );
      }

      const memberRes = await client.query(
        `SELECT organization_id, role, scopes, status
         FROM organization_agents
         WHERE agent_id = $1
         ORDER BY organization_id`,
        [id]
      );

      await client.query('COMMIT');
      return {
        agent: agentRes.rows[0],
        memberships: memberRes.rows,
      };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });

  return Response.json({
    ok: true,
    agent: {
      ...publicAgent(result.agent),
      identity: {
        hasWallet: Boolean(wallet),
        walletHash: hashValue(wallet),
        hasErc8004Identity: Boolean(erc8004Identity),
        erc8004Hash: hashValue(erc8004Identity),
        chain: chain || null,
      },
      memberships: result.memberships.map((membership) => ({
        organizationId: membership.organization_id,
        role: membership.role,
        scopes: membership.scopes,
        status: membership.status,
      })),
    },
  });
}
