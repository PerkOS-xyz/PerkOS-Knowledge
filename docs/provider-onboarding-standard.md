# Provider Onboarding Standard

This document defines the standard contract for agents that feed research or operational knowledge into PerkOS Knowledge.

## Provider Profile

Every provider agent needs a stable profile before ingesting:

```json
{
  "id": "provider-markets",
  "displayName": "Markets Research Provider",
  "agentType": "contributor",
  "metadata": {
    "providerCategory": "markets",
    "identityStatus": "wallet_pending"
  },
  "memberships": [
    {
      "organizationId": "<organization-id>",
      "role": "contributor",
      "scopes": [
        "research:submit",
        "knowledge:contribute",
        "knowledge:private",
        "knowledge:public_candidate",
        "ingest"
      ]
    }
  ]
}
```

Do not invent wallet or ERC-8004 values. Add them only when the provider has a real wallet/identity.

## Required Onboarding Flow

1. Create or verify the organization.
2. Register the provider via `POST /api/admin/agents`.
3. Assign scopes and membership.
4. Configure the provider runtime with ingest credentials.
5. Send a private test item.
6. Verify anonymous users cannot retrieve it.
7. Verify an org member/provider can retrieve it.
8. Only then enable scheduled ingest.

## Required Ingest Headers

```http
Authorization: Bearer <KNOWLEDGE_INGEST_TOKEN>
x-agent-id: <stable-agent-id>
x-organization-id: <organization-id>
```

Optional when real identity exists:

```http
x-agent-wallet: <wallet>
x-agent-erc8004: <erc8004-identity>
x-agent-chain: <chain-caip>
```

## Body Defaults

Provider submissions should default to private org-scoped knowledge:

```json
{
  "source": "provider-markets",
  "visibility": "private",
  "organization_id": "<organization-id>",
  "contribution_type": "market_signal",
  "items": []
}
```

Use `public_candidate` only for content that should enter review. Provider agents should not publish directly unless explicitly trusted.

## Item Requirements

Each item should include:

- stable `path`
- `title`
- `summary`
- optional `content`
- `track`
- `chains`
- `confidence`
- `evidence`
- `metadata`

`path` must be deterministic so retries upsert rather than duplicate.

## Publication Rule

- `private` stays organization-scoped.
- `public_candidate` is stored private with `publication_status=review_required`.
- `public` requires explicit sanitization and trusted submitter policy.

## Validation Rule

A provider adapter is not complete until these checks pass:

- provider is active in `/api/admin/providers`
- ingest returns `ok: true`
- anonymous query does not return private item
- org-scoped query returns the private item
- scheduled job logs show successful sync
