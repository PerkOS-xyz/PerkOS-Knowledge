/**
 * POST /api/admin/claims/mark-posted — flip a distribution's `posted` flag once
 * its Merkle root is live on-chain (after setMerkleRoot).
 *
 * Body: { chain: "base"|"celo", root: "0x…", txHash?: "0x…" }
 *
 * Until this is called the dashboard shows "root pending on-chain" for that
 * chain's claims (the proof still validates against the on-chain root either
 * way — this is the display hint). The monthly-drop orchestrator + the manual
 * claim-publish flow call it right after posting the root. Admin-gated.
 */
import { requireAdmin } from "../../../../../lib/admin";
import { withDb } from "../../../../../lib/db";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const blocked = requireAdmin(request);
  if (blocked) return blocked;

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const chain = body.chain === "celo" ? "celo" : "base";
  const root = typeof body.root === "string" ? body.root.trim() : "";
  const txHash = typeof body.txHash === "string" && body.txHash.trim() ? body.txHash.trim() : null;
  if (!/^0x[0-9a-fA-F]{64}$/.test(root)) {
    return Response.json({ ok: false, error: "root must be 0x + 64 hex" }, { status: 400 });
  }

  const updated = await withDb(async (c) => {
    const r = await c.query(
      `UPDATE claim_distributions SET posted = true, tx_hash = COALESCE($3, tx_hash)
       WHERE lower(chain) = lower($1) AND lower(root) = lower($2)`,
      [chain, root, txHash],
    );
    return r.rowCount ?? 0;
  });
  if (updated === 0) {
    return Response.json({ ok: false, error: "no_distribution_matched" }, { status: 404 });
  }
  return Response.json({ ok: true, chain, root, txHash, updated });
}
