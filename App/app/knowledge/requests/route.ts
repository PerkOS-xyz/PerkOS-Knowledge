import { getAccessContext, recordUsage, requestId } from '../../../lib/access';
import { withDb } from '../../../lib/db';
import { cleanDesiredOutput, cleanPriority, cleanStringArray, createKnowledgeRequest, publicKnowledgeRequest } from '../../../lib/requests';

export const dynamic = 'force-dynamic';

function statusFilter(value: string | null) {
  const status = String(value || 'open').trim().toLowerCase();
  if (['open', 'claimed', 'fulfilled', 'validated', 'closed', 'rejected', 'all'].includes(status)) return status;
  return 'open';
}

export async function GET(request: Request) {
  const started = Date.now();
  const id = requestId();
  const url = new URL(request.url);
  const status = statusFilter(url.searchParams.get('status'));
  const limit = Math.min(Number(url.searchParams.get('limit') || 25), 100);

  const response = await withDb(async (client) => {
    const access = await getAccessContext(client, request);
    const params: unknown[] = [];
    const where: string[] = [];

    if (status !== 'all') {
      params.push(status);
      where.push(`status = $${params.length}`);
    }

    if (!access.isAdmin) {
      if (access.organizationIds.length) {
        params.push(access.organizationIds);
        where.push(`(organization_id IS NULL OR organization_id = ANY($${params.length}::text[]))`);
      } else {
        where.push(`organization_id IS NULL`);
      }
    }

    params.push(limit);
    const res = await client.query(
      `SELECT * FROM knowledge_requests
       WHERE ${where.join(' AND ')}
       ORDER BY
        CASE priority WHEN 'urgent' THEN 0 WHEN 'high' THEN 1 WHEN 'normal' THEN 2 ELSE 3 END,
        created_at DESC
       LIMIT $${params.length}`,
      params
    );

    await recordUsage(client, {
      requestId: id,
      access,
      endpoint: '/knowledge/requests',
      query: `status:${status}`,
      retrievedItemIds: [],
      visibilityCounts: {},
      latencyMs: Date.now() - started,
    });

    return { rows: res.rows };
  });

  return Response.json({
    ok: true,
    requestId: id,
    status,
    count: response.rows.length,
    requests: response.rows.map(publicKnowledgeRequest),
  });
}

export async function POST(request: Request) {
  const id = requestId();
  const body = await request.json().catch(() => ({}));
  const query = String(body.query || body.question || body.topic || '').trim();
  if (!query) return Response.json({ ok: false, error: 'query_required' }, { status: 400 });

  const response = await withDb(async (client) => {
    const access = await getAccessContext(client, request);
    const result = await createKnowledgeRequest(client, {
      query,
      requester: access,
      sourceRequestId: String(body.source_request_id || body.request_id || '') || null,
      priority: cleanPriority(body.priority),
      desiredOutput: cleanDesiredOutput(body.desired_output || body.output),
      missingTopics: cleanStringArray(body.missing_topics || body.missingTopics),
      notes: String(body.notes || '').trim() || null,
      coverage: body.coverage && typeof body.coverage === 'object' ? body.coverage as Record<string, unknown> : {},
      metadata: body.metadata && typeof body.metadata === 'object' ? body.metadata as Record<string, unknown> : {},
      allowDuplicate: Boolean(body.allow_duplicate || body.allowDuplicate),
    });
    return result;
  });

  return Response.json({
    ok: true,
    requestId: id,
    created: response.created,
    request: publicKnowledgeRequest(response.row),
  }, { status: response.created ? 201 : 200 });
}
