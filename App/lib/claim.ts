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

/** Per-wallet cumulative claimable: earnings (USDC) + reward ($PERKOS, base units). */
export async function rollupEntries(client: Client): Promise<ClaimEntry[]> {
  const [earned, rewards] = await Promise.all([
    client.query(`SELECT lower(wallet) w, total_earned::float8 e FROM agent_accounts WHERE total_earned > 0`),
    client
      .query(`SELECT lower(wallet) w, cumulative_perkos::text p FROM token_rewards WHERE cumulative_perkos > 0`)
      .catch(() => ({ rows: [] as { w: string; p: string }[] })),
  ]);
  const rewardMap = new Map<string, bigint>(
    (rewards.rows as { w: string; p: string }[]).map((r) => [r.w, BigInt(r.p)]),
  );
  const byWallet = new Map<string, ClaimEntry>();
  for (const row of earned.rows as { w: string; e: number }[]) {
    byWallet.set(row.w, { wallet: row.w, cumUsdc: usdcBaseUnits(row.e), cumReward: rewardMap.get(row.w) ?? 0n });
  }
  for (const [w, p] of rewardMap) {
    if (!byWallet.has(w)) byWallet.set(w, { wallet: w, cumUsdc: 0n, cumReward: p });
  }
  return [...byWallet.values()];
}

export async function persistDistribution(
  client: Client,
  d: BuiltDistribution,
  createdBy: string | null,
): Promise<number> {
  const r = await client.query(
    `INSERT INTO claim_distributions (root, tree_dump, total_usdc, total_reward, entry_count, created_by)
     VALUES ($1, $2::jsonb, $3, $4, $5, $6) RETURNING id`,
    [d.root, JSON.stringify(d.dump), d.totalUsdc.toString(), d.totalReward.toString(), d.entryCount, createdBy],
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

/** A wallet's entry + Merkle proof from the latest distribution (for on-chain claim). */
export async function getWalletClaim(client: Client, wallet: string): Promise<WalletClaim> {
  const w = wallet.toLowerCase();
  const r = await client.query(
    `SELECT id, root, tree_dump, posted FROM claim_distributions ORDER BY created_at DESC LIMIT 1`,
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
