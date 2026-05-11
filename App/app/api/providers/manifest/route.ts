export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({
    ok: true,
    name: 'PerkOS Knowledge Provider Agent Integration',
    version: '0.1.0',
    purpose: 'Allow approved research agents to contribute private or public-candidate knowledge with provenance.',
    providerModel: {
      identity: ['stable agent_id', 'wallet recommended', 'erc8004_identity recommended', 'organization membership'],
      defaultVisibility: 'private',
      publicationFlow: {
        private: 'stored for the provider organization only',
        public_candidate: 'stored private with publication_status=review_required until reviewed/sanitized',
        public: 'accepted only from trusted/sanitized submitters; public responses remain sanitized',
      },
      futureCompensation: 'contribution quality, validation, citations, usage_count, and x402-attributed demand can feed future payout logic',
    },
    auth: {
      required: ['Authorization: Bearer <KNOWLEDGE_INGEST_TOKEN>', 'x-agent-id'],
      recommended: ['x-organization-id', 'x-agent-wallet', 'x-agent-erc8004', 'x-agent-chain'],
      scopes: ['research:submit', 'knowledge:contribute', 'knowledge:private', 'knowledge:public_candidate'],
    },
    endpoints: {
      submitResearch: 'POST /api/ingest/research',
      providerManifest: 'GET /api/providers/manifest',
      adminOnboardAgent: 'POST /api/admin/agents',
      adminListProviders: 'GET /api/admin/providers',
    },
    submitShape: {
      source: 'provider-agent-name',
      visibility: 'private | public_candidate | public',
      organization_id: '<organization-id>',
      contribution_type: 'research | market_signal | technical_note | news_digest | custom',
      items: [
        {
          path: 'provider/run-or-topic/stable-id',
          title: 'Short title',
          summary: 'Sanitized summary or finding',
          content: 'Optional longer content; stored but public output remains sanitized',
          track: 'markets | protocol | architecture | operations | custom',
          chains: ['base'],
          agents: ['provider-agent-id'],
          confidence: 'high | medium | low or numeric string',
          evidence: [{ type: 'url', url: 'https://example.com', note: 'source note' }],
          metadata: { task_id: 'optional', run_id: 'optional' },
        },
      ],
    },
    providerCategories: [
      { category: 'markets', focus: 'funding rates, DeFi signals, market context' },
      { category: 'ecosystem', focus: 'protocol, governance, operations knowledge' },
      { category: 'technical', focus: 'architecture, implementation, developer research' },
    ],
  });
}
