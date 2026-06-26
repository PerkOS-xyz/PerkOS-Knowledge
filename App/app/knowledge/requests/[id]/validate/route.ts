import { withDb } from '../../../../../lib/db';
import { getProviderIdentity } from '../../../../../lib/providers';
import { publicKnowledgeRequest } from '../../../../../lib/requests';
import { assertValidatorIndependent, certifyResearchItems, type CertifiedItem } from '../../../../../lib/validation';

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
  const validatorAgentId = identity.agentId; // narrowed to string; survives the async closure

  const accepted = body.accepted !== false;
  const notes = String(body.notes || body.validation_notes || '').trim() || null;

  const response = await withDb(async (client) => {
    const agent = await client.query(`SELECT id, status FROM agents WHERE id = $1`, [identity.agentId]);
    if (!agent.rowCount || agent.rows[0].status !== 'active') return { error: 'validator_agent_not_registered_or_inactive', status: 403 } as const;

    // Load the request first — its fulfiller + items drive the independence
    // guard and the item certification.
    const reqRow = await client.query(`SELECT * FROM knowledge_requests WHERE id = $1`, [id]);
    if (!reqRow.rowCount) return { error: 'request_not_found', status: 404 } as const;
    const req = reqRow.rows[0];
    if (req.status !== 'fulfilled') return { error: 'request_not_fulfilled', status: 409, row: req } as const;

    const itemIds: string[] = Array.isArray(req.fulfillment_item_ids) ? req.fulfillment_item_ids.filter(Boolean) : [];

    // Independent validation: an accepting validator may not be the fulfiller or
    // a contributor of the items being certified (no self-approval).
    if (accepted) {
      let contributorIds: Array<string | null> = [];
      if (itemIds.length) {
        const c = await client.query(`SELECT contributor_agent_id FROM research_items WHERE id = ANY($1::text[])`, [itemIds]);
        contributorIds = c.rows.map((r) => r.contributor_agent_id);
      }
      const indep = assertValidatorIndependent({
        validatorAgentId,
        fulfilledByAgentId: req.fulfilled_by_agent_id,
        contributorAgentIds: contributorIds,
      });
      if (!indep.ok) return { error: indep.reason, status: 403, row: req } as const;
    }

    const result = await client.query(
      `UPDATE knowledge_requests
       SET status = $2,
           validator_agent_id = $3,
           validation_notes = $4,
           validated_at = now(),
           updated_at = now()
       WHERE id = $1 AND status = 'fulfilled'
       RETURNING *`,
      [id, accepted ? 'validated' : 'rejected', identity.agentId, notes]
    );
    if (!result.rowCount) {
      // Raced past 'fulfilled' between our read and write.
      const existing = await client.query(`SELECT * FROM knowledge_requests WHERE id = $1`, [id]);
      return { error: 'request_not_fulfilled', status: 409, row: existing.rows[0] } as const;
    }

    // Accepting a request promotes its fulfillment items to validated knowledge
    // (independently certified) so the enterprise / validated_only tier returns them.
    let certified: CertifiedItem[] = [];
    if (accepted && itemIds.length) {
      certified = await certifyResearchItems(client, { itemIds, validatorAgentId });
    }
    return { row: result.rows[0], certified } as const;
  });

  if ('error' in response) {
    return Response.json({ ok: false, error: response.error, request: response.row ? publicKnowledgeRequest(response.row) : undefined }, { status: response.status });
  }

  return Response.json({
    ok: true,
    request: publicKnowledgeRequest(response.row),
    certified: response.certified,
    certifiedCount: response.certified.filter((c) => c.validationStatus === 'validated').length,
  });
}
