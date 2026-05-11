import { isAllowedWallet } from '../../../../lib/auth';

export const dynamic = 'force-dynamic';

export async function GET(_request: Request, context: { params: Promise<{ wallet: string }> }) {
  const { wallet } = await context.params;
  const allowed = isAllowedWallet(wallet);

  return Response.json({
    ok: true,
    access: {
      status: allowed ? 'allowed' : 'denied',
      method: 'wallet_allowlist',
      dashboard: allowed,
    },
    ts: new Date().toISOString(),
  }, { status: allowed ? 200 : 403 });
}
