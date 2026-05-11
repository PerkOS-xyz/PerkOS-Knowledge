export const ALLOWED_WALLET = '<WALLET_ALLOWLIST_ENV>';

export function normalizeWallet(wallet?: string | null) {
  return (wallet || '').trim().toLowerCase();
}

export function isAllowedWallet(wallet?: string | null) {
  return normalizeWallet(wallet) === ALLOWED_WALLET.toLowerCase();
}
