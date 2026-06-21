import type { Client } from 'pg';

import { qdrantAccessFilter, readableKnowledgeWhere, type AccessContext } from './access';
import { searchVectors } from './vector';

/**
 * Reciprocal Rank Fusion constant. 60 is the value from the original
 * Cormack et al. RRF paper and the de-facto default in hybrid search
 * (Elasticsearch, Weaviate, etc). Larger k flattens the contribution of
 * top ranks; 60 keeps a meaningful head while still rewarding items that
 * appear in multiple result lists.
 */
export const RRF_K = 60;

export type FusedHit = { id: string; score: number };

/**
 * Reciprocal Rank Fusion over N ranked id lists.
 *
 * Each list is an ordered array of ids (best first). An item's fused
 * score is the sum, over the lists it appears in, of 1 / (k + rank)
 * where rank is its 0-based position. Items ranking high in MULTIPLE
 * lists rise above items appearing in only one — which is exactly what
 * we want when blending lexical (BM25) and semantic (vector) recall:
 * agreement between the two signals is the strongest evidence.
 *
 * Pure + deterministic, no I/O. Ties preserve first-seen order (stable
 * sort) so results are reproducible. Empty/falsey ids are ignored.
 */
export function reciprocalRankFusion(lists: string[][], k = RRF_K): FusedHit[] {
  const scores = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, idx) => {
      if (!id) return;
      scores.set(id, (scores.get(id) ?? 0) + 1 / (k + idx + 1));
    });
  }
  return [...scores.entries()]
    .map(([id, score]) => ({ id, score }))
    .sort((a, b) => b.score - a.score);
}

/**
 * Re-order hydrated DB rows to match a fused id ranking, dropping any
 * row whose id isn't in the ranking (and any fused id without a backing
 * row). The hydrate query returns rows in arbitrary order; this restores
 * the fusion order. Pure helper.
 */
export function orderRowsByFusion<T extends { id: string }>(rows: T[], fused: FusedHit[]): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const out: T[] = [];
  for (const hit of fused) {
    const row = byId.get(hit.id);
    if (row) out.push(row);
  }
  return out;
}

/**
 * Whether the semantic (vector) leg participates.
 *
 * Defaults to ON only when Qdrant is configured AND we're using real
 * OpenAI embeddings — blending hash-embedding noise (near-zero semantic
 * similarity, see lib/vector.ts) into the proven BM25 ranking would hurt
 * recall quality, not help it. `KNOWLEDGE_HYBRID` overrides:
 *   "off"        → BM25-only, always
 *   "on"/"force" → vector participates whenever Qdrant is configured
 *   unset/"auto" → vector participates iff QDRANT_URL + provider=openai
 */
export function vectorLegEnabled(): boolean {
  const mode = (process.env.KNOWLEDGE_HYBRID || 'auto').toLowerCase();
  if (mode === 'off') return false;
  if (!process.env.QDRANT_URL) return false;
  if (mode === 'on' || mode === 'force') return true;
  // Any real (non-hash) embedding provider — openai or our self-hosted
  // gateway — produces semantic vectors worth blending. Hash vectors have
  // near-zero semantic similarity, so they stay BM25-only.
  return (process.env.KNOWLEDGE_EMBEDDING_PROVIDER || 'hash').toLowerCase() !== 'hash';
}

export type HybridSearchParams = {
  query: string;
  access: AccessContext;
  limit: number;
  requireValidated: boolean;
  minConfidence: number;
};

export type HybridRow = {
  id: string;
  title: string | null;
  summary: string | null;
  track: string | null;
  chains: string[] | null;
  path: string | null;
  visibility: string | null;
  organization_id: string | null;
  validation_status: string | null;
  sanitization_status: string | null;
  quality_score: number | null;
  confidence_percent: number | null;
  trust_tier: string | null;
  quality_reasons: string[] | null;
  usage_count: number | null;
  updated_at: string | null;
};

const HYDRATE_COLS = `id, title, summary, track, chains, path, visibility, organization_id,
       validation_status, sanitization_status, quality_score, confidence_percent, trust_tier, quality_reasons,
       usage_count, updated_at`;

