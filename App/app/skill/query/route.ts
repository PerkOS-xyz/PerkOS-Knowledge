import { getAccessContext, recordUsage, requestId, sanitizeKnowledgeRow, visibilityCounts } from '../../../lib/access';
import { withDb } from '../../../lib/db';
import { hybridSearch } from '../../../lib/hybrid';
import { recordAttributions } from '../../../lib/attribution';
import { credit, debit, isExempt } from '../../../lib/credits';
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
  // Default to "standard" (rank-by-quality, no hard floor) rather than
  // "enterprise" (confidence >= 45). The quality rubric (lib/quality.ts)
  // only awards >=45 to items with attached evidence + validation, so an
  // enterprise default returns NOTHING for an unvalidated research corpus —
  // callers see an empty knowledge base. Standard returns the best-ranked
  // matches with the honest `quality.warning` + per-item confidence/trust
  // signals; callers that need a guarantee opt in with qualityMode
  // "enterprise" or "validated_only". Override via KNOWLEDGE_DEFAULT_QUALITY_MODE.
  const qualityMode = String(
    body.qualityMode || body.quality_mode || process.env.KNOWLEDGE_DEFAULT_QUALITY_MODE || 'standard',
  );
  const requireValidated = body.requireValidated === true || body.require_validated === true || qualityMode === 'validated_only';
  const minConfidence = Math.max(0, Math.min(Number(body.minConfidence ?? body.min_confidence ?? (qualityMode === 'enterprise' ? 45 : 0)), 100));

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

    // Credit-mode billing: debit the consumer's prepaid balance before doing any
    // work, unless the agent/wallet is whitelisted (exempt). `chargedAmount` is
    // what actually entered our ledger and is what gets split to providers.
    // metered_free / enforce modes skip this entirely (chargedAmount stays 0).
    let chargedAmount = 0;
    const price = Number(policy.price.amount || 0);
    if (policy.mode === 'credit' && price > 0 && !(await isExempt(client, access.agentId, access.wallet))) {
      if (!access.wallet) {
        return { paymentRequired: true as const, policy, x402, rows: [], creditError: 'wallet_required' as const };
      }
      const charged = await debit(client, { wallet: access.wallet, agentId: access.agentId, amount: price, reason: 'query', requestId: id });
      if (!charged.ok) {
        return { paymentRequired: true as const, policy, x402, rows: [], creditError: 'insufficient_credit' as const, balance: charged.balance, price };
      }
      chargedAmount = price;
    }

    const receiptId = await storeX402Receipt(client, { x402, policy, access, endpoint: '/skill/query' });

    // Hybrid retrieval: lexical (BM25/Postgres FTS) + semantic (Qdrant
    // vector) recall merged with Reciprocal Rank Fusion. ACL + quality are
    // re-enforced authoritatively in Postgres when the fused union is
    // hydrated, so the vector leg can only ADD recall, never widen access.
    // Degrades to BM25-only when Qdrant / OpenAI embeddings aren't configured.
    const { rows, vectorUsed } = await hybridSearch(client, {
      query,
      access,
      limit,
      requireValidated,
      minConfidence,
    });

    // Touch last_used_at for retrieved rows so the lifecycle sweep
    // (lib/lifecycleSweep.ts, Rule 3 "recently used") keeps them in
    // the working tier instead of archiving hot items.
    if (rows.length) {
      await client.query(
        `UPDATE research_items SET last_used_at = NOW() WHERE id = ANY($1::text[])`,
        [rows.map((row) => row.id)],
      );
    }

    const coverage = {
      status: rows.length >= minCoverageResults ? 'sufficient' : 'insufficient',
      minResults: minCoverageResults,
      resultCount: rows.length,
      requestCreated: false,
    };

    const knowledgeRequest = createRequestOnMiss && rows.length < minCoverageResults
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
      retrievedItemIds: rows.map((row) => row.id),
      visibilityCounts: visibilityCounts(rows),
      latencyMs: Date.now() - started,
      x402ReceiptId: receiptId,
      amountPaid: chargedAmount,
      paymentChain: policy.price.chain,
      paymentToken: policy.price.token,
      successStatus: rows.length < minCoverageResults ? 'coverage_insufficient' : 'ok',
    });

    // Supply-side: credit the contributors of the consumed items. Best-effort —
    // an attribution-ledger write must never break serving the consumer's query.
    try {
      const attr = await recordAttributions(client, {
        requestId: id,
        endpoint: '/skill/query',
        access,
        retrievedItemIds: rows.map((row) => row.id),
        amountPaid: chargedAmount,
        chain: policy.price.chain,
        token: policy.price.token,
        x402ReceiptId: receiptId,
      });
      // Move the split amount into each provider's prepaid balance (earnings).
      for (const c of attr.creditedByWallet) {
        await credit(client, {
          wallet: c.wallet,
          agentId: c.agentId,
          amount: c.amount,
          reason: 'attribution',
          requestId: id,
          earned: true,
        });
      }
    } catch {
      // attribution/credit is secondary to the response — swallow and move on
    }

    return { paymentRequired: false as const, policy, x402, rows, vectorUsed, coverage: { ...coverage, requestCreated: Boolean(knowledgeRequest?.created) }, knowledgeRequest };
  });

  if (result.paymentRequired) {
    if ('creditError' in result && result.creditError) {
      return Response.json(
        {
          ok: false,
          error: result.creditError,
          balance: 'balance' in result ? result.balance : null,
          price: 'price' in result ? result.price : null,
          currency: result.policy.price.currency,
        },
        { status: 402 },
      );
    }
    return Response.json({ ok: false, error: 'payment_required', x402: publicX402(result.policy, result.x402) }, { status: 402 });
  }

  return Response.json({
    ok: true,
    requestId: id,
    mode,
    query,
    count: result.rows.length,
    retrieval: { mode: result.vectorUsed ? 'hybrid' : 'bm25', vectorLeg: result.vectorUsed },
    coverage: result.coverage,
    quality: {
      mode: qualityMode,
      requireValidated,
      minConfidence,
      warning: result.rows.some((row) => row.validation_status !== 'validated')
        ? 'Some returned context is not independently validated; use confidencePercent/trustTier and citations before relying on it.'
        : null,
    },
    context: result.rows.map(sanitizeKnowledgeRow),
    knowledgeRequest: result.knowledgeRequest ? {
      created: result.knowledgeRequest.created,
      request: publicKnowledgeRequest(result.knowledgeRequest.row),
    } : null,
    x402: publicX402(result.policy, result.x402),
    guidance: 'Use this context with your own LLM/runtime. Knowledge does not require a specific model provider.',
  });
}
