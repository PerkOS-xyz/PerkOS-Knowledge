'use client';

import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { base, baseSepolia, celo, mainnet } from 'wagmi/chains';

export const wagmiConfig = getDefaultConfig({
  appName: 'PerkOS Knowledge',
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || 'perkOS-knowledge-preview',
  // baseSepolia for the claim vault on testnet before mainnet.
  chains: [base, baseSepolia, celo, mainnet],
  ssr: true
});
