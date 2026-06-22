import { describe, expect, it } from "vitest";
import { encodeAbiParameters, keccak256 } from "viem";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";

import { buildDistribution, buildTree, usdcBaseUnits } from "../lib/claim";

const A = "0x1111111111111111111111111111111111111111";
const B = "0x2222222222222222222222222222222222222222";
const TYPES = ["address", "uint256", "uint256"];

/** Exactly what PerkosClaimVault.claim computes for the leaf. */
function contractLeaf(acct: string, u: bigint, r: bigint): string {
  const inner = keccak256(
    encodeAbiParameters(
      [{ type: "address" }, { type: "uint256" }, { type: "uint256" }],
      [acct as `0x${string}`, u, r],
    ),
  );
  return keccak256(inner);
}

describe("usdcBaseUnits", () => {
  it("converts decimal USDC to 6-dec base units", () => {
    expect(usdcBaseUnits(0.075)).toBe(75000n);
    expect(usdcBaseUnits(1)).toBe(1_000000n);
    expect(usdcBaseUnits(0.01)).toBe(10000n);
    expect(usdcBaseUnits(0)).toBe(0n);
    expect(usdcBaseUnits(-5)).toBe(0n);
  });
});

describe("leaf format is byte-identical to the contract", () => {
  it("StandardMerkleTree leaf == keccak256(keccak256(abi.encode(account,u,r)))", () => {
    const tree = buildTree([
      { wallet: A, cumUsdc: 100n, cumReward: 50n },
      { wallet: B, cumUsdc: 7n, cumReward: 0n },
    ]);
    for (const [, v] of tree.entries()) {
      expect(tree.leafHash(v)).toBe(contractLeaf(v[0], BigInt(v[1]), BigInt(v[2])));
    }
  });
});

describe("buildDistribution", () => {
  it("builds verifiable proofs + sums totals", () => {
    const d = buildDistribution([
      { wallet: A, cumUsdc: 100n, cumReward: 50n },
      { wallet: B, cumUsdc: 7n, cumReward: 0n },
    ]);
    expect(d).not.toBeNull();
    expect(d!.entryCount).toBe(2);
    expect(d!.totalUsdc).toBe(107n);
    expect(d!.totalReward).toBe(50n);
    const tree = StandardMerkleTree.load(d!.dump);
    for (const [i, v] of tree.entries()) {
      expect(StandardMerkleTree.verify(d!.root, TYPES, v, tree.getProof(i))).toBe(true);
    }
  });
  it("drops zero entries and returns null when nobody is owed", () => {
    expect(buildDistribution([{ wallet: A, cumUsdc: 0n, cumReward: 0n }])).toBeNull();
    expect(buildDistribution([])).toBeNull();
  });
  it("a tampered amount fails verification against the root", () => {
    const d = buildDistribution([
      { wallet: A, cumUsdc: 100n, cumReward: 50n },
      { wallet: B, cumUsdc: 7n, cumReward: 0n },
    ])!;
    const tree = StandardMerkleTree.load(d.dump);
    const [i, v] = [...tree.entries()][0];
    expect(StandardMerkleTree.verify(d.root, TYPES, [v[0], "999", v[2]], tree.getProof(i))).toBe(false);
  });
});