const FTS_EXPR =
  `to_tsvector('english', coalesce(title,'') || ' ' || coalesce(summary,'') || ' ' || coalesce(track,'') || ' ' || coalesce(path,''))`;

/** Append shared quality clauses to a param list; returns the SQL fragment. */
function qualityClauses(params: unknown[], requireValidated: boolean, minConfidence: number): string {
  const clauses: string[] = [];
  if (requireValidated) clauses.push(`validation_status = 'validated'`);
  if (minConfidence > 0) {
    params.push(minConfidence);
    clauses.push(`coalesce(confidence_percent, quality_score, 0) >= $${params.length}`);
  }
  return clauses.length ? `AND ${clauses.join(' AND ')}` : '';
}

/** Overfetch from each leg before fusion so good items aren't truncated pre-merge. */
export function recallSize(limit: number): number {
  return Math.min(Math.max(limit * 4, 20), 60);
}

/**
 * Hybrid retrieval for the main `/skill/query` path.
 *
 * 1. Lexical leg: Postgres full-text (BM25-ish) — ACL + quality enforced in SQL.
 * 2. Semantic leg: Qdrant vector recall — ACL enforced via the payload filter.
 * 3. Fuse the two id rankings with RRF.
 * 4. Hydrate the fused union from Postgres, RE-ENFORCING ACL + quality
 *    authoritatively (the Qdrant filter is recall-side only). The vector
 *    leg can therefore only ADD recall, never widen access.
 *
 * Degrades to BM25-only when the vector leg is disabled, Qdrant is down,
 * or the semantic recall is empty — so behavior is unchanged on deploys
 * without Qdrant/OpenAI embeddings.
 */
export async function hybridSearch(
  client: Client,
  p: HybridSearchParams,
): Promise<{ rows: HybridRow[]; vectorUsed: boolean }> {
  const recall = recallSize(p.limit);

  // --- Lexical leg (Postgres FTS) ---
  const bmAcl = readableKnowledgeWhere(p.access, [p.query]);
  const bmQuality = qualityClauses(bmAcl.params, p.requireValidated, p.minConfidence);
  bmAcl.params.push(recall);
  const bm25 = await client.query(
    `SELECT id FROM research_items
      WHERE ${FTS_EXPR} @@ plainto_tsquery('english', $1)
        AND ${bmAcl.sql} ${bmQuality}
      ORDER BY (validation_status = 'validated') DESC, coalesce(confidence_percent, quality_score, 0) DESC, usage_count DESC, updated_at DESC
      LIMIT $${bmAcl.params.length}`,
    bmAcl.params,
  );
  const bm25Ids = bm25.rows.map((r) => String(r.id));

  // --- Semantic leg (Qdrant vector) ---
  let vectorIds: string[] = [];
  let vectorUsed = false;
  if (vectorLegEnabled()) {
    try {
      const vec = await searchVectors(p.query, recall, qdrantAccessFilter(p.access));
      if (vec.ok && Array.isArray(vec.results)) {
        vectorIds = (vec.results as Array<{ payload?: { id?: string } }>)
          .map((hit) => String(hit.payload?.id || ''))
          .filter(Boolean);
        vectorUsed = vectorIds.length > 0;
      }
    } catch {
      // A Qdrant outage must never take down search — degrade to BM25.
      vectorIds = [];
      vectorUsed = false;
    }
  }

  // --- Fuse ---
  const fused = reciprocalRankFusion([bm25Ids, vectorIds]).slice(0, recall);
  if (!fused.length) return { rows: [], vectorUsed };

  // --- Hydrate the fused union, re-enforcing ACL + quality in Postgres ---
  const hyAcl = readableKnowledgeWhere(p.access, [fused.map((f) => f.id)]);
  const hyQuality = qualityClauses(hyAcl.params, p.requireValidated, p.minConfidence);
  const hydrated = await client.query(
    `SELECT ${HYDRATE_COLS} FROM research_items
      WHERE id = ANY($1::text[]) AND ${hyAcl.sql} ${hyQuality}`,
    hyAcl.params,
  );

  const rows = orderRowsByFusion(hydrated.rows as HybridRow[], fused).slice(0, p.limit);
  return { rows, vectorUsed };
}
