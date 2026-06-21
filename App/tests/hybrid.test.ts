import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  orderRowsByFusion,
  recallSize,
  reciprocalRankFusion,
  RRF_K,
  vectorLegEnabled,
} from "../lib/hybrid";

describe("reciprocalRankFusion", () => {
  it("returns [] for no lists / empty lists", () => {
    expect(reciprocalRankFusion([])).toEqual([]);
    expect(reciprocalRankFusion([[], []])).toEqual([]);
  });

  it("single list → preserves order, strictly descending scores", () => {
    const fused = reciprocalRankFusion([["a", "b", "c"]]);
    expect(fused.map((f) => f.id)).toEqual(["a", "b", "c"]);
    expect(fused[0]!.score).toBeGreaterThan(fused[1]!.score);
    expect(fused[1]!.score).toBeGreaterThan(fused[2]!.score);
  });

  it("uses 1/(k+rank) with the documented RRF_K default", () => {
    const fused = reciprocalRankFusion([["a"]]);
    expect(fused[0]!.score).toBeCloseTo(1 / (RRF_K + 1), 10);
  });

  it("an item ranking in BOTH lists beats items in only one", () => {
    // 'b' is mid-rank in both lists; its fused score should top everything.
    const fused = reciprocalRankFusion([
      ["a", "b", "c"],
      ["x", "b", "y"],
    ]);
    expect(fused[0]!.id).toBe("b");
  });

  it("honors a custom k (smaller k sharpens top-rank dominance)", () => {
    const small = reciprocalRankFusion([["a"]], 10);
    expect(small[0]!.score).toBeCloseTo(1 / 11, 10);
  });

  it("ignores empty/falsey ids", () => {
    const fused = reciprocalRankFusion([["", "a", ""]]);
    expect(fused.map((f) => f.id)).toEqual(["a"]);
  });

  it("is deterministic on ties (stable first-seen order)", () => {
    // a and b end up with identical scores; first-seen (list A) order wins.
    const fused = reciprocalRankFusion([
      ["a", "b"],
      ["b", "a"],
    ]);
    expect(fused[0]!.score).toBeCloseTo(fused[1]!.score, 12);
    expect(fused.map((f) => f.id)).toEqual(["a", "b"]);
  });
});

describe("orderRowsByFusion", () => {
  it("reorders rows to fused order, dropping rows absent from the ranking", () => {
    const rows = [
      { id: "b", v: 2 },
      { id: "a", v: 1 },
      { id: "z", v: 9 }, // not in fusion → dropped
    ];
    const fused = [
      { id: "a", score: 1 },
      { id: "b", score: 0.5 },
      { id: "c", score: 0.1 }, // no backing row → skipped
    ];
    expect(orderRowsByFusion(rows, fused)).toEqual([
      { id: "a", v: 1 },
      { id: "b", v: 2 },
    ]);
  });

  it("returns [] when nothing matches", () => {
    expect(orderRowsByFusion([{ id: "x" }], [{ id: "y", score: 1 }])).toEqual([]);
  });
});

describe("recallSize", () => {
  it("overfetches 4x the limit, floored at 20 and capped at 60", () => {
    expect(recallSize(3)).toBe(20); // 12 → floored to 20
    expect(recallSize(8)).toBe(32); // 32
    expect(recallSize(25)).toBe(60); // 100 → capped to 60
  });
});

describe("vectorLegEnabled", () => {
  const ENV_KEYS = ["KNOWLEDGE_HYBRID", "QDRANT_URL", "KNOWLEDGE_EMBEDDING_PROVIDER"] as const;
  const original: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const k of ENV_KEYS) original[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
  });

  it("off without Qdrant", () => {
    expect(vectorLegEnabled()).toBe(false);
  });

  it("auto + Qdrant + openai embeddings → on", () => {
    process.env.QDRANT_URL = "https://qdrant.test";
    process.env.KNOWLEDGE_EMBEDDING_PROVIDER = "openai";
    expect(vectorLegEnabled()).toBe(true);
  });

  it("auto + Qdrant + gateway embeddings → on", () => {
    process.env.QDRANT_URL = "https://qdrant.test";
    process.env.KNOWLEDGE_EMBEDDING_PROVIDER = "gateway";
    expect(vectorLegEnabled()).toBe(true);
  });

  it("auto + Qdrant + hash embeddings → off (don't blend hash noise)", () => {
    process.env.QDRANT_URL = "https://qdrant.test";
    process.env.KNOWLEDGE_EMBEDDING_PROVIDER = "hash";
    expect(vectorLegEnabled()).toBe(false);
  });

  it("KNOWLEDGE_HYBRID=off forces BM25-only even with Qdrant + openai", () => {
    process.env.KNOWLEDGE_HYBRID = "off";
    process.env.QDRANT_URL = "https://qdrant.test";
    process.env.KNOWLEDGE_EMBEDDING_PROVIDER = "openai";
    expect(vectorLegEnabled()).toBe(false);
  });

  it("KNOWLEDGE_HYBRID=on forces the vector leg with Qdrant even on hash", () => {
    process.env.KNOWLEDGE_HYBRID = "on";
    process.env.QDRANT_URL = "https://qdrant.test";
    process.env.KNOWLEDGE_EMBEDDING_PROVIDER = "hash";
    expect(vectorLegEnabled()).toBe(true);
  });

  it("KNOWLEDGE_HYBRID=on still needs Qdrant configured", () => {
    process.env.KNOWLEDGE_HYBRID = "on";
    expect(vectorLegEnabled()).toBe(false);
  });
});
