import { withDb } from '../../../../lib/db';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ agent: string }> }) {
  const { agent } = await context.params;
  const normalized = agent.toLowerCase();

  const rows = await withDb(async (client) => {
    const res = await client.query(
      `SELECT source, date, track, title, path, agents, chains, summary, updated_at
       FROM research_items
       WHERE lower($1) = ANY(SELECT lower(unnest(agents)))
       ORDER BY date DESC NULLS LAST, updated_at DESC
       LIMIT 40`,
      [normalized]
    );
    return res.rows;
  });

  return Response.json({ ok: true, agent: normalized, count: rows.length, items: rows });
}
