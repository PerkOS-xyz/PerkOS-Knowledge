import { getX402Policy, type X402Tier } from '../../../../lib/x402';
import { withDb } from '../../../../lib/db';
import { loadTokenomics, priceForTier } from '../../../../lib/tokenomics';

export const dynamic = 'force-dynamic';

const TIERS: X402Tier[] = ['public', 'private', 'premium', 'enterprise'];

export async function GET() {
  // Prices come from the admin-editable tokenomics config (same source the
  // charging path uses), so a quoted price always matches what we charge.
  const cfg = await withDb((c) => loadTokenomics(c));
  return Response.json({
    ok: true,
    mode: cfg.mode,
    policies: TIERS.map((t) => {
      const p = getX402Policy('/skill/query', t, priceForTier(cfg, t));
      p.mode = cfg.mode;
      return p;
    }),
    headers: ['x-payment', 'x-x402-payment', 'x402-receipt'],
    note: 'metered_free records usage/payment metadata without blocking requests. enforce mode returns HTTP 402 when payment is required and missing/invalid/underpaid. credit mode debits a prepaid balance. enterprise = validated-only knowledge. Settlement addresses remain hidden unless explicitly configured for public exposure.',
  });
}
