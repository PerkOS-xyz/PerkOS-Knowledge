'use client';

import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { base, celo, mainnet } from 'wagmi/chains';

export const wagmiConfig = getDefaultConfig({
  appName: 'PerkOS Knowledge',
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || 'perkOS-knowledge-preview',
  chains: [base, celo, mainnet],
  ssr: true
});
