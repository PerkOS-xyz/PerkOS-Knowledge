#!/usr/bin/env bash
# Deploy PerkosClaimVault (UUPS proxy). Sources .env first.
#
#   ./deploy.sh sepolia   → Base Sepolia (chainId 84532, faucet ETH)
#   ./deploy.sh base      → Base mainnet  (chainId 8453)
#   ./deploy.sh celo      → Celo mainnet  (chainId 42220)
#
# .env must define SAFE_OWNER, DEPLOYER_PRIVATE_KEY, and the per-network token
# addresses: USDC_ADDRESS (Base) / USDC_ADDRESS_CELO (Celo), and optionally
# PERKOS_ADDRESS / PERKOS_ADDRESS_CELO (else rewardToken=0x0, set later).
# DISTRIBUTOR_ADDRESS + ETHERSCAN_API_KEY optional. See .env.example.
set -euo pipefail

NETWORK="${1:-}"
case "$NETWORK" in
  sepolia | base | mainnet | celo) ;;
  *) echo "usage: $0 sepolia | base | celo" >&2; exit 2 ;;
esac
[[ -f .env ]] || { echo "error: .env not found. Copy .env.example to .env and fill it in." >&2; exit 2; }

set -a
# shellcheck disable=SC1091
source .env
set +a

: "${SAFE_OWNER:?SAFE_OWNER required}"
: "${DEPLOYER_PRIVATE_KEY:?DEPLOYER_PRIVATE_KEY required}"
DISTRIBUTOR_ADDRESS="${DISTRIBUTOR_ADDRESS:-0x0000000000000000000000000000000000000000}"
ZERO=0x0000000000000000000000000000000000000000

MAINNET=0
case "$NETWORK" in
  sepolia)
    RPC=base_sepolia; LABEL="Base Sepolia"
    USDC="${USDC_ADDRESS:?USDC_ADDRESS required}"; PERKOS="${PERKOS_ADDRESS:-$ZERO}" ;;
  base | mainnet)
    RPC=base; LABEL="Base MAINNET"; MAINNET=1
    USDC="${USDC_ADDRESS:?USDC_ADDRESS required}"; PERKOS="${PERKOS_ADDRESS:-$ZERO}" ;;
  celo)
    RPC=celo; LABEL="Celo MAINNET"; MAINNET=1
    USDC="${USDC_ADDRESS_CELO:?USDC_ADDRESS_CELO required}"; PERKOS="${PERKOS_ADDRESS_CELO:-$ZERO}" ;;
esac

if [[ "$MAINNET" == 1 ]]; then
  read -r -p "Deploy to $LABEL? owner=$SAFE_OWNER usdc=$USDC reward=$PERKOS (type 'YES'): " confirm
  [[ "$confirm" == "YES" ]] || { echo "aborted."; exit 1; }
fi

# String (not array) so an empty value is safe under `set -u` on bash 3.2 (macOS).
VERIFY=""
[[ -n "${ETHERSCAN_API_KEY:-}" ]] && VERIFY="--verify"

# shellcheck disable=SC2086  # $VERIFY is intentionally word-split (empty or --verify)
forge script script/DeployClaimVault.s.sol:DeployClaimVault \
  --rpc-url "$RPC" \
  --broadcast \
  --private-key "$DEPLOYER_PRIVATE_KEY" \
  $VERIFY \
  --sig 'run(address,address,address,address)' \
  "$SAFE_OWNER" "$USDC" "$PERKOS" "$DISTRIBUTOR_ADDRESS"
