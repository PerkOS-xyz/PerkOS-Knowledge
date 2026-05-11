export const ALLOWED_WALLET = '0xc2564e41B7F5Cb66d2d99466450CfebcE9e8228f';

export function normalizeWallet(wallet?: string | null) {
  return (wallet || '').trim().toLowerCase();
}

export function isAllowedWallet(wallet?: string | null) {
  return normalizeWallet(wallet) === ALLOWED_WALLET.toLowerCase();
}
