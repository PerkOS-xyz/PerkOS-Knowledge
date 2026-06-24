# $PERKOS Rewards — Monthly Usage Drop

**Status:** design confirmed 2026-06-24; implementing in phases.

## 1. Goal

Every month, turn the platform's accrued reward into **$PERKOS that drops into users' wallets proportional to how much they used PerkOS** — they just *see they got $PERKOS for using the platform*. A cut of each drop also stays with the **platform** (its own $PERKOS treasury).

It should feel like a **usage drop / reward**, never a refund. UI says "you earned X $PERKOS for using PerkOS", never "5% of your spend, converted".

## 2. The model (confirmed)

- **Budget = the 5% reward accrued that month**, per chain. Each paid query already routes 5% into `reward_pool` (USDC). At month end, `sum(reward_pool pending that month, per chain)` is the budget. Scales purely with usage; no extra funding decision.
- **Buyback once per month**, per chain: the budget USDC market-buys $PERKOS on that chain's Uniswap pool (Base **v3** 0.3%, Celo **v4** 0.3%). One monthly buy = less gas + less slippage than a continuous drip.
- **Split of the bought $PERKOS:** `rewardPlatformBps` (default **4000 = 40%**) stays with the platform; the rest (**60%**) drops to users.
- **Who gets the user drop:** both sides of the market, by **total usage** that month:
  `activity(wallet) = USDC spent on paid queries + USDC earned from attributions`
  (consumers earn it by spending, providers by contributing — both incentivized). Each wallet's drop = `userBudgetPerkos × activity(wallet) / Σ activity`.
- **Pull, not push:** bought $PERKOS goes into the existing `PerkosClaimVault`; `token_rewards.cumulative_perkos` grows; users **claim** it from the dashboard alongside their USDC earnings (one `claim()` pays both).

## 3. What already exists

| Piece | State |
|---|---|
| `reward_pool` (5% accrual) | ✅ + now `chain` column (Phase A). The monthly budget source. |
| `rewardPlatformBps` config | ✅ added (Phase A), default 4000, admin-editable. |
| Usage tracking | ✅ `credit_ledger` (every debit/credit, wallet+chain+ts) + `knowledge_attributions`. No new tracking needed — just aggregate by month. |
| `token_rewards` (wallet → cum $PERKOS) | ✅ table; the drop ledger. Written by the monthly job. |
| `PerkosClaimVault` | ✅ `claim(account, cumUsdc, cumReward, proof)` pays USDC + $PERKOS; `rewardToken` set on Base + Celo. |
| `claim.ts` rollup | ✅ tree has `cumReward`; flip it from `0n` → read `token_rewards`. |
| `lib/buyback.ts` | ⚠️ scaffold; replace with the monthly-drop job. |

## 4. End-to-end flow

```
DURING THE MONTH (live)
  paid query → 5% reward (USDC, per chain) → reward_pool(status=pending, chain)
  credit_ledger records spend (debit) + earnings (credit) per wallet/chain/day
        │
        ▼  MONTH END — admin runs the drop, per chain (dry-run first)
  budget = Σ reward_pool.amount (pending, this month, chain C)
  buy:  treasury(0x3f0D) swaps `budget` USDC → $PERKOS on chain C's Uniswap
          Base = v3 SwapRouter exactInputSingle(USDC,PERKOS,3000,…)
          Celo = v4 Universal Router (PoolKey: USDC/PERKOS, 0.3%, tickSpacing, hooks)
        bought = $PERKOS received (slippage-guarded by a quote × (1-maxSlippage))
        │
        ├─►  platform keep = bought × rewardPlatformBps (40%) → stays in treasury
        │
        ▼    user drop = bought × 60%
  activity(wallet) = spent + earned that month on chain C  (credit_ledger + attributions)
  for each wallet: drop = userDrop × activity / Σ activity
    token_rewards[wallet].cumulative_perkos += drop
  mark reward_pool rows status='distributed', epoch=YYYY-MM
  transfer the user-drop $PERKOS into the vault on chain C
        │
        ▼
CLAIM (exists)
  rollupEntries(C): cumUsdc = total_earned, cumReward = token_rewards.cumulative_perkos
  post per-chain Merkle root (setMerkleRoot, distributor) → users claim() USDC + $PERKOS
        │
        ▼
DASHBOARD (reworded)
  "Your $PERKOS drop — earned for using PerkOS this month." → Claim.
```

## 5. Components / phases

- **Phase A — accounting (DONE, not deployed):** `reward_pool.chain` + thread `payChain`; `rewardPlatformBps` (40%) in config + DB. Reversible, no on-chain.
- **Phase B — monthly drop *calculation* (dry-run):** `lib/rewardsDrop.ts` → `computeMonthlyDrop(client, {year, month, chain})` returns `{ budgetUsdc, platformBps, perWallet: [{wallet, activity, sharePct}] }`. Admin endpoint `GET /api/admin/rewards/drop?month=&chain=` shows exactly what a drop *would* pay — no trade, no writes. Safe to ship + run anytime.
- **Phase C — buyback + distribute (real money):** per chain, swap budget→$PERKOS (Base v3 / Celo v4), split 40/60, write `token_rewards`, mark `reward_pool` distributed, fund the vault, post the root. Behind the `buybackEnabled` + treasury-key gates; admin-triggered, dry-run flag honored.
- **Phase D — drop UX:** reword `ClaimPanel` to a "$PERKOS drop" with a first-time toast.
- **Phase E — automate:** a month-end cron once B+C are proven by hand (slippage + per-month caps).

## 6. New inputs / config

| Thing | Value / source |
|---|---|
| Base pool | Uniswap **v3**, USDC/$PERKOS, fee **3000** (0.3%). $PERKOS Base `0xF714…9BA3`. |
| Celo pool | Uniswap **v4**, USDC/$PERKOS, fee **3000** (0.3%). $PERKOS Celo `0xb7Ba…6A46`. Needs PoolKey: tickSpacing + hooks addr. |
| Routers | Base v3 SwapRouter; Celo v4 Universal Router + PoolManager (addresses TBD). |
| `rewardPlatformBps` | 4000 (40% platform / 60% users). |
| Treasury signer | `KNOWLEDGE_TREASURY_PRIVATE_KEY` = `0x3f0D`; needs native gas per chain. |

## 7. Risks

- **Celo is Uniswap v4** — different from Base v3 (PoolManager + Universal Router + PoolKey/hooks). The swap leg must branch per chain; v4 is the harder one. Get the v4 PoolKey + router right (and confirm a USDC/$PERKOS v4 pool with liquidity exists at 0.3%).
- **Slippage / thin pools:** one monthly buy can move a small pool. Quote first, `minAmountOut`, optionally split the buy.
- **Price volatility:** show the **$PERKOS amount**, not a USD promise.
- **Gas per chain:** treasury signer needs Base ETH + Celo CELO.
- **Rounding:** floor each wallet's 18-dec share; keep the remainder in the platform cut (never over-allocate vs vault balance).
- **Legal:** user confirmed the framing is fine (user pays for the service; PerkOS later returns tokens for usage).
