import { requireAdmin } from '../../../../../../lib/admin';

export const dynamic = 'force-dynamic';

function facilitatorEndpoint() {
  const base = (process.env.KNOWLEDGE_X402_FACILITATOR_URL || '').replace(/\/$/, '');
  if (!base) return null;
  const path = process.env.KNOWLEDGE_X402_FACILITATOR_HEALTH_PATH || '/health';
  return `${base}${path.startsWith('/') ? path : `/${path}`}`;
}

export async function POST(request: Request) {
  const blocked = requireAdmin(request);
  if (blocked) return blocked;

  const endpoint = facilitatorEndpoint();
  if (!endpoint) {
    return Response.json({
      ok: true,
      configured: false,
      status: 'not_configured',
      note: 'Set KNOWLEDGE_X402_FACILITATOR_URL before enabling enforce mode.',
    });
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), Number(process.env.KNOWLEDGE_X402_VERIFY_TIMEOUT_MS || 8000));
  try {
    const res = await fetch(endpoint, { signal: controller.signal });
    return Response.json({
      ok: res.ok,
      configured: true,
      status: res.ok ? 'reachable' : 'unhealthy',
      httpStatus: res.status,
    }, { status: res.ok ? 200 : 502 });
  } catch (error) {
    return Response.json({
      ok: false,
      configured: true,
      status: 'unreachable',
      error: error instanceof Error ? error.name : 'unknown_error',
    }, { status: 502 });
  } finally {
    clearTimeout(timeout);
  }
}
