import { getAccessContext, qdrantAccessFilter, recordUsage, requestId, visibilityCounts } from '../../../lib/access';
import { withDb } from '../../../lib/db';
import { searchVectors } from '../../../lib/vector';

export const dynamic = 'force-dynamic';

type VectorResult = { score: number; payload: Record<string, unknown> };

export async function GET(request: Request) {
  const started = Date.now();
  const id = requestId();
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  const limit = Math.min(Number(url.searchParams.get('limit') || 10), 50);

  if (!q) return Response.json({ ok: false, error: 'q_required' }, { status: 400 });

  const response = await withDb(async (client) => {
    const access = await getAccessContext(client, request);
    const result = await searchVectors(q, limit, qdrantAccessFilter(access));
    const vectorResults = (result.results || []) as VectorResult[];
    const payloads = vectorResults.map((item) => item.payload || {});

    await recordUsage(client, {
      requestId: id,
      access,
      endpoint: '/knowledge/vector-search',
      query: q,
      retrievedItemIds: payloads.map((payload) => String(payload.id || '')).filter(Boolean),
      visibilityCounts: visibilityCounts(payloads as Array<{ visibility?: string }>),
      latencyMs: Date.now() - started,
    });

    return { result, vectorResults };
  });

  return Response.json({
    ok: response.result.ok,
    requestId: id,
    query: q,
    collection: response.result.collection || null,
    count: response.vectorResults.length,
    results: response.vectorResults.map((item) => ({
      score: item.score,
      ...item.payload,
    })),
  });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const params = new URLSearchParams();
  if (body.query) params.set('q', String(body.query));
  if (body.limit) params.set('limit', String(body.limit));
  return GET(new Request(`${request.url}?${params.toString()}`, { headers: request.headers }));
}
