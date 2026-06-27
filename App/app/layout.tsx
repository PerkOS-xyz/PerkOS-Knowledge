import type { Metadata } from 'next';
import Web3Providers from '../components/Web3Providers';
import './styles.css';

export const metadata: Metadata = {
  title: 'PerkOS Knowledge',
  description: 'A live knowledge layer for AI agents, powered by curated research and x402 access.',
  other: {
    'talentapp:project_verification':
      '6312cbdecd6b0d974fb841350d907866a1bc2ed3a10c7ac2057d9b747a3ef7ef662b202d1a8fcedc67ada1a5cc3d5cbddaf052fc7952b9a911c7c0fca1d4a572',
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body><Web3Providers>{children}</Web3Providers></body>
    </html>
  );
}
