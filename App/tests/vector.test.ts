import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { embed, embedText, VECTOR_SIZE } from "../lib/vector";

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

describe("embed (async router)", () => {
  const ENV_KEYS = [
    "KNOWLEDGE_EMBEDDING_PROVIDER",
    "OPENAI_API_KEY",
    "KNOWLEDGE_EMBEDDING_MODEL",
  ] as const;
  const original: Record<string, string | undefined> = {};
  let originalFetch: typeof fetch;

  beforeEach(() => {
    for (const k of ENV_KEYS) original[k] = process.env[k];
    for (const k of ENV_KEYS) delete process.env[k];
    originalFetch = globalThis.fetch;
  });
  afterEach(() => {
    for (const k of ENV_KEYS) {
      if (original[k] === undefined) delete process.env[k];
      else process.env[k] = original[k];
    }
    globalThis.fetch = originalFetch;
  });

  it("default (provider unset) → uses sync hash embed, returns same vector as embedText", async () => {
    const sync = embedText("hello world from perkos");
    const async_ = await embed("hello world from perkos");
    expect(async_).toEqual(sync);
  });

  it("provider=hash explicit → uses sync hash embed", async () => {
    process.env.KNOWLEDGE_EMBEDDING_PROVIDER = "hash";
    const v = await embed("test");
    expect(v).toEqual(embedText("test"));
  });

  it("provider=openai + no API key → throws clear error (fail-loud)", async () => {
    process.env.KNOWLEDGE_EMBEDDING_PROVIDER = "openai";
    delete process.env.OPENAI_API_KEY;
    await expect(embed("test")).rejects.toThrow(/OPENAI_API_KEY is unset/);
  });

  it("provider=openai + key set → routes to OpenAI fetch + returns API vector", async () => {
    process.env.KNOWLEDGE_EMBEDDING_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-fake-test";
    const apiVector = Array.from({ length: 384 }, (_, i) => (i % 7) / 7);
    globalThis.fetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            model: "text-embedding-3-small",
            data: [{ embedding: apiVector }],
            usage: { prompt_tokens: 2, total_tokens: 2 },
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    const out = await embed("semantic query about agents");
    expect(out).toEqual(apiVector);
    expect(globalThis.fetch).toHaveBeenCalledOnce();
  });

  it("provider=openai + API failure → propagates the error (does NOT silently fall back to hash)", async () => {
    // Critical contract: mixing hash + openai vectors in the same
    // Qdrant collection would corrupt search results. Fail-loud.
    process.env.KNOWLEDGE_EMBEDDING_PROVIDER = "openai";
    process.env.OPENAI_API_KEY = "sk-fake";
    globalThis.fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "rate limited" }), {
          status: 429,
        }),
    ) as unknown as typeof fetch;
    await expect(embed("x")).rejects.toThrow(/HTTP 429/);
  });

  it("returns VECTOR_SIZE regardless of provider", async () => {
    delete process.env.KNOWLEDGE_EMBEDDING_PROVIDER;
    const hash = await embed("anything");
    expect(hash).toHaveLength(VECTOR_SIZE);
  });
});
