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
- **Phase C — buyback + distribute (real money):** per chain, swap budget→$PERKOS, split 40/60, write `token_rewards`, mark `reward_pool` distributed, fund the vault, post the root. Behind the `buybackEnabled` + treasury-key gates; admin-triggered, dry-run flag honored.
  - **Swap via the Uniswap Trading API** (decided 2026-06-24) — NOT hand-rolled v3/v4 router calldata. The hosted API (`https://trade-api.gateway.uniswap.org/v1`, `x-api-key`) supports **both Base and Celo** and **v2/v3/v4** classic AMM swaps, so one flow covers Base-v3 + Celo-v4 without us touching the v4 Universal Router / PoolManager / PoolKey+hooks. Flow per chain: `POST /v1/check_approval` (Permit2 for USDC; sign the returned approval tx once) → `POST /v1/quote` (`type:EXACT_INPUT`, `routing:CLASSIC` to exclude gasless UniswapX, `tokenIn`=USDC, `tokenOut`=$PERKOS, `amount`=budget, `swapper`=`0x3f0D`, `tokenInChainId`=`tokenOutChainId`=8453/42220) → `POST /v1/swap` returns a ready tx `{to,data,value,chainId,gasLimit}` → treasury `0x3f0D` signs + broadcasts (gasful) → receives $PERKOS. Slippage handled by the API (`slippageTolerance`). We still record the swap tx hash + a min-out guard before distributing.
- **Phase D — drop UX (DONE):** `ClaimPanel` reads as a "$PERKOS drop earned for using PerkOS"; per-chain rows show the highlighted `… $PERKOS drop`.
- **Orchestrator (DONE):** `App/scripts/monthly-drop.mjs` chains all legs for one chain. Run from the App dir (needs viem), keys read locally (admin token + Uniswap key from `.env`, treasury key from `Contracts/.env`):
  ```
  node scripts/monthly-drop.mjs --chain=base             # DRY-RUN: budget + quote + split
  node scripts/monthly-drop.mjs --chain=base --apply     # real: swap → distribute → build root → fund vault → post root
  node scripts/monthly-drop.mjs --chain=celo --apply
  ```
  Dry-run validated (budget 0.3 USDC → quote 342,606 $PERKOS, platform 0.12 / users 0.18). `--apply` sends real txs; the treasury signer (`0x3f0D`) needs native gas per chain. Run per chain at month end when there's accrued reward.
- **Phase E — automate (later):** wrap the orchestrator in a month-end cron once a real drop has been run by hand (add slippage + per-month USDC caps first).

## 6. New inputs / config

| Thing | Value / source |
|---|---|
| **Uniswap Trading API key** | `x-api-key` from hub.uniswap.org / the Uniswap dashboard. The one external thing we still need. |
| Base | chainId 8453; USDC `0x8335…2913`; $PERKOS `0xF714…9BA3`. API picks the v3 route. |
| Celo | chainId 42220; USDC `0xcebA…118C`; $PERKOS `0xb7Ba…6A46`. API picks the v4 route. |
| `rewardPlatformBps` | 4000 (40% platform / 60% users). |
| Treasury signer | `KNOWLEDGE_TREASURY_PRIVATE_KEY` = `0x3f0D`; needs native gas per chain (Base ETH + Celo CELO). |

## 7. Risks

- **Uniswap Trading API dependency:** a hosted API (key, rate limits, uptime). For a once-a-month buyback that's fine; if it's ever down we just run the drop later. Removes the v3-vs-v4 integration risk entirely (the API abstracts both). Keep a fallback note: the same swap could be done with on-chain routers if needed.
- **Slippage / thin pools:** one monthly buy can move a small pool. The API quotes + applies `slippageTolerance`; still cap per-month USDC and refuse if the quote's price impact is above a threshold. Optionally split the buy.
- **Price volatility:** show the **$PERKOS amount**, not a USD promise.
- **Gas per chain:** treasury signer needs Base ETH + Celo CELO.
- **Rounding:** floor each wallet's 18-dec share; keep the remainder in the platform cut (never over-allocate vs vault balance).
- **Legal:** user confirmed the framing is fine (user pays for the service; PerkOS later returns tokens for usage).
