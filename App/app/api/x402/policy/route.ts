import { getX402Policy } from '../../../../lib/x402';

export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({
    ok: true,
    policies: [
      getX402Policy('/skill/query', 'public'),
      getX402Policy('/skill/query', 'private'),
      getX402Policy('/skill/query', 'premium'),
    ],
    headers: ['x-payment', 'x-x402-payment', 'x402-receipt'],
    note: 'metered_free records usage/payment metadata without blocking requests. enforce mode returns HTTP 402 when payment is required and missing/invalid/underpaid. Settlement addresses remain hidden unless explicitly configured for public exposure.',
  });
}
