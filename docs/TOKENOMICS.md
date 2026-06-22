# PerkOS Knowledge — Tokenomics

How the two-sided knowledge market makes money, what the platform keeps, and how
a slice of every payment feeds the **$PERKOS** token. Builds on
[`MONETIZATION-DESIGN.md`](./MONETIZATION-DESIGN.md) (the prepaid credit market).

Status: **fee waterfall + configurable pricing shipped 2026-06-22.** $PERKOS
buyback **accrues but is OFF** (gated on a treasury key + legal review).

---

## The problem this fixes

Before this, `/skill/query` split **100% of every paid query to providers**
(`splitAmount = amount / count`). The platform kept **nothing** — the treasury
was a pass-through float. So PerkOS made $0 from Knowledge. The fix is a **fee
waterfall**: every paid query splits three ways.

## The fee waterfall

For a paid query of price `P` (USDC), `feeWaterfall(P)` splits:

| Flow | Default | Goes to | Recorded in |
|---|---|---|---|
| **Provider payout** | **75%** | the research items that answered (equal split) | `knowledge_attributions` + provider balance |
| **Platform take** | **20%** | PerkOS — *this is the revenue, it stays* | `platform_revenue` |
| **$PERKOS reward pool** | **5%** | buyback budget → researcher + requester | `reward_pool` |

The provider takes the remainder so the three always sum back to `P` (no rounding
leak). `chargedAmount = 0` (free / exempt / `metered_free`) ⇒ all zero, nothing
moves.

**Everything is admin-editable** — a single `tokenomics_config` row (no redeploy):
prices per tier, the three fee shares (bps, must sum to 10000), the reward
researcher/requester split, mode, and the buyback flag/threshold. Unset columns
fall back to the decided defaults in `lib/tokenomics.ts`. Edit it at
**`knowledge.perkos.xyz/admin/billing`** → *Tokenomics*.

## Pricing ladder (decided 2026-06-22)

| Tier | Price | When |
|---|---|---|
| `public` | **$0** | open knowledge, no org scope |
| `private` | **$0.01** | organization-scoped (membership required) |
| `premium` | **$0.02** | curated / higher-trust |
| `enterprise` | **$0.10** | **validated-only** — independently-validated, evidence-backed (the guaranteed-quality product) |

`enterprise` is auto-selected when a caller requests validated knowledge
(`qualityMode=validated_only` / `requireValidated`) or `tier=enterprise`. It's
priced 5–10× the others because the value is the *guarantee*.

## How much PerkOS makes — be honest about the unit economics

Revenue = `queries × P × 20%`. At micro-prices that needs volume:

- premium $0.02 × 20% = **$0.004/query** → **$1,000/mo** ≈ **250k premium
  queries/mo**.
- enterprise $0.10 × 20% = **$0.02/query** → **$1,000/mo** ≈ **50k queries/mo**.

So the Knowledge fee alone won't fund the company at these prices. The real
levers, in order of leverage:

1. **The `enterprise` tier** (validated knowledge is worth 10×) — push validated
   coverage so more queries land here.
2. **Subscriptions / enterprise seats** — orgs pay a flat monthly for premium
   access instead of per-query (predictable revenue; not yet built).
3. **The platform's primary P&L is agent infra** — ECS hosting, the LLM-gateway
   margin, provisioning. Knowledge is the **usage + token-velocity flywheel**,
   not the main line.

`platform_revenue` (visible in the admin Tokenomics summary) is the running tally
of "what stays."

## The $PERKOS loop

The 5% reward share is the token flywheel. Mechanics:

1. **Accrue** — each paid query writes a `reward_pool` row (USDC amount +
   requester wallet + researcher wallets + the researcher share).
2. **Batch (mandatory)** — a per-query on-chain buy is impossible (Base gas
   $0.01–0.05 ≫ a $0.0005 reward). The buyback fires **per epoch**: when the
   pending pool clears `buybackThreshold` (default $100).
3. **Buy + distribute** — the treasury market-buys $PERKOS on a Base DEX for the
   pooled USDC, then distributes the bought token pro-rata to that epoch's
   **researchers (60%) + requesters (40%)** (configurable), marks the rows
   `distributed`, and records `token_rewards`.

**Effects:** real buy pressure (revenue → token), measurable on-chain token
transactions, and alignment — participants hold $PERKOS, so they want the
platform to grow.

### The three rules we don't break

1. **Fund rewards from real fees, never from token emission.** The 5% is a slice
   of actual revenue. Minting rewards would be circular and read as a ponzi.
2. **$PERKOS needs sinks or recipients just dump it.** Roadmap: pay query fees in
   $PERKOS for a discount; **stake to boost a provider's payout share / reward
   multiplier / request-queue priority**; governance over the catalog. Without a
   sink the buyback only subsidizes sellers.
3. **Vest the rewards** (lock or stake-to-claim) to dampen sell pressure.

## Why the buyback is OFF

Buying your own token with user fees and handing it out as a reward has
**securities / market-manipulation** exposure. It ships **gated three ways**
(`lib/buyback.ts`): the admin `buybackEnabled` flag **and** a 32-byte
`KNOWLEDGE_TREASURY_PRIVATE_KEY` **and** the on-chain leg is deliberately not
wired. Until a **legal sign-off** + the key, the 5% just accrues as a tracked
liability — nothing irreversible happens. (The same treasury key also gates USDC
provider settlement, which is likewise pending.)

## Rollout phases

- **P1 — shipped (2026-06-22):** configurable waterfall (75/20/5), `enterprise`
  tier + new prices, `platform_revenue` + `reward_pool` accrual, admin Tokenomics
  editor + revenue/pool summary.
- **P2 — next:** $PERKOS utility sinks (pay-in-PERKOS discount, stake-to-boost) so
  rewards have somewhere to go. Subscriptions/seats. Charge-on-miss / refund
  policy (today a coverage-miss still debits; the provider share is unallocated
  float).
- **P3 — gated:** wire the buyback worker (viem on Base, DEX router, slippage
  guard, batched distribute / merkle-claim) **after legal + treasury key**.

## Code map

- `lib/tokenomics.ts` — config load/save (`tokenomics_config`), `feeWaterfall`,
  `rewardSplit`, `recordPlatformRevenue`, `accrueReward`, `tokenomicsSummary`.
- `lib/x402.ts` — `enterprise` tier; `getX402Policy(…, priceOverride)`.
- `app/skill/query/route.ts` — loads config, prices the tier, runs the waterfall.
- `app/api/admin/tokenomics/route.ts` — GET (config + summary) / POST (edit, fee
  validation). Admin-gated.
- `components/AdminClient.tsx` — the editable Tokenomics panel.
- `lib/buyback.ts` — the gated, OFF scaffold.
- DB: `tokenomics_config`, `platform_revenue`, `reward_pool` (see `lib/db.ts`).

## Open decisions / risks

- **Legal review before the buyback** — non-negotiable gate.
- **Token sinks** — ship at least one before the buyback so rewards don't just
  get sold.
- **Charge-on-coverage-miss** — decide refund vs. keep; today it's kept (float).
- **Treasury custody** — the key isn't set; needed for both settlement + buyback.
