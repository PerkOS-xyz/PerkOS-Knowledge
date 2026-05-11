import { getX402Policy } from '../../../../lib/x402';

export const dynamic = 'force-dynamic';

export async function GET() {
  return Response.json({
    ok: true,
    policies: [getX402Policy('/skill/query')],
    note: 'metered_free records usage/payment metadata without blocking requests. enforce mode returns HTTP 402 when payment is required and missing.',
  });
}
