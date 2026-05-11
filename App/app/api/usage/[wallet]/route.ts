import { withDb } from '../../../../lib/db';
import { isAllowedWallet } from '../../../../lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ wallet: string }> }) {
  const { wallet } = await context.params;
  const allowed = isAllowedWallet(wallet);
  if (!allowed) return Response.json({ ok: false, error: 'wallet_not_allowed' }, { status: 403 });

  const data = await withDb(async (client) => {
    const [total, byTrack, byChain] = await Promise.all([
      client.query('SELECT count(*)::int AS count, max(updated_at) AS last_update FROM research_items'),
      client.query('SELECT coalesce(track,\'unknown\') AS name, count(*)::int AS count FROM research_items GROUP BY 1 ORDER BY count DESC'),
      client.query('SELECT chain AS name, count(*)::int AS count FROM research_items, unnest(chains) AS chain GROUP BY chain ORDER BY count DESC'),
    ]);

    return {
      knowledgeItemsAvailable: total.rows[0].count,
      lastKnowledgeUpdate: total.rows[0].last_update,
      byTrack: byTrack.rows,
      byChain: byChain.rows,
    };
  });

  return Response.json({
    ok: true,
    access: {
      status: 'allowed',
      method: 'wallet_allowlist',
      dashboard: true,
    },
    knowledge: data,
    metering: {
      status: 'not_connected',
      message: 'No live request/payment meter is connected yet.',
      keywordSearches: null,
      vectorSearches: null,
      briefsGenerated: null,
      totalPaidUsd: null,
      pendingSettlementUsd: null,
    },
    ts: new Date().toISOString(),
  });
}
