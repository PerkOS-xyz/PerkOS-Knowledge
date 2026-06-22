/**
 * GET /api/claims/:wallet — a wallet's claim entry + Merkle proof from the
 * latest distribution, for the dashboard's on-chain claim. Public: the proof is
 * postable on-chain by anyone and funds always go to `wallet`, so it's not
 * sensitive. Returns null `claim` when the wallet isn't in the current root.
 */
import { getWalletClaim } from "../../../../lib/claim";
import { withDb } from "../../../../lib/db";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ wallet: string }> },
) {
  const { wallet } = await context.params;
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    return Response.json({ ok: false, error: "bad_wallet" }, { status: 400 });
  }
  const claim = await withDb((c) => getWalletClaim(c, wallet));
  return Response.json({
    ok: true,
    vaultAddress: process.env.KNOWLEDGE_CLAIM_VAULT_ADDRESS || null,
    perkosToken: process.env.KNOWLEDGE_PERKOS_TOKEN_ADDRESS || null,
    usdcToken: process.env.KNOWLEDGE_USDC_ADDRESS || process.env.KNOWLEDGE_X402_TOKEN || null,
    chain: process.env.KNOWLEDGE_X402_CHAIN || "base",
    claim,
  });
}
