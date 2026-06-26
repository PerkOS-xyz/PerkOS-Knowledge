/**
 * POST /api/admin/rewards/distribute — the ACCOUNTING half of a monthly drop,
 * called AFTER the on-chain buyback swap lands $PERKOS in the treasury.
 *
 * Body: { month?: "YYYY-MM", chain?: "base"|"celo", perkosBought: "<18-dec base
 *         units>", execute?: boolean }
 *
 * execute=false (default) → dry-run: returns what would be written (platform cut,
 * user pool, per-wallet shares) without touching the DB.
 * execute=true → writes token_rewards (each wallet's usage-weighted $PERKOS) +
 * marks that month's pending reward_pool rows distributed. The caller then funds
 * the vault with the user $PERKOS + posts the per-chain root (claim scripts).
 *
 * No on-chain work here (the swap + fund + root are the operator's job with the
 * treasury key). Admin-gated.
 */
import { requireAdmin } from "../../../../../lib/admin";
import { withDb } from "../../../../../lib/db";
import { computeMonthlyDrop, distributeDrop } from "../../../../../lib/rewardsDrop";

export const dynamic = "force-dynamic";

function currentMonthUtc(): string {
  const now = new Date();
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

export async function POST(request: Request) {
  const unauthorized = requireAdmin(request);
  if (unauthorized) return unauthorized;

  const body = (await request.json().catch(() => ({}))) as Record<string, unknown>;
  const month = typeof body.month === "string" && body.month.trim() ? body.month.trim() : currentMonthUtc();
  const chain = body.chain === "celo" ? "celo" : "base";
  const execute = body.execute === true;

  let perkosBought: bigint;
  try {
    perkosBought = BigInt(String(body.perkosBought ?? "0"));
  } catch {
    return Response.json({ ok: false, error: "perkosBought must be an integer (18-dec base units)" }, { status: 400 });
  }
  if (perkosBought <= 0n) {
    return Response.json({ ok: false, error: "perkosBought must be > 0" }, { status: 400 });
  }

  try {
    if (!execute) {
      // Dry-run: show the plan without writing.
      const drop = await withDb((c) => computeMonthlyDrop(c, { month, chain }));
      const platformPerkos = (perkosBought * BigInt(drop.platformBps)) / 10000n;
      const userPerkos = perkosBought - platformPerkos;
      const totalScaled = BigInt(Math.round(drop.totalActivity * 1e6));
      const perWallet = drop.wallets.map((w) => ({
        wallet: w.wallet,
        sharePct: w.sharePct,
        perkos: totalScaled > 0n ? ((userPerkos * BigInt(Math.round(w.activity * 1e6))) / totalScaled).toString() : "0",
      }));
      return Response.json({ ok: true, dryRun: true, plan: { month, chain, perkosBought: perkosBought.toString(), platformPerkos: platformPerkos.toString(), userPerkos: userPerkos.toString(), walletCount: drop.wallets.length, perWallet } });
    }
    const result = await withDb((c) => distributeDrop(c, { month, chain, perkosBoughtBaseUnits: perkosBought }));
    return Response.json({ ok: true, dryRun: false, distribution: result });
  } catch (e) {
    return Response.json({ ok: false, error: e instanceof Error ? e.message : "distribute_failed" }, { status: 400 });
  }
}
