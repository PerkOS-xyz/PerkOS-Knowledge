/**
 * Admin: tokenomics config — the editable economics of the knowledge market.
 *
 *   GET  /api/admin/tokenomics   → { config, summary }
 *   POST /api/admin/tokenomics   body: partial config patch
 *
 * Lets an admin tune per-tier prices, the fee waterfall (provider / platform /
 * reward bps), the reward split, mode, and the buyback flag without a redeploy.
 * Admin-gated (allowlisted wallet via x-admin-wallet, or KNOWLEDGE_ADMIN_TOKEN).
 */
import { requireAdmin } from "../../../../lib/admin";
import { withDb } from "../../../../lib/db";
import {
  loadTokenomics,
  saveTokenomics,
  tokenomicsSummary,
  validateFees,
  type TokenomicsPatch,
} from "../../../../lib/tokenomics";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  const blocked = requireAdmin(request);
  if (blocked) return blocked;
  const data = await withDb(async (c) => ({
    config: await loadTokenomics(c),
    summary: await tokenomicsSummary(c),
  }));
  return Response.json({ ok: true, ...data });
}

const TIERS = ["public", "private", "premium", "enterprise"] as const;
const num = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isFinite(v) ? v : undefined;
const int = (v: unknown): number | undefined =>
  typeof v === "number" && Number.isInteger(v) ? v : undefined;

export async function POST(request: Request) {
  const blocked = requireAdmin(request);
  if (blocked) return blocked;

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const patch: TokenomicsPatch = {};

  if (typeof body.mode === "string") patch.mode = body.mode;
  if (body.prices && typeof body.prices === "object") {
    patch.prices = {};
    for (const t of TIERS) {
      const v = num((body.prices as Record<string, unknown>)[t]);
      if (v !== undefined && v >= 0) patch.prices[t] = v;
    }
  }
  if (int(body.feeProviderBps) !== undefined) patch.feeProviderBps = body.feeProviderBps as number;
  if (int(body.feePlatformBps) !== undefined) patch.feePlatformBps = body.feePlatformBps as number;
  if (int(body.feeRewardBps) !== undefined) patch.feeRewardBps = body.feeRewardBps as number;
  if (int(body.rewardResearcherBps) !== undefined)
    patch.rewardResearcherBps = body.rewardResearcherBps as number;
  if (typeof body.buybackEnabled === "boolean") patch.buybackEnabled = body.buybackEnabled;
  if (num(body.buybackThreshold) !== undefined) patch.buybackThreshold = body.buybackThreshold as number;

  const updatedBy = request.headers.get("x-admin-wallet") || "admin";

  const result = await withDb(async (c) => {
    const cur = await loadTokenomics(c);
    const provider = patch.feeProviderBps ?? cur.feeProviderBps;
    const platform = patch.feePlatformBps ?? cur.feePlatformBps;
    const reward = patch.feeRewardBps ?? cur.feeRewardBps;
    const feeErr = validateFees(provider, platform, reward);
    if (feeErr) return { ok: false as const, error: feeErr };
    const researcher = patch.rewardResearcherBps ?? cur.rewardResearcherBps;
    if (researcher < 0 || researcher > 10000)
      return { ok: false as const, error: "rewardResearcherBps must be 0..10000" };
    await saveTokenomics(c, patch, updatedBy);
    return { ok: true as const, config: await loadTokenomics(c) };
  });

  return Response.json(result, { status: result.ok ? 200 : 400 });
}
