import { withDb } from '../../../lib/db';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const q = (url.searchParams.get('q') || '').trim();
  const agent = (url.searchParams.get('agent') || '').trim();
  const limit = Math.min(Number(url.searchParams.get('limit') || 10), 50);

  const results = await withDb(async (client) => {
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

    params.push(limit);
    const sql = `
      SELECT source, date, track, title, path, agents, chains, status, confidence, summary, updated_at
      FROM research_items
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY date DESC NULLS LAST, updated_at DESC
      LIMIT $${params.length}
    `;

    const res = await client.query(sql, params);
    return res.rows;
  });

  return Response.json({ ok: true, query: q || null, agent: agent || null, count: results.length, results });
}

export async function POST(request: Request) {
  const body = await request.json().catch(() => ({}));
  const params = new URLSearchParams();
  if (body.query) params.set('q', String(body.query));
  if (body.agent) params.set('agent', String(body.agent));
  if (body.limit) params.set('limit', String(body.limit));
  return GET(new Request(`${request.url}?${params.toString()}`));
}
