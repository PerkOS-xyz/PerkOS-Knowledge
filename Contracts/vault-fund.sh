#!/usr/bin/env bash
# Fund PerkosClaimVault with USDC (treasury → vault) so claims can be paid out
# on that network. The treasury accrues USDC from deposits (payTo = treasury);
# this moves some of it into the vault. Per network.
#
#   ./vault-fund.sh base|celo <usdcAmount> [--dry-run]
#
# .env: DEPLOYER_PRIVATE_KEY = the treasury key (holds the USDC).
set -euo pipefail

NET="${1:-}"; AMT="${2:-}"; DRY="${3:-}"
case "$NET" in
  base) RPC="https://mainnet.base.org"; USDC="0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" ;;
  celo) RPC="https://forno.celo.org";   USDC="0xcebA9300f2b948710d2653dD7B07f33A8B32118C" ;;
  *) echo "usage: $0 base|celo <usdcAmount> [--dry-run]" >&2; exit 2 ;;
esac
[[ "$AMT" =~ ^[0-9]+(\.[0-9]+)?$ ]] || { echo "amount must be a positive number" >&2; exit 2; }
[[ -f .env ]] || { echo ".env not found" >&2; exit 2; }

set -a; source .env; set +a
VAULT="${CLAIM_VAULT_ADDRESS:-0xC609BB99C9CAc2b10cc7796b96d0a2EDf2B6f589}"
KEY="${DEPLOYER_PRIVATE_KEY:?treasury key required}"
UNITS="$(python3 -c "import sys;print(int(round(float(sys.argv[1])*1_000_000)))" "$AMT")"  # USDC 6-dec

echo "transfer $AMT USDC ($UNITS units) → vault $VAULT on $NET"
if [[ "$DRY" == "--dry-run" ]]; then
  echo "DRY-RUN — would run:"
  echo "  cast send $USDC 'transfer(address,uint256)' $VAULT $UNITS --rpc-url $RPC --private-key <treasury>"
  exit 0
fi
cast send "$USDC" "transfer(address,uint256)" "$VAULT" "$UNITS" --rpc-url "$RPC" --private-key "$KEY"
echo "vault USDC balance now: $(cast call "$USDC" 'balanceOf(address)(uint256)' "$VAULT" --rpc-url "$RPC")"
