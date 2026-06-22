# Contracts

On-chain payment/reward layer for PerkOS Knowledge (Foundry, Base).

## `PerkosClaimVault` (src/PerkosClaimVault.sol)

The **control contract** for the two-sided market. Instead of the platform
pushing payouts, participants **pull**: they claim what they're owed from their
dashboard — **USDC (provider payment) + $PERKOS (reward) in one claim**.

A UUPS cumulative-Merkle distributor over two tokens. Each epoch the platform
funds the vault and posts a Merkle root of `(account, cumulativeUsdc,
cumulativeReward)`; `claim(account, cumUsdc, cumReward, proof)` verifies the proof
and transfers the **delta** since the account's last claim (re-posting roots +
partial claims are safe). Root-setting defaults to the owner (a Safe); a hot
`distributor` key may be delegated for automation, with `pause` + `ownerWithdraw`
as backstops.

Leaf format (must match the off-chain builder — the `@openzeppelin/merkle-tree`
JS lib's `StandardMerkleTree`, types `["address","uint256","uint256"]`):

```
leaf = keccak256(bytes.concat(keccak256(abi.encode(account, cumUsdc, cumReward))))
```

> **Not yet audited.** Deploy to Base Sepolia, review, then mainnet. Tokenomics
> design: [`../docs/TOKENOMICS.md`](../docs/TOKENOMICS.md).

## Develop

```bash
# Toolchain libs (lib/ is gitignored):
forge install OpenZeppelin/openzeppelin-contracts-upgradeable
forge install foundry-rs/forge-std

forge build
forge test          # PerkosClaimVault.t.sol — cumulative claim, delta, proofs, auth, pause
```

## Deploy

```bash
cp .env.example .env   # fill SAFE_OWNER, DEPLOYER_PRIVATE_KEY, USDC_ADDRESS, PERKOS_ADDRESS
./deploy.sh sepolia    # Base Sepolia first
# ./deploy.sh mainnet  # after audit
```

Wire the deployed proxy address + the off-chain claim service (Merkle roll-up +
root-post) into the Knowledge app. The reward leg also needs the buyback
(USDC → $PERKOS) — gated OFF until a treasury key + legal sign-off.

## Other chains (future)

- Base — primary x402/EVM rail (here)
- Celo — mobile/global stablecoin EVM rail
- Solana — high-throughput micropayment rail
