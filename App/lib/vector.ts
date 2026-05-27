import crypto from 'crypto';

import { embedWithOpenAI } from './encoders/openai';

export const VECTOR_SIZE = 384;
const COLLECTION = process.env.QDRANT_COLLECTION || 'perkos_research';

/**
 * Embedding provider selection.
 *
 *   "hash"   — sync SHA256-based hash embed (default; backwards-compat).
 *              Fast, deterministic, BUT loses all semantic similarity.
 *              Keeps the system functional without external API deps.
 *   "openai" — calls the OpenAI Embeddings API with
 *              text-embedding-3-small + dimensions=384 to match the
 *              existing Qdrant collection. Adds semantic similarity
 *              at a real-world cost of <$0.50/year ingest at our
 *              current item volume.
 *
 * Fallback: if "openai" is configured but the API call fails, we
 * surface the error to the caller. We do NOT silently fall back to
 * hash because that would mix incompatible vector spaces in the same
 * Qdrant collection — searches would return inconsistent results
 * depending on which encoder produced each item.
 */
function embeddingProvider(): "hash" | "openai" {
  const p = (process.env.KNOWLEDGE_EMBEDDING_PROVIDER || 'hash').toLowerCase();
  return p === 'openai' ? 'openai' : 'hash';
}

export type VectorItem = {
  id: string;
  source: string;
  date?: string | null;
  track?: string | null;
  title: string;
  path: string;
  agents?: string[];
  chains?: string[];
  summary?: string | null;
  visibility: 'public' | 'private';
  organization_id?: string | null;
  contributor_agent_id?: string | null;
  validation_status?: string | null;
  sanitization_status?: string | null;
};

function qdrantUrl() {
  return (process.env.QDRANT_URL || '').replace(/\/$/, '');
}

function headers() {
  const h: Record<string, string> = { 'content-type': 'application/json' };
  if (process.env.QDRANT_API_KEY) h['api-key'] = process.env.QDRANT_API_KEY;
  return h;
}

function tokens(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, ' ')
    .split(/\s+/)
    .filter((token) => token.length > 2);
}

/**
 * Synchronous hash embedding. Kept exported because:
 *   1. It's the default when no semantic encoder is configured.
 *   2. Tests + tooling that don't want an API round-trip use it.
 * For real semantic search use `embed()` (async) below.
 */
export function embedText(text: string) {
  const vector = new Array<number>(VECTOR_SIZE).fill(0);
  for (const token of tokens(text)) {
    const digest = crypto.createHash('sha256').update(token).digest();
    const index = digest.readUInt32BE(0) % VECTOR_SIZE;
    const sign = digest[4] % 2 === 0 ? 1 : -1;
    vector[index] += sign;
  }

  const norm = Math.sqrt(vector.reduce((sum, value) => sum + value * value, 0)) || 1;
  return vector.map((value) => Number((value / norm).toFixed(6)));
}

/**
 * Async embed — routes by KNOWLEDGE_EMBEDDING_PROVIDER. This is the
 * call site every new code path should use; `embedText` remains the
 * sync fallback for legacy / test paths.
 *
 * Behavior matrix:
 *   provider="hash"   (default) → uses embedText synchronously (no I/O)
 *   provider="openai" + key set → calls OpenAI text-embedding-3-small
 *                                  with dimensions=384 to match the
 *                                  Qdrant collection size
 *   provider="openai" + key UNSET → throws (fail-loud rather than
 *                                  silently mixing vector spaces)
 *
 * The returned vector is ALWAYS VECTOR_SIZE (384) regardless of
 * provider — the Qdrant collection contract doesn't move.
 */
export async function embed(text: string): Promise<number[]> {
  if (embeddingProvider() === 'openai') {
    const apiKey = process.env.OPENAI_API_KEY || '';
    if (!apiKey) {
      throw new Error(
        'KNOWLEDGE_EMBEDDING_PROVIDER=openai but OPENAI_API_KEY is unset. ' +
        'Set the key or switch the provider back to "hash".',
      );
    }
    const out = await embedWithOpenAI(text, {
      apiKey,
      model: process.env.KNOWLEDGE_EMBEDDING_MODEL || undefined,
      dimensions: VECTOR_SIZE,
    });
    return out.vector;
  }
  return embedText(text);
}

