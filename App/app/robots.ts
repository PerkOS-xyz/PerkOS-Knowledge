import type { MetadataRoute } from 'next';

// Only the landing is meant to be indexed. The dashboard and admin views are
// wallet-gated, and everything under /api, /knowledge and /skill is an
// endpoint for agents, not a page for readers.
export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      disallow: ['/admin', '/dashboard', '/api/', '/knowledge/', '/skill/', '/healthz']
    },
    sitemap: 'https://knowledge.perkos.xyz/sitemap.xml',
    host: 'https://knowledge.perkos.xyz'
  };
}
