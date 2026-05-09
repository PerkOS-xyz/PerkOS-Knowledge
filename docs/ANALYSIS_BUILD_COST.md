# PerkOS Knowledge — Build and Cost Analysis

## Recommendation

Build the MVP as **one Next.js App Router project** inside `App/`.

That gives us in one codebase:

- marketing site,
- public docs/pricing pages,
- API routes,
- internal agent endpoints,
- x402 paid endpoints,
- admin/research dashboard,
- Firebase integration,
- vector search integration.

Keep `Contracts/` separate for chain/payment-specific code.

## Architecture

### App

Next.js App Router can host:

- `/` marketing landing page
- `/pricing`
- `/docs`
- `/dashboard` internal admin
- `/api/knowledge/search`
- `/api/knowledge/brief/[agent]`
- `/api/knowledge/ingest`
- `/api/paid/search`
- `/api/paid/brief/[topic]`
- `/api/paid/custom-research`
- `/api/x402/verify`

### Storage

Use two layers:

1. **Firebase / Firestore**
   - auth/service accounts
   - metadata
   - access policies
   - payment receipts
   - query logs
   - ingest jobs
   - admin dashboard state

2. **Vector DB**
   - semantic search over knowledge items
   - metadata filters by chain, topic, audience, visibility

Recommended vector path:

- MVP: SQLite + sqlite-vec or local JSON index
- Production: Qdrant

Firebase alone should not be the main vector database.

## Why Next.js App Router is enough for MVP

Pros:

- One deployable app.
- Marketing + backend together.
- Fast development.
- Easy API routes.
- Easy dashboard/admin UI.
- Can deploy on Netlify/Vercel or VPS Docker.
- Good fit for Firebase Auth/Firestore.

Cons:

- Long-running ingestion/reindex jobs are not ideal in serverless.
- If deployed to Netlify/Vercel, background workers may need separate process.
- x402 verification and custom research jobs may eventually need queue/worker.

MVP answer: use Next.js for everything now, add worker later.

## Suggested MVP stack

- Next.js 15+ App Router
- TypeScript
- Tailwind
- Firebase Admin SDK
- Firestore
- Qdrant later, SQLite/sqlite-vec first if local VPS
- x402 middleware/adapters
- viem for Base/Celo EVM payment helpers
- Solana web3.js or @solana/kit for Solana payment helpers

## Payment rails

### Base

Primary rail.

Use for:

- x402 standard alignment
- USDC payments
- ERC-8004 / PerkOS Stack integration

### Celo

Use for:

- global/mobile stablecoin payments
- USDC/cUSD support
- lower-cost EVM path

### Solana

Use for:

- low-latency agent micropayments
- high-volume paid queries
- non-EVM agent support

## Contracts directory purpose

`Contracts/` should contain:

- chain config
- x402 payment adapter notes
- optional receipt registry contracts
- optional access pass/NFT/subscription contracts
- deployment scripts
- Foundry/Hardhat if EVM contracts are needed
- Solana program notes/scripts if needed later

Important: x402 may not need custom contracts for MVP. Start with standard payment verification and only add contracts if we need receipts, subscriptions, or on-chain access passes.

## Estimated build effort

### MVP 1 — internal live skill

Scope:

- marketing shell
- API search over current Perky knowledge tree
- Firebase metadata/logs
- internal agent auth
- role briefs

Estimate: 2–4 focused days.

### MVP 2 — x402 paid endpoints

Scope:

- paid `/api/paid/*` routes
- x402 payment required responses
- Base/Celo/Solana accepted rails
- payment receipt logs
- public sanitization layer

Estimate: 3–7 focused days depending on x402 library readiness and Solana path.

### MVP 3 — vector DB

Scope:

- ingestion pipeline
- embeddings
- Qdrant or sqlite-vec
- metadata filters
- reindex job

Estimate: 2–5 focused days.

### MVP 4 — admin dashboard

Scope:

- ingest/review queue
- visibility controls
- source review
- pricing controls
- usage/payment logs

Estimate: 3–6 focused days.

## Monthly cost estimate

### Lean VPS MVP

- VPS: $10–30/mo
- Firebase Spark/Blaze: $0–25/mo initially
- Qdrant self-hosted: included in VPS
- Embeddings: depends on provider; local/Ollama can be near $0
- Domain: existing or ~$10–15/year

Likely MVP: **$10–50/mo**.

### Production small

- VPS/API: $20–80/mo
- Qdrant VPS or managed vector DB: $20–100+/mo
- Firebase: $10–100/mo depending on reads/writes/logs
- Embeddings/LLM summaries: $10–200/mo depending on volume

Likely early production: **$50–300/mo**.

### Higher traffic paid service

- Scale depends on paid query volume.
- x402 revenue can directly offset infra.
- Biggest cost risks: embeddings, LLM-generated custom research, Firestore read amplification.

## Monetization

Suggested pricing:

- Basic search: $0.001–0.01
- Topic brief: $0.05–0.25
- Deep report: $1–5
- Custom research: $10+
- Internal PerkOS agents: free/trusted

## Security and privacy

Must enforce visibility:

- `private` — Julio/Alice only
- `fleet` — internal agents only
- `public` — safe public knowledge
- `premium` — paid public/sanitized reports

Never expose:

- secrets
- `.env`
- private keys
- server IPs
- unpublished strategy
- private repo details
- internal protectors

## Build order

1. Scaffold Next.js app in `App/`.
2. Add API routes that read Perky `knowledge-tree/index.json`.
3. Add Firebase metadata/logging.
4. Add simple marketing/pricing pages.
5. Add vector DB ingestion.
6. Add x402 paid endpoints for Base first.
7. Add Celo.
8. Add Solana.
9. Add MCP/A2A interface.

## Decision

Use **Next.js App Router as the first implementation**, with `Contracts/` reserved for payment/chain-specific code. Split into separate backend/worker only when jobs or traffic require it.