export async function ensureVectorCollection() {
  const base = qdrantUrl();
  if (!base) return { ok: false, skipped: true, reason: 'qdrant_not_configured' };

  const res = await fetch(`${base}/collections/${COLLECTION}`, { headers: headers() });
  if (res.ok) return { ok: true, collection: COLLECTION, created: false };

  const create = await fetch(`${base}/collections/${COLLECTION}`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify({ vectors: { size: VECTOR_SIZE, distance: 'Cosine' } }),
  });

  if (!create.ok) {
    return { ok: false, collection: COLLECTION, error: await create.text() };
  }

  return { ok: true, collection: COLLECTION, created: true };
}

function pointId(input: string) {
  const hex = crypto.createHash('md5').update(input).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export async function upsertVectors(items: VectorItem[]) {
  const base = qdrantUrl();
  if (!base || !items.length) return { ok: false, skipped: true, upserted: 0 };

  const collection = await ensureVectorCollection();
  if (!collection.ok) return { ...collection, upserted: 0 };

  // Route through the async `embed()` so production deploys with
  // KNOWLEDGE_EMBEDDING_PROVIDER=openai get real semantic vectors,
  // while default deploys (or tests) keep the sync hash behavior.
  const points = await Promise.all(
    items.map(async (item) => ({
      id: pointId(item.id),
      vector: await embed(
        `${item.title}\n${item.summary || ''}\n${item.track || ''}\n${item.path}`,
      ),
      payload: item,
    })),
  );

  const res = await fetch(`${base}/collections/${COLLECTION}/points?wait=true`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify({ points }),
  });

  if (!res.ok) return { ok: false, collection: COLLECTION, error: await res.text(), upserted: 0 };
  return { ok: true, collection: COLLECTION, upserted: points.length };
}

/**
 * Bulk-delete points from Qdrant by their research_item id.
 *
 * Used by the lifecycle sweep when it hard-deletes evicted rows from
 * Postgres — otherwise the corresponding Qdrant points would orphan
 * (still searchable, no backing row).
 *
 * We resolve research_item id → Qdrant point id locally via the same
 * `pointId()` helper used at upsert; the Qdrant filter API can't do
 * this for us because the payload doesn't carry the raw id (the
 * payload id IS the qdrant uuid).
 *
 * Returns `skipped: true` when Qdrant isn't configured — matches the
 * convention of upsertVectors/searchVectors. Errors don't throw so a
 * Qdrant outage doesn't break the sweep loop; the caller logs the
 * error and moves on (orphans can be cleaned in a later sweep).
 */
export async function deleteVectors(ids: string[]) {
  const base = qdrantUrl();
  if (!base || !ids.length) return { ok: false, skipped: true, deleted: 0 };

  const points = ids.map(pointId);
  const res = await fetch(`${base}/collections/${COLLECTION}/points/delete?wait=true`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify({ points }),
  });

  if (!res.ok) {
    return { ok: false, collection: COLLECTION, error: await res.text(), deleted: 0 };
  }
  return { ok: true, collection: COLLECTION, deleted: points.length };
}

export async function searchVectors(query: string, limit = 10, filter?: unknown) {
  const base = qdrantUrl();
  if (!base) return { ok: false, skipped: true, results: [] };

  await ensureVectorCollection();
  const body: Record<string, unknown> = {
    vector: await embed(query),
    limit,
    with_payload: true,
  };
  if (filter) body.filter = filter;

  const res = await fetch(`${base}/collections/${COLLECTION}/points/search`, {
    method: 'POST',
    headers: headers(),
    body: JSON.stringify(body),
  });

  if (!res.ok) return { ok: false, error: await res.text(), results: [] };
  const data = await res.json();
  return { ok: true, collection: COLLECTION, results: data.result || [] };
}
