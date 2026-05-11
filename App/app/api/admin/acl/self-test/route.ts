import crypto from 'crypto';
import { readableKnowledgeWhere, type AccessContext } from '../../../../../lib/access';
import { requireAdmin } from '../../../../../lib/admin';
import { withDb } from '../../../../../lib/db';

export const dynamic = 'force-dynamic';

async function visibleCount(client: import('pg').Client, access: AccessContext, itemId: string) {
  const acl = readableKnowledgeWhere(access, [itemId]);
  const res = await client.query(
    `SELECT count(*)::int AS count
     FROM research_items
     WHERE id = $1 AND ${acl.sql}`,
    acl.params
  );
  return res.rows[0].count as number;
}

function access(agentId: string | null, organizationIds: string[] = []): AccessContext {
  return {
    agentId,
    wallet: null,
    erc8004Identity: null,
    organizationIds,
    isAdmin: false,
  };
}

export async function POST(request: Request) {
  const blocked = requireAdmin(request);
  if (blocked) return blocked;

  const result = await withDb(async (client) => {
    await client.query('BEGIN');
    try {
      const suffix = crypto.randomUUID();
      const orgA = `acl_org_a_${suffix}`;
      const orgB = `acl_org_b_${suffix}`;
      const agentA = `acl_agent_a_${suffix}`;
      const agentB = `acl_agent_b_${suffix}`;
      const privateItem = `acl_private_item_${suffix}`;
      const publicItem = `acl_public_item_${suffix}`;

      await client.query(`INSERT INTO organizations (id, name, slug) VALUES ($1, 'ACL Self-Test A', $1), ($2, 'ACL Self-Test B', $2)`, [orgA, orgB]);
      await client.query(`INSERT INTO agents (id, display_name) VALUES ($1, 'ACL Self-Test Agent A'), ($2, 'ACL Self-Test Agent B')`, [agentA, agentB]);
      await client.query(`INSERT INTO organization_agents (organization_id, agent_id) VALUES ($1, $2), ($3, $4)`, [orgA, agentA, orgB, agentB]);
      await client.query(
        `INSERT INTO research_items (id, source, title, path, visibility, organization_id, summary)
         VALUES
          ($1, 'acl-self-test', 'Private ACL Self-Test', 'self-test/private', 'private', $2, 'rollback-only private acl verification'),
          ($3, 'acl-self-test', 'Public ACL Self-Test', 'self-test/public', 'public', null, 'rollback-only public acl verification')`,
        [privateItem, orgA, publicItem]
      );

      const checks = {
        anonymousPublic: await visibleCount(client, access(null), publicItem),
        anonymousPrivate: await visibleCount(client, access(null), privateItem),
        orgMemberPrivate: await visibleCount(client, access(agentA, [orgA]), privateItem),
        otherOrgPrivate: await visibleCount(client, access(agentB, [orgB]), privateItem),
        orgMemberPublic: await visibleCount(client, access(agentA, [orgA]), publicItem),
      };

      await client.query('ROLLBACK');

      const passed = checks.anonymousPublic === 1
        && checks.anonymousPrivate === 0
        && checks.orgMemberPrivate === 1
        && checks.otherOrgPrivate === 0
        && checks.orgMemberPublic === 1;

      return { passed, checks };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });

  return Response.json({
    ok: result.passed,
    mode: 'transaction_rollback',
    persisted: false,
    ...result,
  }, { status: result.passed ? 200 : 500 });
}
