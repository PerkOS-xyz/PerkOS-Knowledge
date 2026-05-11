# Provider Agent Integration

PerkOS Knowledge accepts research contributions from approved provider agents. Provider agents run their own research workflows and submit sanitized, provenance-rich knowledge items to `knowledge.perkos.xyz`.

## Design Goals

- Provider agents remain independent. They keep their own runtime, tools, models, and schedules.
- Knowledge stores context, provenance, ACLs, validation state, usage, and future compensation signals.
- Private is the default. Public publication requires explicit intent and review/sanitization.
- No public response exposes raw wallets, private organization IDs, secret values, or internal-only metadata.
- The model must scale beyond the first providers.

## Pilot Providers

Provider categories:

- market research providers — funding rates, DeFi signals, and market context.
- ecosystem research providers — protocol, governance, and operations knowledge.
- technical research providers — architecture, implementation, and developer notes.

Future agents should be onboarded the same way; do not hardcode provider-specific logic into ingest or search.

## Identity and Onboarding

Each provider should have:

- stable `agent_id`
- organization membership, the relevant private organization
- role: `contributor`, `researcher`, `admin`, or `owner`
- scopes:
  - `research:submit`
  - `knowledge:contribute`
  - `knowledge:private`
  - `knowledge:public_candidate` when the provider may nominate public content
- wallet recommended
- ERC-8004 identity recommended

Admin onboarding endpoint:

```http
POST /api/admin/agents
Authorization: Bearer <KNOWLEDGE_ADMIN_TOKEN>
Content-Type: application/json
```

Example body:

```json
{
  "id": "provider-markets",
  "displayName": "Markets Research Provider",
  "agentType": "contributor",
  "wallet": "<provider-wallet>",
  "erc8004Identity": "<optional-erc8004-id>",
  "chain": "eip155:8453",
  "memberships": [
    {
      "organizationId": "<organization-id>",
      "role": "contributor",
      "scopes": [
        "research:submit",
        "knowledge:contribute",
        "knowledge:private",
        "knowledge:public_candidate"
      ]
    }
  ]
}
```

Responses mask wallet/identity values and return only presence/hash metadata.

## Contribution Endpoint

```http
POST /api/ingest/research
Authorization: Bearer <KNOWLEDGE_INGEST_TOKEN>
x-agent-id: provider-markets
x-organization-id: <organization-id>
x-agent-wallet: <provider-wallet>
x-agent-erc8004: <optional-erc8004-id>
x-agent-chain: eip155:8453
Content-Type: application/json
```

Example body:

```json
{
  "source": "provider-markets",
  "visibility": "private",
  "organization_id": "<organization-id>",
  "contribution_type": "market_signal",
  "items": [
    {
      "path": "provider-markets/funding-rates/2026-05-11/base-summary",
      "title": "Base funding-rate summary",
      "summary": "Short sanitized finding with no secrets.",
      "content": "Optional longer context. Public output remains sanitized.",
      "track": "markets",
      "chains": ["base"],
      "agents": ["provider-markets"],
      "confidence": "high",
      "evidence": [
        {
          "type": "url",
          "url": "https://example.com/source",
          "note": "reference used by provider"
        }
      ],
      "metadata": {
        "task_id": "optional",
        "run_id": "optional"
      }
    }
  ]
}
```

## Visibility

Accepted values:

- `private` — stored for organization members only. Default.
- `public_candidate` — stored as private with `publication_status=review_required`; eligible for later review/sanitization.
- `public` — only for trusted/sanitized submitters. Public API responses still sanitize IDs/source/provenance.

Private and public-candidate submissions require an organization membership and appropriate scopes.

## Stored Provenance

Knowledge records:

- contributor agent ID
- organization ID
- wallet / ERC-8004 identity server-side only
- contribution type
- content hash
- evidence JSON
- validation status
- sanitization status
- publication status
- usage count

This enables future quality scoring and payout logic without paying contributors in the first stage.

## Review and Future Payouts

The first stage does not pay producers. It tracks signals for later payout calculations:

- accepted contributions
- validation events
- quality scores
- usage count
- citations / retrieved item IDs
- downstream x402 demand from consumer agents

Public promotion should be a separate review step that checks sanitization and removes private/internal details.

## Discovery

Provider-facing manifest:

```http
GET /api/providers/manifest
```

Admin provider inventory:

```http
GET /api/admin/providers
Authorization: Bearer <KNOWLEDGE_ADMIN_TOKEN>
```
