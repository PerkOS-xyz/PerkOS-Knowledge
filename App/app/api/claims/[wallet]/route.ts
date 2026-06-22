/**
 * GET /api/claims/:wallet — a wallet's claim entry + Merkle proof PER CHAIN
 * (Base, Celo) from the latest per-chain distribution, for the dashboard's
 * on-chain claim. The vault has the same address on every chain; each chain's
 * claim uses that chain's root + that chain's USDC/$PERKOS. Public (the proof is
 * postable by anyone; funds always go to `wallet`).
 */
import { getWalletClaim } from "../../../../lib/claim";
import { withDb } from "../../../../lib/db";
import { NETWORKS, type PayNetwork } from "../../../../lib/payments";

export const dynamic = "force-dynamic";

const PERKOS: Record<PayNetwork, string> = {
  base: "0xF714E60f85497D70508F7E356b5DB80e64539BA3",
  celo: "0xb7Ba43fBD4F2E85FCE929f7d4DFE3905Ae846A46",
};
const CHAINS: PayNetwork[] = ["base", "celo"];

export async function GET(
  _request: Request,
  context: { params: Promise<{ wallet: string }> },
) {
  const { wallet } = await context.params;
  if (!/^0x[0-9a-fA-F]{40}$/.test(wallet)) {
    return Response.json({ ok: false, error: "bad_wallet" }, { status: 400 });
  }
  const vaultAddress = process.env.KNOWLEDGE_CLAIM_VAULT_ADDRESS || null;
  const perChain = await withDb(async (c) =>
    Promise.all(
      CHAINS.map(async (chain) => ({
        chain,
        chainId: NETWORKS[chain].chainId,
        usdc: NETWORKS[chain].usdc,
        perkos: PERKOS[chain],
        claim: await getWalletClaim(c, wallet, chain),
      })),
    ),
  );
  return Response.json({ ok: true, vaultAddress, chains: perChain });
}
