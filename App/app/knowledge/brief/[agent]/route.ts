import { getAccessContext, readableKnowledgeWhere, recordUsage, requestId, sanitizeKnowledgeRow, visibilityCounts } from '../../../../lib/access';
import { withDb } from '../../../../lib/db';

export const dynamic = 'force-dynamic';

export async function GET(request: Request, context: { params: Promise<{ agent: string }> }) {
  const started = Date.now();
  const request_id = requestId();
  const { agent } = await context.params;
  const normalized = agent.toLowerCase();

  const rows = await withDb(async (client) => {
    const access = await getAccessContext(client, request);
    const acl = readableKnowledgeWhere(access, [normalized]);
    const res = await client.query(
      `SELECT id, source, date, track, title, path, agents, chains, summary,
              visibility, organization_id, validation_status, sanitization_status, quality_score, confidence_percent, trust_tier, quality_reasons, usage_count, updated_at
       FROM research_items
       WHERE lower($1) = ANY(SELECT lower(unnest(agents)))
         AND ${acl.sql}
       ORDER BY (validation_status = 'validated') DESC, coalesce(confidence_percent, quality_score, 0) DESC, date DESC NULLS LAST, updated_at DESC
       LIMIT 40`,
      acl.params
    );

    await recordUsage(client, {
      requestId: request_id,
      access,
      endpoint: '/knowledge/brief/:agent',
      query: normalized,
      retrievedItemIds: res.rows.map((row) => row.id),
      visibilityCounts: visibilityCounts(res.rows),
      latencyMs: Date.now() - started,
    });

    return res.rows;
  });

  return Response.json({ ok: true, requestId: request_id, agent: normalized, count: rows.length, items: rows.map(sanitizeKnowledgeRow) });
}
