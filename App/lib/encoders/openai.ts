/**
 * OpenAI Embeddings encoder — produces real semantic vectors via the
 * `text-embedding-3-small` model truncated to the existing Qdrant
 * collection size (384) via the `dimensions` parameter.
 *
 * Why 3-small + dimensions=384:
 *   - The production Qdrant collection (perkos_research) was created
 *     at 384 dims for the hash-based encoder. Switching to a native
 *     1536/3072-dim model would force a full re-index. text-embedding-
 *     3-small natively supports `dimensions` (line-item truncation
 *     with MRL — Matryoshka Representation Learning) so we get real
 *     semantic quality at the dimension the existing collection
 *     already understands.
 *   - Cost: ~$0.02 per million tokens. A typical knowledge item
 *     (~200 tokens) is ~$0.000004. Even at 100k items/year this is
 *     <$0.50/year for ingest, and queries are an order of magnitude
 *     smaller.
 *
 * Failure mode: if the API call fails (network, rate limit, bad key),
 * we throw. Callers MUST decide whether to fall back to the hash
 * encoder or surface the error. lib/vector.ts handles that decision.
 */
export const OPENAI_EMBED_URL = "https://api.openai.com/v1/embeddings";
export const DEFAULT_MODEL = "text-embedding-3-small";

export type OpenAIEmbedConfig = {
  apiKey: string;
  model?: string;
  dimensions?: number;
  timeoutMs?: number;
  /** Override for tests — defaults to global fetch. */
  fetchImpl?: typeof fetch;
};

export type OpenAIEmbedResult = {
  vector: number[];
  model: string;
  usage: { promptTokens: number; totalTokens: number };
};

/**
 * Embed a single string. Returns a vector of `config.dimensions`
 * floats (default 384 to match the existing Qdrant collection).
 *
 * NOT batched on purpose — the caller (lib/vector.ts) batches at the
 * upsert level, and a per-call signature keeps the test surface
 * minimal. Add `embedBatch` if/when ingest throughput needs it.
 */
export async function embedWithOpenAI(
  text: string,
  config: OpenAIEmbedConfig,
): Promise<OpenAIEmbedResult> {
  if (!config.apiKey) {
    throw new Error("embedWithOpenAI: OPENAI_API_KEY is required");
  }
  if (!text || !text.trim()) {
    throw new Error("embedWithOpenAI: text must be non-empty");
  }

  const model = config.model ?? DEFAULT_MODEL;
  const dimensions = config.dimensions ?? 384;
  const timeoutMs = config.timeoutMs ?? 15_000;
  const fetchImpl = config.fetchImpl ?? fetch;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetchImpl(OPENAI_EMBED_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.apiKey}`,
      },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        input: text,
        dimensions,
        encoding_format: "float",
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(
        `embedWithOpenAI: HTTP ${res.status} — ${body.slice(0, 300)}`,
      );
    }
    const data = (await res.json()) as {
      data?: Array<{ embedding?: number[] }>;
      model?: string;
      usage?: { prompt_tokens?: number; total_tokens?: number };
    };
    const vector = data.data?.[0]?.embedding;
    if (!Array.isArray(vector) || vector.length !== dimensions) {
      throw new Error(
        `embedWithOpenAI: response missing/wrong-shape embedding (got len=${
          Array.isArray(vector) ? vector.length : "n/a"
        }, expected ${dimensions})`,
      );
    }
    return {
      vector,
      model: data.model ?? model,
      usage: {
        promptTokens: data.usage?.prompt_tokens ?? 0,
        totalTokens: data.usage?.total_tokens ?? 0,
      },
    };
  } finally {
    clearTimeout(timer);
  }
}
