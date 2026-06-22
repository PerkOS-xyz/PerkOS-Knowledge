import { requireAdmin } from '../../../../../lib/admin';
import { getX402Policy, type X402Tier } from '../../../../../lib/x402';
import { withDb } from '../../../../../lib/db';
import { loadTokenomics, priceForTier } from '../../../../../lib/tokenomics';

export const dynamic = 'force-dynamic';

function configured(name: string, emptyValues: string[] = []) {
  const value = process.env[name];
  if (!value) return false;
  return !emptyValues.includes(value);
}

const TIERS: X402Tier[] = ['public', 'private', 'premium', 'enterprise'];

export async function GET(request: Request) {
  const blocked = requireAdmin(request);
  if (blocked) return blocked;

  const cfg = await withDb((c) => loadTokenomics(c));

  return Response.json({
    ok: true,
    mode: cfg.mode,
    settlementExposure: process.env.KNOWLEDGE_X402_EXPOSE_SETTLEMENT === 'true' ? 'public' : 'hidden',
    facilitator: {
      configured: Boolean(process.env.KNOWLEDGE_X402_FACILITATOR_URL),
      verifyPath: process.env.KNOWLEDGE_X402_FACILITATOR_VERIFY_PATH || '/verify',
      requireInEnforceMode: process.env.KNOWLEDGE_X402_REQUIRE_FACILITATOR !== 'false',
      timeoutMs: Number(process.env.KNOWLEDGE_X402_VERIFY_TIMEOUT_MS || 8000),
    },
    policies: TIERS.map((t) => {
      const p = getX402Policy('/skill/query', t, priceForTier(cfg, t));
      p.mode = cfg.mode;
      return p;
    }),
    env: {
      KNOWLEDGE_X402_MODE: configured('KNOWLEDGE_X402_MODE') ? 'configured' : 'default_metered_free',
      KNOWLEDGE_X402_PUBLIC_PRICE_AMOUNT: configured('KNOWLEDGE_X402_PUBLIC_PRICE_AMOUNT') ? 'configured' : 'default',
      KNOWLEDGE_X402_PRIVATE_PRICE_AMOUNT: configured('KNOWLEDGE_X402_PRIVATE_PRICE_AMOUNT') ? 'configured' : 'default',
      KNOWLEDGE_X402_PREMIUM_PRICE_AMOUNT: configured('KNOWLEDGE_X402_PREMIUM_PRICE_AMOUNT') ? 'configured' : 'default',
      KNOWLEDGE_X402_TOKEN: configured('KNOWLEDGE_X402_TOKEN', ['not_configured']) ? 'configured' : 'not_configured',
      KNOWLEDGE_X402_PAY_TO: configured('KNOWLEDGE_X402_PAY_TO', ['not_configured']) ? 'configured' : 'not_configured',
      KNOWLEDGE_X402_FACILITATOR_URL: configured('KNOWLEDGE_X402_FACILITATOR_URL') ? 'configured' : 'not_configured',
    },
  });
}
