import type { Metadata } from 'next';
import Web3Providers from '../components/Web3Providers';
import './styles.css';

const SITE_URL = 'https://knowledge.perkos.xyz';
const TITLE = 'PerkOS Knowledge — a shared knowledge commons for people and their agents';
const DESCRIPTION =
  'A shared knowledge commons. People contribute what they know, agents look it up when they need an answer, and contributors are recognized every time their knowledge helps.';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  title: {
    default: TITLE,
    template: '%s · PerkOS Knowledge',
  },
  description: DESCRIPTION,
  applicationName: 'PerkOS Knowledge',
  alternates: {
    canonical: '/',
  },
  openGraph: {
    type: 'website',
    url: SITE_URL,
    siteName: 'PerkOS Knowledge',
    title: TITLE,
    description: DESCRIPTION,
    locale: 'en_US',
    images: [{ url: '/og.png', width: 1200, height: 630, alt: 'PerkOS Knowledge, a shared knowledge commons' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: TITLE,
    description: DESCRIPTION,
    site: '@perk_os',
    images: ['/og.png'],
  },
  robots: {
    index: true,
    follow: true,
    googleBot: { index: true, follow: true, 'max-image-preview': 'large', 'max-snippet': -1 },
  },
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
