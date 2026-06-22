#!/usr/bin/env bash
# Deploy PerkosClaimVault (UUPS proxy) to Base. Sources .env first.
#
#   ./deploy.sh sepolia   → Base Sepolia (chainId 84532, faucet ETH)
#   ./deploy.sh mainnet   → Base mainnet (chainId 8453, real ETH)
#
# .env must define SAFE_OWNER, DEPLOYER_PRIVATE_KEY, USDC_ADDRESS, PERKOS_ADDRESS
# (DISTRIBUTOR_ADDRESS + ETHERSCAN_API_KEY optional). See .env.example.
set -euo pipefail

NETWORK="${1:-}"
if [[ "$NETWORK" != "sepolia" && "$NETWORK" != "mainnet" ]]; then
  echo "usage: $0 sepolia | mainnet" >&2
  exit 2
fi
[[ -f .env ]] || { echo "error: .env not found. Copy .env.example to .env and fill it in." >&2; exit 2; }

set -a
# shellcheck disable=SC1091
source .env
set +a

: "${SAFE_OWNER:?SAFE_OWNER required}"
: "${DEPLOYER_PRIVATE_KEY:?DEPLOYER_PRIVATE_KEY required}"
: "${USDC_ADDRESS:?USDC_ADDRESS required}"
# $PERKOS is OPTIONAL at deploy — it's bought later by the buyback. Leave unset
# (defaults to 0x0) and wire it with setRewardToken when it exists; USDC payment
# claims work from day one.
PERKOS_ADDRESS="${PERKOS_ADDRESS:-0x0000000000000000000000000000000000000000}"
DISTRIBUTOR_ADDRESS="${DISTRIBUTOR_ADDRESS:-0x0000000000000000000000000000000000000000}"

if [[ "$NETWORK" == "sepolia" ]]; then
  RPC=base_sepolia
else
  RPC=base
  read -r -p "Deploy to Base MAINNET? owner=$SAFE_OWNER (type 'YES' to confirm): " confirm
  [[ "$confirm" == "YES" ]] || { echo "aborted."; exit 1; }
fi

VERIFY_FLAGS=()
[[ -n "${ETHERSCAN_API_KEY:-}" ]] && VERIFY_FLAGS=(--verify)

forge script script/DeployClaimVault.s.sol:DeployClaimVault \
  --rpc-url "$RPC" \
  --broadcast \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  "${VERIFY_FLAGS[@]}" \
  --sig 'run(address,address,address,address)' \
  "$SAFE_OWNER" "$USDC_ADDRESS" "$PERKOS_ADDRESS" "$DISTRIBUTOR_ADDRESS"
