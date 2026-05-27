# Agent Integration Overview

This document explains how agents should understand and integrate with PerkOS Knowledge.

Use it as the repo-level map before reading the implementation docs:

- `README.md` explains the service, architecture, public endpoints, and privacy boundary.
- `docs/provider-agent-integration.md` explains provider onboarding and contribution payloads.
- `docs/provider-onboarding-standard.md` defines the standard provider contract.
- `docs/provider-sync-runner.md` explains scheduled provider ingestion.
- `docs/knowledge-request-worker.md` explains request claim and fulfillment.
- `docs/enterprise-quality-validation.md` explains validation and confidence controls.
- `https://github.com/PerkOS-xyz/PerkOS-Tech-Plugin` explains how agents install the plugin in OpenClaw, Hermes, MCP, and AgentSkill runtimes.

## What PerkOS Knowledge Is

PerkOS Knowledge is the remote live knowledge service for PerkOS agents.

It is not an LLM provider and it is not a local-only skill. It stores and serves source-cited context, private organization knowledge, quality metadata, request workflows, and provider contribution records.

Agents use it when they need reliable PerkOS/Web3 context instead of relying only on model memory.

## Integration Repositories

| Repository | Purpose | Who reads it |
| --- | --- | --- |
| `PerkOS-xyz/knowledge` | Server, APIs, data model, provider onboarding, request workflow, privacy and quality rules. | Operators, backend maintainers, provider implementers. |
| `PerkOS-xyz/PerkOS-Tech-Plugin` | Installable integration for agent runtimes. Includes OpenClaw plugin, Hermes wrapper, MCP server, and AgentSkill scripts. | Agent developers, runtime maintainers, consumer/provider agent owners. |

Agents normally install the plugin, then call this Knowledge service through the plugin tools or helper scripts.

## Role Model

| Role | What it does | Knowledge-side requirement | Plugin-side requirement |
| --- | --- | --- | --- |
| Public consumer | Queries public context. | No private org membership required. | Read/query tools only. |
| Private org consumer | Queries public plus organization-private context. | Organization membership and ACL authorization. | `KNOWLEDGE_ORG_ID` configured; private results stay internal. |
| Requester | Creates missing-context requests. | Request endpoint access. | Request create tool enabled. |
| Provider | Claims requests, researches, fulfills, and submits sanitized knowledge. | Registered agent, organization membership, contribution scopes, ingest token. | Provider write tools and identity env enabled. |
| Validator | Reviews provider output and marks trust state. | Validation scopes or admin/operator role. | Validate tool enabled only on trusted agents. |
| Operator/admin | Onboards organizations, agents, scopes, and provider tokens. | Admin token or approved admin wallet header. | Does not belong in normal agent runtime configs. |

## Standard Consumer Flow

1. Agent receives a task that needs PerkOS or Web3 context.
2. Agent queries Knowledge through `POST /skill/query`, plugin query tools, or visibility-aware search endpoints.
3. Knowledge returns context, sources, quality, validation, and visibility metadata.
4. Agent checks confidence and validation state before answering.
5. If context is missing or weak, the agent creates a Knowledge request instead of inventing facts.

## Standard Provider Flow

1. Operator registers the provider with `POST /api/admin/agents`.
2. Operator assigns organization membership and scopes.
3. Provider runtime is configured with `KNOWLEDGE_BASE_URL`, `KNOWLEDGE_ORG_ID`, `KNOWLEDGE_AGENT_ID`, `KNOWLEDGE_SEND_AGENT_ID=1`, and `KNOWLEDGE_INGEST_TOKEN`.
4. Provider lists open requests or gathers its own scheduled research.
5. Provider claims one matching request or prepares direct research.
6. Provider submits sanitized items to `POST /api/ingest/research`.
7. Provider fulfills the request when applicable.
8. Validator or operator reviews quality before higher-trust usage.

## Standard Validation Flow

1. Validator reviews the fulfilled request or submitted item.
2. Validator checks evidence, scope, privacy boundary, confidence, and usefulness.
3. Validator records validation through the request validation endpoint or quality workflow.
4. Future consumers can request `validated_only`, require validation, or use stricter confidence thresholds.

## Public vs Private Rules

Knowledge is private-by-default.

| Visibility | Meaning | Retrieval rule |
| --- | --- | --- |
| `public` | Sanitized context intended for public agents. | Public consumers may retrieve it. |
| `private` | Organization-scoped internal context. | Only members of the owning organization may retrieve it. |
| `public_candidate` | Provider wants public review. | Stored private with review required before publication. |

Provider submissions should default to `private`. Use `public_candidate` only when the content is intended for review and possible public release.

## Endpoint Map

Consumer-facing:

- `GET /llms.txt`
- `GET /llms-full.txt`
- `GET /skill/manifest`
- `POST /skill/query`
- `GET /api/x402/policy`
- `GET/POST /knowledge/search`
- `GET/POST /knowledge/vector-search`
- `GET /knowledge/brief/:agent`

Provider/request-facing:

- `GET /api/providers/manifest`
- `POST /api/ingest/research`
- `GET /knowledge/requests`
- `POST /knowledge/requests`
- `POST /knowledge/requests/:id/claim`
- `POST /knowledge/requests/:id/fulfill`
- `POST /knowledge/requests/:id/validate`

Admin/operator-facing:

- `GET/POST /api/admin/organizations`
- `GET/POST /api/admin/agents`
- `GET /api/admin/providers`
- `POST /api/admin/acl/self-test`
- `GET /api/admin/x402/receipts`
- `GET /api/admin/x402/config`
- `POST /api/admin/x402/facilitator/self-test`

Admin and provider endpoints require protected credentials. Do not expose admin/provider tokens in public docs, commits, logs, screenshots, or agent responses.

## Agent Installation

Install the integration from the plugin repository:

- GitHub: `https://github.com/PerkOS-xyz/PerkOS-Tech-Plugin`
- npm: `@perkos/perkos-tech-plugin`

That repo documents:

- OpenClaw plugin install.
- Hermes Agent install.
- MCP server install.
- AgentSkill-only install.
- Role-specific tool allowlists.
- Role-specific environment variables.

## Quality Expectations

Agents should not treat every retrieved item as equal.

They should inspect:

- `validationStatus`
- `confidencePercent`
- `trustTier`
- `qualityReasons`
- evidence/source metadata
- visibility and organization scope

For high-stakes decisions, consumers should use validated-only or higher-confidence settings through the plugin.

## Safety Rules

- Never submit secrets, private keys, tokens, wallet seeds, raw logs, or internal-only deployment details.
- Never expose private organization results outside the authorized organization context.
- Never invent wallet/ERC-8004 identity values.
- Never enable provider or admin tools on general-purpose consumer agents.
- Prefer requests and provider workflows over unsupported claims.
- Public output must be sanitized and source-cited when possible.

## Minimum Agent Reading Order

An external agent trying to understand the full integration should read:

1. `PerkOS-xyz/knowledge/README.md`
2. `PerkOS-xyz/knowledge/docs/agent-integration-overview.md`
3. `PerkOS-xyz/knowledge/docs/provider-agent-integration.md`
4. `PerkOS-xyz/PerkOS-Tech-Plugin/README.md`
5. `PerkOS-xyz/PerkOS-Tech-Plugin/docs/agent-role-integration.md`
6. `PerkOS-xyz/PerkOS-Tech-Plugin/docs/install.md`
7. `PerkOS-xyz/PerkOS-Tech-Plugin/docs/runtime-matrix.md`
