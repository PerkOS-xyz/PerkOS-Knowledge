import type { Metadata } from 'next';
import Web3Providers from '../components/Web3Providers';
import './styles.css';

export const metadata: Metadata = {
  title: 'PerkOS Knowledge',
  description: 'A live knowledge layer for AI agents, powered by curated research and x402 access.'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body><Web3Providers>{children}</Web3Providers></body>
    </html>
  );
}
