# Provider Sync Runner

`knowledge-provider-sync.js` is the standard runner for provider agents that feed PerkOS Knowledge.

It replaces one-off VPS scripts with a declarative `knowledge.provider.json` file plus a reusable sync command.

## Command

```bash
KNOWLEDGE_INGEST_TOKEN=<token> \
node scripts/knowledge-provider-sync.js --config ./knowledge.provider.json
```

Dry run without sending data:

```bash
node scripts/knowledge-provider-sync.js --config ./knowledge.provider.json --dry-run
```

## Required Config

```json
{
  "baseUrl": "https://knowledge.perkos.xyz",
  "auth": {
    "tokenEnv": "KNOWLEDGE_INGEST_TOKEN"
  },
  "provider": {
    "agentId": "provider-markets",
    "organizationId": "<organization-id>",
    "visibility": "private",
    "source": "provider-markets",
    "contributionType": "market_signal"
  },
  "sources": []
}
```

The provider must already be registered through the Knowledge admin API and must have the required organization membership/scopes.

## Supported Sources

### Knowledge Tree Index

Use this when an agent already produces a `knowledge-tree/index.json` file.

```json
{
  "type": "knowledge-tree-index",
  "indexPath": "./research/knowledge-tree/index.json",
  "sourceRoot": "./research",
  "contributionType": "research_digest"
}
```

### Markdown Directory

Use this for documentation, research notes, reports, and strategy files.

```json
{
  "type": "markdown-directory",
  "dir": "./research",
  "pathPrefix": "research-notes",
  "track": "ecosystem",
  "contributionType": "ecosystem_knowledge",
  "chains": ["multi"]
}
```

### Funding Rates Directory

Use this for JSON funding-rate snapshots.

```json
{
  "type": "funding-rates-directory",
  "dir": "./data/funding-rates",
  "pathPrefix": "funding-rates",
  "track": "markets",
  "contributionType": "market_signal",
  "chains": ["multi"]
}
```

## Standard Behavior

The runner sends:

- `Authorization: Bearer <token>`
- `x-agent-id: <provider.agentId>`
- `x-organization-id: <provider.organizationId>`
- body `visibility`, `organization_id`, `source`, `contribution_type`, and normalized items

Defaults should remain private. Use `public_candidate` only when content should enter review.

## Validation Checklist

After configuring a provider:

1. Run `--dry-run` and inspect item count/first item.
2. Run live sync with the provider token.
3. Verify ingest returns `ok: true`.
4. Verify anonymous queries do not return private items.
5. Verify org-scoped queries return the items.
6. Only then add a cron/timer.
