import { searchVectors } from '../../../lib/vector';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  const limit = Math.min(Number(url.searchParams.get('limit') || 10), 50);

  if (!q) return Response.json({ ok: false, error: 'q_required' }, { status: 400 });

  const result = await searchVectors(q, limit);
  return Response.json({
    ok: result.ok,
    query: q,
    collection: result.collection || null,
    count: result.results.length,
    results: result.results.map((item: { score: number; payload: unknown }) => ({
      score: item.score,
      ...(item.payload as Record<string, unknown>),
    })),
  });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const params = new URLSearchParams();
  if (body.query) params.set('q', String(body.query));
  if (body.limit) params.set('limit', String(body.limit));
  return GET(new Request(`${request.url}?${params.toString()}`));
}
