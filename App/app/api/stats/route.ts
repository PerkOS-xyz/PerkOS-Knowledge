import { withDb } from '../../../lib/db';

export const dynamic = 'force-dynamic';

export async function GET() {
  const data = await withDb(async (client) => {
    const [total, bySource, byVisibility, byTrack, byChain, privateByOrg] = await Promise.all([
      client.query('SELECT count(*)::int AS count, max(updated_at) AS last_update FROM research_items'),
      client.query('SELECT \'research-sync\' AS name, count(*)::int AS count, max(updated_at) AS last_update FROM research_items'),
      client.query('SELECT visibility AS name, count(*)::int AS count FROM research_items GROUP BY visibility ORDER BY count DESC'),
      client.query('SELECT coalesce(track,\'unknown\') AS name, count(*)::int AS count FROM research_items GROUP BY 1 ORDER BY count DESC'),
      client.query('SELECT chain AS name, count(*)::int AS count FROM research_items, unnest(chains) AS chain GROUP BY chain ORDER BY count DESC'),
      client.query(`
        SELECT coalesce(organization_id, 'public') AS name, count(*)::int AS count
        FROM research_items
        WHERE visibility = 'private'
        GROUP BY 1
        ORDER BY count DESC
      `),
    ]);

    return {
      totalItems: total.rows[0].count,
      lastUpdate: total.rows[0].last_update,
      bySource: bySource.rows,
      byVisibility: byVisibility.rows,
      byTrack: byTrack.rows,
      byChain: byChain.rows,
      privateByOrg: privateByOrg.rows,
    };
  });

  return Response.json({ ok: true, ...data, ts: new Date().toISOString() });
}
