import type { Metadata } from 'next';
import './styles.css';

export const metadata: Metadata = {
  title: 'PerkOS Knowledge',
  description: 'A live knowledge layer for AI agents, powered by Perky research and x402 access.'
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
