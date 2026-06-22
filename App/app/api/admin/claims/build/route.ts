/**
 * Admin: claim distributions — PER CHAIN.
 *
 *   GET  /api/admin/claims/build   → preview the current roll-up per chain
 *   POST /api/admin/claims/build   → build + persist a distribution per chain
 *
 * Provider earnings are segregated by the chain the consumer paid on, so each
 * chain (Base, Celo) gets its own Merkle root — a provider claims their Base
 * earnings on Base and Celo earnings on Celo (no cross-chain double-claim). For
 * each chain with earnings, the returned `root` is posted to PerkosClaimVault on
 * THAT chain (claim-publish.sh) after funding the vault there (vault-fund.sh).
 * On-chain post + fund are operator actions, not done here. Admin-gated.
 */
import { requireAdmin } from "../../../../../lib/admin";
import { buildDistribution, persistDistribution, rollupEntries } from "../../../../../lib/claim";
import { withDb } from "../../../../../lib/db";

export const dynamic = "force-dynamic";

const CHAINS = ["base", "celo"];

export async function GET(request: Request) {
  const blocked = requireAdmin(request);
  if (blocked) return blocked;
  const preview = await withDb(async (c) => {
    const out: Record<string, unknown>[] = [];
    for (const chain of CHAINS) {
      const dist = buildDistribution(await rollupEntries(c, chain));
      if (dist) out.push({ chain, root: dist.root, entryCount: dist.entryCount, totalUsdc: dist.totalUsdc.toString() });
    }
    return out;
  });
  return Response.json({
    ok: true,
    preview,
    vaultAddress: process.env.KNOWLEDGE_CLAIM_VAULT_ADDRESS || null,
  });
}

export async function POST(request: Request) {
  const blocked = requireAdmin(request);
  if (blocked) return blocked;
  const createdBy = request.headers.get("x-admin-wallet") || "admin";
  const distributions = await withDb(async (c) => {
    const out: Record<string, unknown>[] = [];
    for (const chain of CHAINS) {
      const dist = buildDistribution(await rollupEntries(c, chain));
      if (!dist) continue;
      const id = await persistDistribution(c, dist, chain, createdBy);
      out.push({
        chain,
        distributionId: id,
        root: dist.root,
        entryCount: dist.entryCount,
        totalUsdc: dist.totalUsdc.toString(),
      });
    }
    return out;
  });
  if (distributions.length === 0) {
    return Response.json({ ok: false, error: "nothing_to_distribute" }, { status: 400 });
  }
  return Response.json({
    ok: true,
    distributions,
    vaultAddress: process.env.KNOWLEDGE_CLAIM_VAULT_ADDRESS || null,
    note: "Per chain: fund the vault (vault-fund.sh) + post the root (claim-publish.sh) on that chain.",
  });
}
