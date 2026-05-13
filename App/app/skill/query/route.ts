import { getAccessContext, readableKnowledgeWhere, recordUsage, requestId, sanitizeKnowledgeRow, visibilityCounts } from '../../../lib/access';
import { withDb } from '../../../lib/db';
import { cleanDesiredOutput, cleanPriority, cleanStringArray, createKnowledgeRequest, publicKnowledgeRequest } from '../../../lib/requests';
import { getX402Policy, inspectX402Request, isX402Satisfied, publicX402, resolveX402Tier, storeX402Receipt, verifyX402WithFacilitator } from '../../../lib/x402';

export const dynamic = 'force-dynamic';

export async function POST(request: Request) {
  const started = Date.now();
  const id = requestId();
  const body = await request.json().catch(() => ({}));
  const query = String(body.query || body.question || '').trim();
  const limit = Math.min(Number(body.limit || 8), 25);
  const mode = String(body.mode || 'context');
  const minCoverageResults = Math.max(1, Math.min(Number(body.minCoverageResults || body.min_coverage_results || 1), 10));
  const createRequestOnMiss = body.createRequestOnMiss !== false && body.create_request_on_miss !== false;

  if (!query) return Response.json({ ok: false, error: 'query_required' }, { status: 400 });

  const result = await withDb(async (client) => {
    const access = await getAccessContext(client, request);
    const requestedOrg = Boolean(request.headers.get('x-organization-id') || request.headers.get('x-org-id'));
    const tier = resolveX402Tier({ requestedTier: body.tier || body.scope, hasOrganizationScope: requestedOrg || access.organizationIds.length > 0, mode });
    const policy = getX402Policy('/skill/query', tier);
    const inspected = inspectX402Request(request, policy);
    const x402 = await verifyX402WithFacilitator(inspected, policy);

    if (!isX402Satisfied(policy, x402)) {
      return { paymentRequired: true as const, policy, x402, rows: [] };
    }
    const params: unknown[] = [query];
    const acl = readableKnowledgeWhere(access, params);
    acl.params.push(limit);

    const receiptId = await storeX402Receipt(client, { x402, policy, access, endpoint: '/skill/query' });

    const res = await client.query(
      `SELECT id, title, summary, track, chains, path, visibility, organization_id,
              validation_status, sanitization_status, quality_score, usage_count, updated_at
       FROM research_items
       WHERE to_tsvector('english', coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(track,'') || ' ' || coalesce(path,'')) @@ plainto_tsquery('english', $1)
         AND ${acl.sql}
       ORDER BY quality_score DESC NULLS LAST, usage_count DESC, updated_at DESC
       LIMIT $${acl.params.length}`,
      acl.params
    );

    const coverage = {
      status: res.rows.length >= minCoverageResults ? 'sufficient' : 'insufficient',
      minResults: minCoverageResults,
      resultCount: res.rows.length,
      requestCreated: false,
    };

    const knowledgeRequest = createRequestOnMiss && res.rows.length < minCoverageResults
      ? await createKnowledgeRequest(client, {
          query,
          requester: access,
          sourceRequestId: id,
          priority: cleanPriority(body.priority),
          desiredOutput: cleanDesiredOutput(body.desired_output || body.output || mode),
          missingTopics: cleanStringArray(body.missing_topics || body.missingTopics),
          notes: String(body.notes || '').trim() || null,
          coverage,
          metadata: { endpoint: '/skill/query', mode, autoCreated: true },
        })
      : null;

    await recordUsage(client, {
      requestId: id,
      access,
      endpoint: '/skill/query',
      query,
      retrievedItemIds: res.rows.map((row) => row.id),
      visibilityCounts: visibilityCounts(res.rows),
      latencyMs: Date.now() - started,
      x402ReceiptId: receiptId,
      amountPaid: receiptId ? Number(policy.price.amount || 0) : 0,
      paymentChain: policy.price.chain,
      paymentToken: policy.price.token,
      successStatus: res.rows.length < minCoverageResults ? 'coverage_insufficient' : 'ok',
    });

    return { paymentRequired: false as const, policy, x402, rows: res.rows, coverage: { ...coverage, requestCreated: Boolean(knowledgeRequest?.created) }, knowledgeRequest };
  });

  if (result.paymentRequired) {
    return Response.json({ ok: false, error: 'payment_required', x402: publicX402(result.policy, result.x402) }, { status: 402 });
  }

  return Response.json({
    ok: true,
    requestId: id,
    mode,
    query,
    count: result.rows.length,
    coverage: result.coverage,
    context: result.rows.map(sanitizeKnowledgeRow),
    knowledgeRequest: result.knowledgeRequest ? {
      created: result.knowledgeRequest.created,
      request: publicKnowledgeRequest(result.knowledgeRequest.row),
    } : null,
    x402: publicX402(result.policy, result.x402),
    guidance: 'Use this context with your own LLM/runtime. Knowledge does not require a specific model provider.',
  });
}
