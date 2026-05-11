import { requireAdmin } from '../../../../../lib/admin';
import { withDb } from '../../../../../lib/db';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const blocked = requireAdmin(request);
  if (blocked) return blocked;

  const url = new URL(request.url);
  const limit = Math.min(Number(url.searchParams.get('limit') || 50), 100);

  const receipts = await withDb(async (client) => {
    const res = await client.query(
      `SELECT id, consumer_agent_id, organization_id, endpoint, amount, currency, chain, token, status, created_at
       FROM x402_receipts
       ORDER BY created_at DESC
       LIMIT $1`,
      [limit]
    );
    return res.rows;
  });

  return Response.json({
    ok: true,
    count: receipts.length,
    receipts: receipts.map((row) => ({
      id: row.id,
      consumerAgentId: row.consumer_agent_id,
      organizationId: row.organization_id,
      endpoint: row.endpoint,
      amount: row.amount,
      currency: row.currency,
      chain: row.chain,
      token: row.token === 'not_configured' ? 'not_configured' : 'configured',
      status: row.status,
      createdAt: row.created_at,
    })),
  });
}
