import { withDb } from '../../../../lib/db';

export const dynamic = 'force-dynamic';

type ResearchItem = {
  date?: string;
  track?: string;
  title?: string;
  path?: string;
  agents?: string[];
  chains?: string[];
  status?: string;
  confidence?: string;
  summary?: string;
};

function unauthorized() {
  return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
}

export async function POST(request: Request) {
  const token = process.env.KNOWLEDGE_INGEST_TOKEN;
  if (!token) return Response.json({ ok: false, error: 'ingest_not_configured' }, { status: 503 });

  const auth = request.headers.get('authorization') || '';
  if (auth !== `Bearer ${token}`) return unauthorized();

  const body = await request.json();
  const source = String(body.source || 'unknown');
  const items = Array.isArray(body.items) ? body.items as ResearchItem[] : [];

  if (!items.length) {
    return Response.json({ ok: false, error: 'items_required' }, { status: 400 });
  }

  const result = await withDb(async (client) => {
    let upserted = 0;
    for (const item of items) {
      const path = String(item.path || '').trim();
      const title = String(item.title || path || 'Untitled').trim();
      if (!path) continue;
      const id = `${source}:${path}`;
      await client.query(
        `INSERT INTO research_items
          (id, source, date, track, title, path, agents, chains, status, confidence, summary, raw, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,now())
         ON CONFLICT (id) DO UPDATE SET
          source = EXCLUDED.source,
          date = EXCLUDED.date,
          track = EXCLUDED.track,
          title = EXCLUDED.title,
          path = EXCLUDED.path,
          agents = EXCLUDED.agents,
          chains = EXCLUDED.chains,
          status = EXCLUDED.status,
          confidence = EXCLUDED.confidence,
          summary = EXCLUDED.summary,
          raw = EXCLUDED.raw,
          updated_at = now()`,
        [
          id,
          source,
          item.date || null,
          item.track || null,
          title,
          path,
          item.agents || [],
          item.chains || [],
          item.status || null,
          item.confidence || null,
          item.summary || null,
          item,
        ]
      );
      upserted += 1;
    }
    const count = await client.query('SELECT count(*)::int AS count FROM research_items');
    return { upserted, total: count.rows[0].count };
  });

  return Response.json({ ok: true, source, ...result, ts: new Date().toISOString() });
}
