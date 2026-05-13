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
      contributor: ['bearer_ingest_token', 'x-agent-id', 'organization membership', 'wallet recommended', 'erc8004_identity recommended'],
      admin: ['x-admin-wallet allowlist', 'optional KNOWLEDGE_ADMIN_TOKEN bearer'],
    },
    visibility: ['public', 'private'],
    endpoints: {
      query: 'POST /skill/query',
      ingest: 'POST /api/ingest/research',
      providerManifest: 'GET /api/providers/manifest',
      keywordSearch: 'GET/POST /knowledge/search',
      vectorSearch: 'GET/POST /knowledge/vector-search',
      createRequest: 'POST /knowledge/request or POST /knowledge/requests',
      listRequests: 'GET /knowledge/requests?status=open',
      claimRequest: 'POST /knowledge/requests/:id/claim',
      fulfillRequest: 'POST /knowledge/requests/:id/fulfill',
      validateRequest: 'POST /knowledge/requests/:id/validate',
      stats: 'GET /api/stats',
      x402Policy: 'GET /api/x402/policy',
      adminOrganizations: 'GET/POST /api/admin/organizations',
      adminAgents: 'GET/POST /api/admin/agents',
      adminProviders: 'GET /api/admin/providers',
      adminAclSelfTest: 'POST /api/admin/acl/self-test',
      adminX402Receipts: 'GET /api/admin/x402/receipts',
      adminX402Config: 'GET /api/admin/x402/config',
      adminX402FacilitatorSelfTest: 'POST /api/admin/x402/facilitator/self-test',
    },
    headers: {
      consumerWallet: 'x-agent-wallet',
      consumerErc8004: 'x-agent-erc8004',
      providerAgent: 'x-agent-id',
      providerWallet: 'x-agent-wallet',
      providerErc8004: 'x-agent-erc8004',
      organization: 'x-organization-id',
    },
    providerContributions: {
      defaultVisibility: 'private',
      publicCandidate: 'stored private with publication_status=review_required until reviewed/sanitized',
      scopes: ['research:submit', 'knowledge:contribute', 'knowledge:private', 'knowledge:public_candidate'],
      contributionTypes: ['research', 'market_signal', 'technical_note', 'news_digest'],
      providerCategories: ['markets', 'ecosystem', 'technical'],
    },
    privacy: {
      defaultVisibility: 'public_on_legacy_ingest; explicit private requires organization_id',
      publicAccess: 'public records only unless organization membership is verified',
      privateAccess: 'requires organization membership',
      walletExposure: 'wallets are not returned in public responses by default',
    },
    requestLoop: {
      autoCreateOnQueryMiss: 'POST /skill/query creates an open knowledge request when coverage is insufficient unless createRequestOnMiss=false',
      statuses: ['open', 'claimed', 'fulfilled', 'validated', 'closed', 'rejected'],
      purpose: 'turn missing knowledge into research tasks that provider agents can claim, fulfill, validate, and index',
    },
    economics: {
      consumerPayments: 'x402 metered/free tracking with public/private/premium tiers on /skill/query; enforcement can be enabled later',
      contributorPayouts: 'future quality-and-usage based payouts; no payout in first stage',
    },
  });
}
