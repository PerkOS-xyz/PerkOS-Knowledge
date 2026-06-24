'use client';

import { getDefaultConfig } from '@rainbow-me/rainbowkit';
import { http } from 'wagmi';
import { base, baseSepolia, celo, mainnet } from 'wagmi/chains';

export const wagmiConfig = getDefaultConfig({
  appName: 'PerkOS Knowledge',
  projectId: process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID || 'perkOS-knowledge-preview',
  // baseSepolia for the claim vault on testnet before mainnet.
  chains: [base, baseSepolia, celo, mainnet],
  // mainnet is only here so RainbowKit can resolve ENS names. Its default public
  // RPC (eth.merkle.io) blocks browser requests (no CORS header), which spams the
  // console and fails ENS resolution — point it at a CORS-friendly RPC instead.
  // Base/Celo/baseSepolia defaults already allow CORS, so keep them.
  transports: {
    [base.id]: http(),
    [baseSepolia.id]: http(),
    [celo.id]: http(),
    [mainnet.id]: http('https://ethereum-rpc.publicnode.com'),
  },
  ssr: true,
});
