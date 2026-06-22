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
3. **Buy + fund the vault** — the treasury market-buys $PERKOS on a Base DEX for
   the pooled USDC and moves it into the claim vault.
4. **Claim, not push** — the platform does **not** auto-send tokens. It computes
   each wallet's cumulative owed $PERKOS (researcher 60% / requester 40%) and
   posts a Merkle root to the vault. Participants **claim from their dashboard**.

**Effects:** real buy pressure (revenue → token), measurable on-chain token
transactions, and alignment — participants hold $PERKOS, so they want the
platform to grow.

## Claim vault — the control contract (`PerkosClaimVault`)

Decided 2026-06-22: **pull, not push.** Rather than the platform multisending
payouts, a single on-chain vault custodies the funds and participants withdraw
what they're owed from their dashboard — both **USDC payment** (provider
earnings) and **$PERKOS reward** in one claim. Why this beats auto-distribute:

- **Gas** — no platform-paid multisends; each user pays their own claim.
- **Legal** — a user *withdrawing their earnings* reads very differently from the
  platform *distributing tokens*; far cleaner footing for the reward leg.
- **Self-custody + trust-min** — the vault holds funds; the platform can only
  publish "who can claim how much" (a Merkle root), never move a user's balance.

`PerkOS-Contracts/src/PerkosClaimVault.sol` (UUPS, OZ 5, Base) is a **cumulative
Merkle distributor** over two tokens. Each epoch the platform funds the vault and
posts a root encoding `(account, cumulativeUsdc, cumulativeReward)`; `claim(...)`
verifies the proof and sends the **delta** since the account's last claim (so
re-posting roots + partial claims are safe). Root-setting defaults to the owner
(a Safe multisig); a hot `distributor` key may be delegated for automation, with
`pause` + `ownerWithdraw` as backstops. **Not yet audited — testnet first.**

Off-chain (Knowledge): a service rolls up unsettled provider earnings
(`agent_accounts`/`knowledge_attributions`) + the bought $PERKOS
(`reward_pool` post-buyback) into per-wallet cumulative totals, builds the tree
(the openzeppelin merkle-tree lib, leaf `["address","uint256","uint256"]`), funds
the vault, and posts the root. The dashboard reads each wallet's cumulative entry
+ proof and renders a **Claim** button.

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
- **P2 — claim vault wiring:** deploy `PerkosClaimVault` (Base Sepolia → Base),
  build the off-chain Merkle roll-up service (cumulative per-wallet USDC + PERKOS)
  + root-post job, and add the **Claim** flow to the dashboard. Lets providers
  pull their USDC earnings even before the buyback exists. *(Contract + tests
  shipped 2026-06-22; off-chain + dashboard next.)*
- **P3 — utility sinks:** pay-in-PERKOS discount, stake-to-boost (provider share /
  reward multiplier / queue priority). Subscriptions/seats. Charge-on-miss /
  refund policy (today a coverage-miss still debits; the provider share is
  unallocated float).
- **P4 — gated:** wire the buyback (viem on Base, DEX router, slippage guard) to
  fund the vault + post roots **after legal + treasury key**.

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
