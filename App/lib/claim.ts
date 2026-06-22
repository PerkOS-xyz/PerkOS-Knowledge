/**
 * Claim distributions — the off-chain half of PerkosClaimVault (pull model).
 *
 * Each distribution rolls up every wallet's CUMULATIVE owed amounts and builds a
 * Merkle tree whose root the platform posts on-chain. Participants then PULL
 * from their dashboard: the vault releases the delta vs. what they've already
 * claimed. The tree uses @openzeppelin/merkle-tree's StandardMerkleTree with
 * leaf types ["address","uint256","uint256"] — byte-identical to the contract's
 *   leaf = keccak256(bytes.concat(keccak256(abi.encode(account, cumUsdc, cumReward))))
 * so the off-chain proofs verify on-chain.
 *
 * Amounts are TOKEN BASE UNITS (USDC 6-dec, $PERKOS 18-dec):
 *  - cumUsdc   = the wallet's cumulative provider earnings (agent_accounts.total_earned).
 *  - cumReward = the wallet's cumulative $PERKOS reward (token_rewards, filled by
 *                the buyback — 0 until that's wired).
 */
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";
import { parseUnits } from "viem";
import type { Client } from "pg";

export type ClaimEntry = { wallet: string; cumUsdc: bigint; cumReward: bigint };

const LEAF_TYPES = ["address", "uint256", "uint256"];

/** Decimal USDC (e.g. 0.075) → base units (75000 at 6 decimals). */
export function usdcBaseUnits(amount: number): bigint {
  const dec = Number(process.env.KNOWLEDGE_USDC_DECIMALS || 6);
  if (!(amount > 0)) return 0n;
  return parseUnits(amount.toFixed(dec), dec);
}

export function buildTree(entries: ClaimEntry[]): StandardMerkleTree<string[]> {
  const values = entries.map((e) => [e.wallet, e.cumUsdc.toString(), e.cumReward.toString()]);
  return StandardMerkleTree.of(values, LEAF_TYPES);
}

export type BuiltDistribution = {
  root: string;
  dump: ReturnType<StandardMerkleTree<string[]>["dump"]>;
  totalUsdc: bigint;
  totalReward: bigint;
  entryCount: number;
};

/** Build a tree from entries with anything owed; null if nobody is owed. */
export function buildDistribution(entries: ClaimEntry[]): BuiltDistribution | null {
  const usable = entries.filter((e) => e.cumUsdc > 0n || e.cumReward > 0n);
  if (usable.length === 0) return null;
  const tree = buildTree(usable);
  return {
    root: tree.root,
    dump: tree.dump(),
    totalUsdc: usable.reduce((a, e) => a + e.cumUsdc, 0n),
    totalReward: usable.reduce((a, e) => a + e.cumReward, 0n),
    entryCount: usable.length,
  };
}

/**
 * Per-wallet cumulative claimable USDC earnings ON A CHAIN. Provider earnings are
 * segregated by the chain the consumer paid on (`knowledge_attributions.chain`),
 * so each chain's distribution is independent — a provider claims their Base
 * earnings on Base and their Celo earnings on Celo, never the same amount twice.
 * cumReward stays 0 until the per-chain $PERKOS buyback is wired.
 */
export async function rollupEntries(client: Client, chain: string): Promise<ClaimEntry[]> {
  const r = await client.query(
    `SELECT lower(provider_wallet) w, coalesce(sum(amount),0)::float8 e
       FROM knowledge_attributions
       WHERE lower(chain) = lower($1) AND provider_wallet IS NOT NULL
       GROUP BY 1 HAVING sum(amount) > 0`,
    [chain],
  );
  return (r.rows as { w: string; e: number }[]).map((row) => ({
    wallet: row.w,
    cumUsdc: usdcBaseUnits(row.e),
    cumReward: 0n,
  }));
}

export async function persistDistribution(
  client: Client,
  d: BuiltDistribution,
  chain: string,
  createdBy: string | null,
): Promise<number> {
  const r = await client.query(
    `INSERT INTO claim_distributions (chain, root, tree_dump, total_usdc, total_reward, entry_count, created_by)
     VALUES ($1, $2, $3::jsonb, $4, $5, $6, $7) RETURNING id`,
    [chain, d.root, JSON.stringify(d.dump), d.totalUsdc.toString(), d.totalReward.toString(), d.entryCount, createdBy],
  );
  return r.rows[0].id as number;
}

export type WalletClaim = {
  wallet: string;
  cumUsdc: string;
  cumReward: string;
  proof: string[];
  root: string;
  distributionId: number;
  posted: boolean;
} | null;

/** A wallet's entry + Merkle proof from the latest distribution ON A CHAIN. */
export async function getWalletClaim(client: Client, wallet: string, chain: string): Promise<WalletClaim> {
  const w = wallet.toLowerCase();
  const r = await client.query(
    `SELECT id, root, tree_dump, posted FROM claim_distributions WHERE lower(chain) = lower($1) ORDER BY created_at DESC LIMIT 1`,
    [chain],
  );
  if (!r.rows[0]) return null;
  const tree = StandardMerkleTree.load(r.rows[0].tree_dump);
  for (const [i, v] of tree.entries()) {
    if (String(v[0]).toLowerCase() === w) {
      return {
        wallet: w,
        cumUsdc: String(v[1]),
        cumReward: String(v[2]),
        proof: tree.getProof(i),
        root: r.rows[0].root,
        distributionId: r.rows[0].id,
        posted: Boolean(r.rows[0].posted),
      };
    }
  }
  return null;
}
