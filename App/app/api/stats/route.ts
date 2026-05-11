import { withDb } from '../../../lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  const data = await withDb(async (client) => {
    const [total, byTrack, byAgent, byChain, latest] = await Promise.all([
      client.query('SELECT count(*)::int AS count, max(updated_at) AS last_update FROM research_items'),
      client.query('SELECT coalesce(track,\'unknown\') AS name, count(*)::int AS count FROM research_items GROUP BY 1 ORDER BY count DESC'),
      client.query('SELECT agent AS name, count(*)::int AS count FROM research_items, unnest(agents) AS agent GROUP BY agent ORDER BY count DESC'),
      client.query('SELECT chain AS name, count(*)::int AS count FROM research_items, unnest(chains) AS chain GROUP BY chain ORDER BY count DESC'),
      client.query('SELECT source, date, track, title, path, agents, chains, summary, updated_at FROM research_items ORDER BY updated_at DESC, date DESC NULLS LAST LIMIT 12'),
    ]);
    return {
      totalItems: total.rows[0].count,
      lastUpdate: total.rows[0].last_update,
      byTrack: byTrack.rows,
      byAgent: byAgent.rows,
      byChain: byChain.rows,
      latest: latest.rows,
    };
  });

  return Response.json({ ok: true, ...data, ts: new Date().toISOString() });
}
