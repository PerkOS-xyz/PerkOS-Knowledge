import { describe, expect, it, vi } from "vitest";

import {
  DEFAULT_MODEL,
  embedWithOpenAI,
  OPENAI_EMBED_URL,
} from "../lib/encoders/openai";

function fakeFetch(opts: {
  status?: number;
  body?: unknown;
}): typeof fetch {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => {
    return new Response(JSON.stringify(opts.body ?? {}), {
      status: opts.status ?? 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;
}

const VEC_OK = Array.from({ length: 384 }, (_, i) => (i % 10) / 10);

describe("embedWithOpenAI", () => {
  it("throws when apiKey is missing", async () => {
    await expect(
      embedWithOpenAI("hello", { apiKey: "" }),
    ).rejects.toThrow(/OPENAI_API_KEY is required/);
  });

  it("throws when text is empty/whitespace", async () => {
    await expect(
      embedWithOpenAI("", { apiKey: "sk-test" }),
    ).rejects.toThrow(/non-empty/);
    await expect(
      embedWithOpenAI("   ", { apiKey: "sk-test" }),
    ).rejects.toThrow(/non-empty/);
  });

  it("calls the OpenAI Embeddings URL with the right body", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({
        model: DEFAULT_MODEL,
        data: [{ embedding: VEC_OK }],
        usage: { prompt_tokens: 5, total_tokens: 5 },
      }), { status: 200 }),
    );
    await embedWithOpenAI("hello world", {
      apiKey: "sk-test-key",
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    expect(fetchSpy).toHaveBeenCalledOnce();
    const [url, init] = fetchSpy.mock.calls[0]!;
    expect(url).toBe(OPENAI_EMBED_URL);
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toMatchObject({
      model: DEFAULT_MODEL,
      input: "hello world",
      dimensions: 384,
      encoding_format: "float",
    });
    const headers = (init as RequestInit).headers as Record<string, string>;
    expect(headers["authorization"]).toBe("Bearer sk-test-key");
  });

  it("returns vector + usage on success", async () => {
    const out = await embedWithOpenAI("perkos knowledge", {
      apiKey: "sk-test",
      fetchImpl: fakeFetch({
        body: {
          model: DEFAULT_MODEL,
          data: [{ embedding: VEC_OK }],
          usage: { prompt_tokens: 3, total_tokens: 3 },
        },
      }),
    });
    expect(out.vector).toHaveLength(384);
    expect(out.usage.totalTokens).toBe(3);
    expect(out.model).toBe(DEFAULT_MODEL);
  });

  it("respects model + dimensions overrides", async () => {
    const fetchSpy = vi.fn(async () =>
      new Response(JSON.stringify({
        model: "text-embedding-3-large",
        data: [{ embedding: Array.from({ length: 128 }, () => 0) }],
        usage: { prompt_tokens: 1, total_tokens: 1 },
      }), { status: 200 }),
    );
    await embedWithOpenAI("x", {
      apiKey: "sk-test",
      model: "text-embedding-3-large",
      dimensions: 128,
      fetchImpl: fetchSpy as unknown as typeof fetch,
    });
    const body = JSON.parse(
      (fetchSpy.mock.calls[0]![1] as RequestInit).body as string,
    );
    expect(body.model).toBe("text-embedding-3-large");
    expect(body.dimensions).toBe(128);
  });

  it("throws on non-2xx with body excerpt", async () => {
    await expect(
      embedWithOpenAI("x", {
        apiKey: "sk-test",
        fetchImpl: fakeFetch({
          status: 401,
          body: { error: { message: "invalid api key" } },
        }),
      }),
    ).rejects.toThrow(/HTTP 401.*invalid api key/);
  });

  it("throws when response is the wrong shape", async () => {
    await expect(
      embedWithOpenAI("x", {
        apiKey: "sk-test",
        fetchImpl: fakeFetch({
          body: { data: [{ embedding: [1, 2, 3] }] }, // wrong dim
        }),
      }),
    ).rejects.toThrow(/wrong-shape|len=3/);
  });
});
