import { withDb } from '../../../../../lib/db';
import { getProviderIdentity } from '../../../../../lib/providers';
import { cleanStringArray, publicKnowledgeRequest } from '../../../../../lib/requests';

export const dynamic = 'force-dynamic';

type Params = { params: Promise<{ id: string }> }; 

function unauthorized() {
  return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
}

export async function POST(request: Request, { params }: Params) {
  const { id } = await params;
  const token = process.env.KNOWLEDGE_INGEST_TOKEN;
  if (!token) return Response.json({ ok: false, error: 'ingest_not_configured' }, { status: 503 });
  if ((request.headers.get('authorization') || '') !== `Bearer ${token}`) return unauthorized();

  const body = await request.json().catch(() => ({}));
  const identity = getProviderIdentity(request, body);
  if (!identity.agentId) return Response.json({ ok: false, error: 'x_agent_id_required' }, { status: 400 });

  const itemIds = cleanStringArray(body.research_item_ids || body.researchItemIds || body.item_ids || body.itemIds, 50);
  const notes = String(body.notes || '').trim() || null;
  if (!itemIds.length && !notes) {
    return Response.json({ ok: false, error: 'research_item_ids_or_notes_required' }, { status: 400 });
  }

  const response = await withDb(async (client) => {
    const agent = await client.query(`SELECT id, status FROM agents WHERE id = $1`, [identity.agentId]);
    if (!agent.rowCount || agent.rows[0].status !== 'active') return { error: 'provider_agent_not_registered_or_inactive', status: 403 } as const;

    if (itemIds.length) {
      const found = await client.query(`SELECT id FROM research_items WHERE id = ANY($1::text[])`, [itemIds]);
      if (found.rowCount !== itemIds.length) return { error: 'one_or_more_research_items_not_found', status: 400 } as const;
    }

    const result = await client.query(
      `UPDATE knowledge_requests
       SET status = 'fulfilled',
           fulfilled_by_agent_id = $2,
           fulfillment_item_ids = $3,
           notes = coalesce($4, notes),
           fulfilled_at = now(),
           updated_at = now()
       WHERE id = $1 AND status IN ('open', 'claimed')
       RETURNING *`,
      [id, identity.agentId, itemIds, notes]
    );
    if (!result.rowCount) {
      const existing = await client.query(`SELECT * FROM knowledge_requests WHERE id = $1`, [id]);
      if (!existing.rowCount) return { error: 'request_not_found', status: 404 } as const;
      return { error: 'request_not_open_or_claimed', status: 409, row: existing.rows[0] } as const;
    }
    return { row: result.rows[0] } as const;
  });

  if ('error' in response) {
    return Response.json({ ok: false, error: response.error, request: response.row ? publicKnowledgeRequest(response.row) : undefined }, { status: response.status });
  }

  return Response.json({ ok: true, request: publicKnowledgeRequest(response.row) });
}
