import { requireAdmin } from '../../../../../lib/admin';
import { getX402Policy } from '../../../../../lib/x402';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const blocked = requireAdmin(request);
  if (blocked) return blocked;

  return Response.json({
    ok: true,
    mode: process.env.KNOWLEDGE_X402_MODE || 'metered_free',
    settlementExposure: process.env.KNOWLEDGE_X402_EXPOSE_SETTLEMENT === 'true' ? 'public' : 'hidden',
    policies: [
      getX402Policy('/skill/query', 'public'),
      getX402Policy('/skill/query', 'private'),
      getX402Policy('/skill/query', 'premium'),
    ],
    env: {
      KNOWLEDGE_X402_MODE: process.env.KNOWLEDGE_X402_MODE ? 'configured' : 'default_metered_free',
      KNOWLEDGE_X402_PUBLIC_PRICE_AMOUNT: process.env.KNOWLEDGE_X402_PUBLIC_PRICE_AMOUNT ? 'configured' : 'default',
      KNOWLEDGE_X402_PRIVATE_PRICE_AMOUNT: process.env.KNOWLEDGE_X402_PRIVATE_PRICE_AMOUNT ? 'configured' : 'default',
      KNOWLEDGE_X402_PREMIUM_PRICE_AMOUNT: process.env.KNOWLEDGE_X402_PREMIUM_PRICE_AMOUNT ? 'configured' : 'default',
      KNOWLEDGE_X402_TOKEN: process.env.KNOWLEDGE_X402_TOKEN ? 'configured' : 'not_configured',
      KNOWLEDGE_X402_PAY_TO: process.env.KNOWLEDGE_X402_PAY_TO ? 'configured' : 'not_configured',
    },
  });
}
