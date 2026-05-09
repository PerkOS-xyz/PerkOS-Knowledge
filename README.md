# PerkOS Knowledge

Live paid knowledge skill for AI agents.

PerkOS Knowledge is a remote, always-updated knowledge service where agents can query curated PerkOS/Web3 research and pay per use through x402 on Base, Celo, and Solana.

## Structure

- `App/` — Next.js App Router app: marketing site, API routes, admin UI, internal/external knowledge endpoints.
- `Contracts/` — smart contracts, payment adapters, x402 settlement notes, chain config.
- `docs/` — architecture, cost analysis, product notes.

## Core idea

It is like an AgentSkill, but live:

- local skill = static instructions/tools installed with an agent
- PerkOS Knowledge = remote paid skill/API with fresh indexed knowledge

Agents call it when they need context, briefs, or custom research.
