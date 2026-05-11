import { hashValue, publicAgent, requireAdmin } from '../../../../lib/admin';
import { withDb } from '../../../../lib/db';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const blocked = requireAdmin(request);
  if (blocked) return blocked;

  const rows = await withDb(async (client) => {
    const res = await client.query(
      `SELECT
         a.id,
         a.display_name,
         a.agent_type,
         a.status,
         a.created_at,
         a.updated_at,
         coalesce(json_agg(DISTINCT jsonb_build_object(
           'organizationId', oa.organization_id,
           'role', oa.role,
           'scopes', oa.scopes,
           'status', oa.status
         )) FILTER (WHERE oa.organization_id IS NOT NULL), '[]'::json) AS memberships,
         count(DISTINCT ri.id)::int AS contribution_count,
         count(DISTINCT ri.id) FILTER (WHERE ri.visibility = 'private')::int AS private_count,
         count(DISTINCT ri.id) FILTER (WHERE ri.publication_status = 'review_required')::int AS public_candidate_count,
         coalesce(sum(ri.usage_count), 0)::int AS total_usage,
         max(ri.updated_at) AS last_contribution_at,
         bool_or(ai.wallet IS NOT NULL) AS has_wallet,
         bool_or(ai.erc8004_identity IS NOT NULL) AS has_erc8004_identity,
         min(ai.chain) FILTER (WHERE ai.chain IS NOT NULL) AS identity_chain,
         min(ai.wallet) FILTER (WHERE ai.wallet IS NOT NULL) AS sample_wallet,
         min(ai.erc8004_identity) FILTER (WHERE ai.erc8004_identity IS NOT NULL) AS sample_erc8004
       FROM agents a
       LEFT JOIN organization_agents oa ON oa.agent_id = a.id
       LEFT JOIN research_items ri ON ri.contributor_agent_id = a.id
       LEFT JOIN agent_identities ai ON ai.agent_id = a.id AND ai.status = 'active'
       WHERE a.agent_type IN ('contributor', 'both') OR ri.id IS NOT NULL
       GROUP BY a.id
       ORDER BY last_contribution_at DESC NULLS LAST, a.created_at DESC
       LIMIT 200`
    );
    return res.rows;
  });

  return Response.json({
    ok: true,
    count: rows.length,
    providers: rows.map((row) => ({
      ...publicAgent(row),
      memberships: row.memberships,
      contributionCount: row.contribution_count,
      privateCount: row.private_count,
      publicCandidateCount: row.public_candidate_count,
      totalUsage: row.total_usage,
      lastContributionAt: row.last_contribution_at,
      identity: {
        hasWallet: Boolean(row.has_wallet),
        walletHash: hashValue(row.sample_wallet),
        hasErc8004Identity: Boolean(row.has_erc8004_identity),
        erc8004Hash: hashValue(row.sample_erc8004),
        chain: row.identity_chain || null,
      },
    })),
  });
}
