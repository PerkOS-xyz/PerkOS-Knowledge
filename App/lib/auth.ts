export function normalizeWallet(wallet?: string | null) {
  return (wallet || '').trim().toLowerCase();
}

export function getAllowedWallet() {
  return normalizeWallet(process.env.KNOWLEDGE_ALLOWED_WALLET || process.env.ALLOWED_WALLET);
}

export function isAllowedWallet(wallet?: string | null) {
  const allowedWallet = getAllowedWallet();
  return Boolean(allowedWallet) && normalizeWallet(wallet) === allowedWallet;
}
