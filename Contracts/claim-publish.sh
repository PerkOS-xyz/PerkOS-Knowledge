#!/usr/bin/env bash
# Publish a claim distribution's Merkle root to PerkosClaimVault.setMerkleRoot,
# signed by the DISTRIBUTOR (the operational role). Run once per network — the
# vault has the same address on Base + Celo, so the same root is posted on each.
#
#   ./claim-publish.sh base|celo <0xMerkleRoot> [--dry-run]
#
# .env (gitignored): DEPLOYER_PRIVATE_KEY = the distributor/treasury key (0x3f0D),
# optional CLAIM_VAULT_ADDRESS (defaults to the deployed proxy).
set -euo pipefail

NET="${1:-}"; ROOT="${2:-}"; DRY="${3:-}"
case "$NET" in
  base) RPC="https://mainnet.base.org" ;;
  celo) RPC="https://forno.celo.org" ;;
  *) echo "usage: $0 base|celo <0xroot> [--dry-run]" >&2; exit 2 ;;
esac
[[ "$ROOT" =~ ^0x[0-9a-fA-F]{64}$ ]] || { echo "root must be 0x + 64 hex" >&2; exit 2; }
[[ -f .env ]] || { echo ".env not found" >&2; exit 2; }

set -a; source .env; set +a
VAULT="${CLAIM_VAULT_ADDRESS:-0xC609BB99C9CAc2b10cc7796b96d0a2EDf2B6f589}"
KEY="${DISTRIBUTOR_PRIVATE_KEY:-${DEPLOYER_PRIVATE_KEY:?distributor/deployer key required}}"

echo "setMerkleRoot($ROOT) → $VAULT on $NET"
if [[ "$DRY" == "--dry-run" ]]; then
  echo "DRY-RUN — would run:"
  echo "  cast send $VAULT 'setMerkleRoot(bytes32)' $ROOT --rpc-url $RPC --private-key <distributor>"
  exit 0
fi
cast send "$VAULT" "setMerkleRoot(bytes32)" "$ROOT" --rpc-url "$RPC" --private-key "$KEY"
echo "posted. epoch now: $(cast call "$VAULT" 'epoch()(uint256)' --rpc-url "$RPC")"
