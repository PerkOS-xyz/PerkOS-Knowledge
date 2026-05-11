import { getAccessContext, readableKnowledgeWhere, recordUsage, requestId, sanitizeKnowledgeRow, visibilityCounts } from '../../../lib/access';
import { withDb } from '../../../lib/db';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const started = Date.now();
  const id = requestId();
  const body = await request.json().catch(() => ({}));
  const query = String(body.query || body.question || '').trim();
  const limit = Math.min(Number(body.limit || 8), 25);
  const mode = String(body.mode || 'context');

  if (!query) return Response.json({ ok: false, error: 'query_required' }, { status: 400 });

  const result = await withDb(async (client) => {
    const access = await getAccessContext(client, request);
    const params: unknown[] = [query];
    const acl = readableKnowledgeWhere(access, params);
    acl.params.push(limit);

    const res = await client.query(
      `SELECT id, title, summary, track, chains, path, visibility, organization_id,
              validation_status, sanitization_status, quality_score, usage_count, updated_at
       FROM research_items
       WHERE to_tsvector('english', coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(track,'') || ' ' || coalesce(path,'')) @@ plainto_tsquery('english', $1)
         AND ${acl.sql}
       ORDER BY quality_score DESC NULLS LAST, usage_count DESC, updated_at DESC
       LIMIT $${acl.params.length}`,
      acl.params
    );

    await recordUsage(client, {
      requestId: id,
      access,
      endpoint: '/skill/query',
      query,
      retrievedItemIds: res.rows.map((row) => row.id),
      visibilityCounts: visibilityCounts(res.rows),
      latencyMs: Date.now() - started,
    });

    return res.rows;
  });

  return Response.json({
    ok: true,
    requestId: id,
    mode,
    query,
    count: result.length,
    context: result.map(sanitizeKnowledgeRow),
    guidance: 'Use this context with your own LLM/runtime. Knowledge does not require a specific model provider.',
  });
}
