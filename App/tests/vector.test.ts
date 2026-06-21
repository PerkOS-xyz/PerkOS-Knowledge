import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { deleteVectors, embed, embedText, VECTOR_SIZE } from "../lib/vector";

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

describe("embed (gateway provider — self-hosted OpenAI-compatible)", () => {
  const ENV_KEYS = [
    "KNOWLEDGE_EMBEDDING_PROVIDER",
    "KNOWLEDGE_EMBEDDING_BASE_URL",
    "KNOWLEDGE_EMBEDDING_MODEL",
    "KNOWLEDGE_EMBEDDING_API_KEY",
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

  it("provider=gateway + no base URL → throws (fail-loud)", async () => {
    process.env.KNOWLEDGE_EMBEDDING_PROVIDER = "gateway";
    await expect(embed("test")).rejects.toThrow(/KNOWLEDGE_EMBEDDING_BASE_URL is unset/);
  });

  it("provider=gateway → POSTs OpenAI-compat body (no dimensions) + returns the vector", async () => {
    process.env.KNOWLEDGE_EMBEDDING_PROVIDER = "gateway";
    process.env.KNOWLEDGE_EMBEDDING_BASE_URL = "https://api.llm.perkos.xyz/v1/embeddings";
    process.env.KNOWLEDGE_EMBEDDING_MODEL = "all-minilm";
    const apiVector = Array.from({ length: 384 }, (_, i) => (i % 5) / 5);
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({ model: "all-minilm", data: [{ embedding: apiVector }] }),
          { status: 200 },
        ),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const out = await embed("erc8004 identity");
    expect(out).toEqual(apiVector);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toBe("https://api.llm.perkos.xyz/v1/embeddings");
    const body = JSON.parse(String((init as RequestInit).body));
    expect(body.model).toBe("all-minilm");
    expect(body.input).toBe("erc8004 identity");
    expect(body.dimensions).toBeUndefined(); // gateway model is natively 384
  });

  it("provider=gateway + API key set → sends Authorization header", async () => {
    process.env.KNOWLEDGE_EMBEDDING_PROVIDER = "gateway";
    process.env.KNOWLEDGE_EMBEDDING_BASE_URL = "https://api.llm.perkos.xyz/v1/embeddings";
    process.env.KNOWLEDGE_EMBEDDING_API_KEY = "agent-key-123";
    const apiVector = Array.from({ length: 384 }, () => 0.1);
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ data: [{ embedding: apiVector }] }), { status: 200 }),
    );
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await embed("x");
    const headers = (fetchMock.mock.calls[0]![1] as RequestInit).headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer agent-key-123");
  });

  it("provider=gateway + wrong-dimension response → throws", async () => {
    process.env.KNOWLEDGE_EMBEDDING_PROVIDER = "gateway";
    process.env.KNOWLEDGE_EMBEDDING_BASE_URL = "https://api.llm.perkos.xyz/v1/embeddings";
    globalThis.fetch = vi.fn(
      async () => new Response(JSON.stringify({ data: [{ embedding: [1, 2, 3] }] }), { status: 200 }),
    ) as unknown as typeof fetch;
    await expect(embed("x")).rejects.toThrow(/wrong-shape|len=3/);
  });

  it("provider=gateway + upstream 502 → propagates the error", async () => {
    process.env.KNOWLEDGE_EMBEDDING_PROVIDER = "gateway";
    process.env.KNOWLEDGE_EMBEDDING_BASE_URL = "https://api.llm.perkos.xyz/v1/embeddings";
    globalThis.fetch = vi.fn(
      async () => new Response("upstream_failed", { status: 502 }),
    ) as unknown as typeof fetch;
    await expect(embed("x")).rejects.toThrow(/HTTP 502/);
  });
});

describe("deleteVectors", () => {
  const ENV_KEYS = ["QDRANT_URL", "QDRANT_API_KEY", "QDRANT_COLLECTION"] as const;
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

  it("returns skipped=true when QDRANT_URL not configured", async () => {
    const out = await deleteVectors(["a", "b"]);
    expect(out.ok).toBe(false);
    expect(out.skipped).toBe(true);
    expect(out.deleted).toBe(0);
  });

  it("returns skipped=true on empty id list", async () => {
    process.env.QDRANT_URL = "https://qdrant.test";
    const out = await deleteVectors([]);
    expect(out.skipped).toBe(true);
  });

  it("POSTs to Qdrant /points/delete with mapped uuid point ids", async () => {
    process.env.QDRANT_URL = "https://qdrant.test/";
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const out = await deleteVectors(["row-a", "row-b"]);

    expect(out.ok).toBe(true);
    expect(out.deleted).toBe(2);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(String(url)).toContain("/collections/perkos_research/points/delete?wait=true");
    expect((init as RequestInit).method).toBe("POST");
    const body = JSON.parse(String((init as RequestInit).body));
    expect(Array.isArray(body.points)).toBe(true);
    expect(body.points.length).toBe(2);
    // pointId produces uuid-shaped strings (8-4-4-4-12 hex segments).
    for (const id of body.points as string[]) {
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    }
  });

  it("returns ok=false with error text when Qdrant rejects", async () => {
    process.env.QDRANT_URL = "https://qdrant.test";
    globalThis.fetch = vi.fn(
      async () => new Response("collection not found", { status: 404 }),
    ) as unknown as typeof fetch;

    const out = await deleteVectors(["row-a"]);
    expect(out.ok).toBe(false);
    expect(out.error).toContain("collection not found");
    expect(out.deleted).toBe(0);
  });

  it("forwards api-key header when QDRANT_API_KEY set", async () => {
    process.env.QDRANT_URL = "https://qdrant.test";
    process.env.QDRANT_API_KEY = "secret-key";
    const fetchMock = vi.fn(async () => new Response("{}", { status: 200 }));
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    await deleteVectors(["row-a"]);
    const init = fetchMock.mock.calls[0]![1] as RequestInit;
    const headers = init.headers as Record<string, string>;
    expect(headers["api-key"]).toBe("secret-key");
  });
});
