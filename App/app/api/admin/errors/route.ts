/**
 * GET /api/admin/errors — recent system errors for the admin error log.
 *
 *   ?limit=100   (max 500)
 *   ?scope=deposit.settle   (optional filter)
 *
 * Admin-gated (Bearer token or allowlisted wallet via x-admin-wallet).
 */
import { requireAdmin } from "../../../../lib/admin";
import { withDb } from "../../../../lib/db";
import { recentErrors } from "../../../../lib/errlog";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const unauthorized = requireAdmin(request);
  if (unauthorized) return unauthorized;

  const url = new URL(request.url);
  const limit = Number(url.searchParams.get("limit") || 100);
  const scope = url.searchParams.get("scope")?.trim() || undefined;

  const errors = await withDb((c) => recentErrors(c, { limit, scope }));
  return Response.json({ ok: true, errors, ts: new Date().toISOString() });
}
