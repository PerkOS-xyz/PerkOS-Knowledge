/**
 * Admin: per-agent billing / whitelist.
 *
 *   GET  /api/admin/billing            → { rows: [...] }   (current config)
 *   POST /api/admin/billing            body:
 *     { agentId, exempt?, role?, wallet?, note? }
 *
 * `exempt: true` = the agent queries for free (PerkOS internal / research
 * agents). `role` = consumer | provider | both. Admin-token gated.
 */
import { requireAdmin } from "../../../../lib/admin";
import { setBilling } from "../../../../lib/credits";
import { withDb } from "../../../../lib/db";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const unauthorized = requireAdmin(request);
  if (unauthorized) return unauthorized;

  const rows = await withDb(async (client) => {
    const r = await client.query(
      `SELECT agent_id, wallet, exempt, role, note, updated_by, updated_at
         FROM agent_billing ORDER BY updated_at DESC LIMIT 500`,
    );
    return r.rows;
  });
  return Response.json({ ok: true, count: rows.length, rows });
}

export async function POST(request: Request) {
  const unauthorized = requireAdmin(request);
  if (unauthorized) return unauthorized;

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const agentId = typeof body.agentId === "string" ? body.agentId.trim() : "";
  if (!agentId) {
    return Response.json({ ok: false, error: "agentId_required" }, { status: 400 });
  }
  const role = typeof body.role === "string" ? body.role : undefined;
  const updatedBy = String(request.headers.get("x-admin-actor") || "admin");

  await withDb((client) =>
    setBilling(client, {
      agentId,
      wallet: typeof body.wallet === "string" ? body.wallet : null,
      exempt: body.exempt === true,
      role,
      note: typeof body.note === "string" ? body.note : null,
      updatedBy,
    }),
  );

  return Response.json({ ok: true, agentId, exempt: body.exempt === true, role: role ?? "consumer" });
}
