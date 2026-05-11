export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({
    ok: true,
    name: 'PerkOS Knowledge',
    kind: 'live_agent_skill',
    version: '0.1.0',
    description: 'Visibility-aware operational knowledge service for agents, live skills, and plugins.',
    auth: {
      consumer: ['wallet', 'erc8004_identity', 'x402_receipt_planned'],
      contributor: ['bearer_ingest_token', 'wallet', 'erc8004_identity'],
    },
    visibility: ['public', 'private'],
    endpoints: {
      query: 'POST /skill/query',
      ingest: 'POST /api/ingest/research',
      keywordSearch: 'GET/POST /knowledge/search',
      vectorSearch: 'GET/POST /knowledge/vector-search',
      stats: 'GET /api/stats',
    },
    headers: {
      consumerWallet: 'x-agent-wallet',
      consumerErc8004: 'x-agent-erc8004',
      organization: 'x-organization-id',
    },
    privacy: {
      defaultVisibility: 'public_on_legacy_ingest; explicit private requires organization_id',
      publicAccess: 'public records only unless organization membership is verified',
      privateAccess: 'requires organization membership',
      walletExposure: 'wallets are not returned in public responses by default',
    },
    economics: {
      consumerPayments: 'x402 planned/tracked via receipts',
      contributorPayouts: 'future quality-and-usage based payouts; no payout in first stage',
    },
  });
}
