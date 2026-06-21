# PerkOS Knowledge — monetization (credits + two-sided market)

Status: **Phase 1 (backend) shipped 2026-06-21.** Phases 2-4 pending.

## Model — prepaid credit balance (not on-chain-per-request)

Money lives as a **credit balance at the owner wallet** (`agent_accounts`).

- **Deposit / top-up** → USDC via x402 (occasional on-chain receipt) → `+balance`.
- **Consume** → each query **debits** the balance off-chain (instant, no gas/latency per call). No balance → `402 insufficient_credit`.
- **Provider earns** → each consumed item credits its contributor (`knowledge_attributions`, equal split of the query amount) → `+balance` of the provider wallet.
- **Whitelist / exemption** → `agent_billing.exempt` (+ env `KNOWLEDGE_EXEMPT_WALLETS`) → those agents query **free**. For PerkOS internal / research agents.
- **Research paid** → research agents accrue credits when their items are consumed → "the agents doing the work get paid".
- **Settlement** → batch job converts a provider's accrued balance into an on-chain USDC transfer (or on-demand withdraw).

Why credits over on-chain-per-request: settling USDC on every query = gas + latency per call (doesn't scale). Prepaid debits off-chain and settles on-chain in batch — and natively supports exemptions + credit-for-research.

## Data model

- `agent_accounts` — `wallet PK, balance, currency, total_earned, total_spent, total_deposited`.
- `agent_billing` — `agent_id PK, wallet, exempt, role(consumer|provider|both), note` — **the whitelist**.
- `credit_ledger` — every movement: `wallet, agent_id, kind(debit|credit), amount, reason(query|attribution|deposit|grant|settlement), request_id, x402_receipt_id, balance_after`.
- `knowledge_attributions` — per-item earnings detail (who earned, from which consumption; `settled` flag for payout).
- `x402_receipts` — on-chain deposit receipts (reused).

## Flows

1. **Query** (`/skill/query`): resolve identity (`x-agent-id`/`x-agent-wallet`) + price (x402 policy). If `mode=credit` & price>0 & **not exempt** → require wallet, **debit**; insufficient → 402. Serve. `recordAttributions` splits the charged amount across consumed items → **credit** each provider wallet (`reason=attribution`, `earned`).
2. **Deposit / grant**: `POST /api/admin/credits/grant` (admin) credits a wallet (top-up, off-chain-deposit settle, or research stipend). On-chain deposit-verify flow is a later add.
3. **Whitelist**: `POST /api/admin/billing` (admin) sets `exempt`/`role` per agent.
4. **Settlement** (F4): job reads unsettled provider balance → USDC transfer → mark settled.

Identity/registration: **reuse the PerkOS agent identity** (wallet owner + agentId; the query already sends `x-agent-id`/`x-agent-wallet`). "Registration" = the `agent_account` is created on first use; the dashboard (wallet login) lists the agents of that wallet. No separate registry.

## Phases

- **F1 — backend (DONE 2026-06-21):** `agent_accounts` / `agent_billing` / `credit_ledger`; `lib/credits.ts` (balance/debit/credit/exempt/billing/summary); `lib/attribution.ts` returns per-wallet credited totals; `/skill/query` debit+credit wiring; x402 `credit` mode; endpoints `GET /api/credits/:wallet`, `POST /api/admin/billing`, `POST /api/admin/credits/grant`. Tests + e2e verified.
- **F2 — dashboard** (Knowledge app, wallet login): per-agent earnings + spend + balance + recent ledger; top-up + withdraw CTAs. Consumes `/api/credits/:wallet`.
- **F3 — admin UI** (Knowledge app, `/admin`): prices (enable charging), whitelist/exemptions, global ledger, manual settlement + grants. Consumes the admin endpoints.
- **F4 — on-chain settlement:** payout job (treasury wallet → USDC transfers) + on-chain deposit verification.

## Go-live: enabling charging (deliberate, post-F1)

Charging is OFF by default (`metered_free`, price 0) — F1 ships the machinery inert so free access isn't broken. To turn it on:

1. Set `KNOWLEDGE_X402_MODE=credit` + tier prices (`KNOWLEDGE_X402_*_PRICE_AMOUNT`) + `KNOWLEDGE_X402_TOKEN`/`PAY_TO` + `KNOWLEDGE_X402_CURRENCY`/`CHAIN`.
2. Exempt the PerkOS platform / research agents first (`KNOWLEDGE_EXEMPT_WALLETS` and/or `agent_billing.exempt`) so they don't get charged.
3. Seed/announce balances (grants) so legitimate consumers aren't immediately 402'd.

Then every paid query debits the consumer and credits the providers in real USDC-denominated credits.
