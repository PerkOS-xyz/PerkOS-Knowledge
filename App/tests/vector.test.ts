import { describe, expect, it } from "vitest";

import { embedText, VECTOR_SIZE } from "../lib/vector";

describe("VECTOR_SIZE", () => {
  it("is the documented 384", () => {
    // Qdrant collection on knowledge.perkos.xyz is created with this
    // size; changing it without a migration breaks every existing
    // vector index.
    expect(VECTOR_SIZE).toBe(384);
  });
});

describe("embedText (hash embedding)", () => {
  it("always returns a vector of VECTOR_SIZE", () => {
    const v = embedText("hello world");
    expect(v).toHaveLength(VECTOR_SIZE);
  });

  it("returns a unit vector (norm ≈ 1) for non-empty input", () => {
    const v = embedText("Base Sepolia x402 ERC-8004 agent payments");
    const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
    // 6-decimal rounding inside embedText loses a bit of precision —
    // budget for that without false-positive failures.
    expect(norm).toBeGreaterThan(0.999);
    expect(norm).toBeLessThan(1.001);
  });

  it("returns the zero vector for input with no tokens (≤ 2 chars per word)", () => {
    // tokens() filters out tokens shorter than 3 chars.
    const v = embedText("a b c");
    expect(v.every((x) => x === 0)).toBe(true);
  });

  it("is deterministic — same input → same output", () => {
    const a = embedText("PerkOS knowledge research");
    const b = embedText("PerkOS knowledge research");
    expect(a).toEqual(b);
  });

  it("is case-insensitive (tokens() lowercases)", () => {
    expect(embedText("Hello World")).toEqual(embedText("hello world"));
  });

  it("strips non-alphanumeric chars before hashing", () => {
    // Same tokens after normalization → same vector.
    expect(embedText("base, celo, solana!")).toEqual(
      embedText("base celo solana"),
    );
  });

  it("produces different vectors for unrelated queries", () => {
    const a = embedText("erc8004 agent identity");
    const b = embedText("token swap aerodrome base");
    expect(a).not.toEqual(b);
  });

  it("DOCUMENTED LIMITATION: hash-based encoding has near-zero semantic similarity for paraphrases", () => {
    // The two queries are obviously about the same topic, but the
    // hash embedding doesn't know that — both vectors are nearly
    // orthogonal. This test documents the limitation and will START
    // FAILING once we swap to a real encoder (Option C); flip the
    // assertion when that happens.
    const a = embedText("erc8004 agent identity");
    const b = embedText("agent identification standard 8004");
    const dot = a.reduce((s, x, i) => s + x * b[i]!, 0);
    expect(Math.abs(dot)).toBeLessThan(0.3); // basically uncorrelated
  });
});
