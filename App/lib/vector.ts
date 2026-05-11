import crypto from 'crypto';

export const VECTOR_SIZE = 384;
const COLLECTION = process.env.QDRANT_COLLECTION || 'perkos_research';

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

  const points = items.map((item) => ({
    id: pointId(item.id),
    vector: embedText(`${item.title}\n${item.summary || ''}\n${item.track || ''}\n${item.path}`),
    payload: item,
  }));

  const res = await fetch(`${base}/collections/${COLLECTION}/points?wait=true`, {
    method: 'PUT',
    headers: headers(),
    body: JSON.stringify({ points }),
  });

  if (!res.ok) return { ok: false, collection: COLLECTION, error: await res.text(), upserted: 0 };
  return { ok: true, collection: COLLECTION, upserted: points.length };
}

export async function searchVectors(query: string, limit = 10, filter?: unknown) {
  const base = qdrantUrl();
  if (!base) return { ok: false, skipped: true, results: [] };

  await ensureVectorCollection();
  const body: Record<string, unknown> = { vector: embedText(query), limit, with_payload: true };
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
