import { isAllowedWallet, normalizeWallet } from '../../../../lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ wallet: string }> }) {
  const { wallet } = await context.params;
  const allowed = isAllowedWallet(wallet);
  if (!allowed) return Response.json({ ok: false, error: 'wallet_not_allowed' }, { status: 403 });

  return Response.json({
    ok: true,
    wallet: normalizeWallet(wallet),
    plan: 'founder-preview',
    agents: [
      { name: 'Research Index', role: 'curated knowledge base', status: 'syncing hourly', calls: 54 },
      { name: 'Mimir', role: 'strategy brief', status: 'ready', calls: 40 },
      { name: 'Tyr', role: 'protocol/build brief', status: 'ready', calls: 40 },
      { name: 'Bragi', role: 'content brief', status: 'ready', calls: 40 },
      { name: 'Idunn', role: 'product/UX brief', status: 'ready', calls: 40 },
      { name: 'NEO', role: 'non-EVM research', status: 'ready', calls: 31 }
    ],
    x402: {
      status: 'planned',
      totalPaidUsd: 0,
      totalRequests: 0,
      pendingSettlementUsd: 0,
      note: 'x402 payment metering is scaffolded; live facilitator integration comes next.'
    },
    usage: {
      knowledgeItemsAvailable: 54,
      keywordSearches: 0,
      vectorSearches: 0,
      briefsGenerated: 0
    },
    ts: new Date().toISOString()
  });
}
