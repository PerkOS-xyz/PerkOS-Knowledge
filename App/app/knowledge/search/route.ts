import { getAccessContext, readableKnowledgeWhere, recordUsage, requestId, sanitizeKnowledgeRow, visibilityCounts } from '../../../lib/access';
import { withDb } from '../../../lib/db';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const started = Date.now();
  const id = requestId();
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  const agent = (url.searchParams.get('agent') || '').trim();
  const limit = Math.min(Number(url.searchParams.get('limit') || 10), 50);

  const response = await withDb(async (client) => {
    const access = await getAccessContext(client, request);
    const params: unknown[] = [];
    const where: string[] = [];

    if (q) {
      params.push(q);
      where.push(`to_tsvector('english', coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(track,'') || ' ' || coalesce(path,'')) @@ plainto_tsquery('english', $${params.length})`);
    }

    if (agent) {
      params.push(agent);
      where.push(`$${params.length} = ANY(agents)`);
    }

    const acl = readableKnowledgeWhere(access, params);
    where.push(acl.sql);

    const minConfidence = Math.max(0, Math.min(Number(url.searchParams.get('minConfidence') || url.searchParams.get('min_confidence') || 0), 100));
    if (minConfidence > 0) {
      acl.params.push(minConfidence);
      where.push(`coalesce(confidence_percent, quality_score, 0) >= $${acl.params.length}`);
    }
    if (url.searchParams.get('requireValidated') === 'true' || url.searchParams.get('require_validated') === 'true') {
      where.push(`validation_status = 'validated'`);
    }

    acl.params.push(limit);
    const sql = `
      SELECT id, source, date, track, title, path, agents, chains, status, confidence, summary,
             visibility, organization_id, validation_status, sanitization_status, quality_score, confidence_percent, trust_tier, quality_reasons, usage_count, updated_at
      FROM research_items
      WHERE ${where.join(' AND ')}
      ORDER BY (validation_status = 'validated') DESC, coalesce(confidence_percent, quality_score, 0) DESC, date DESC NULLS LAST, updated_at DESC
      LIMIT $${acl.params.length}
    `;

    const res = await client.query(sql, acl.params);
    await recordUsage(client, {
      requestId: id,
      access,
      endpoint: '/knowledge/search',
      query: q,
      retrievedItemIds: res.rows.map((row) => row.id),
      visibilityCounts: visibilityCounts(res.rows),
      latencyMs: Date.now() - started,
    });

    return { access, rows: res.rows };
  });

  return Response.json({
    ok: true,
    requestId: id,
    query: q || null,
    agent: agent || null,
    count: response.rows.length,
    results: response.rows.map(sanitizeKnowledgeRow),
  });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const params = new URLSearchParams();
  if (body.query) params.set('q', String(body.query));
  if (body.agent) params.set('agent', String(body.agent));
  if (body.limit) params.set('limit', String(body.limit));
  return GET(new Request(`${request.url}?${params.toString()}`, { headers: request.headers }));
}
