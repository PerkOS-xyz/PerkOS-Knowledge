/**
 * Knowledge-item lifecycle tiers.
 *
 * Inspired by agentmemory's working → session → archive → evict
 * consolidation pattern. Adapted for our setting where items are
 * provider-contributed (not session-captured), so the tiers reflect
 * "is this still worth keeping in active search?" rather than
 * "did the user just touch this?".
 *
 * Decision is a PURE function of:
 *   - the item's quality (score, validation status, tier)
 *   - its age (how long since createdAt)
 *   - its usage signal (last query that returned this item)
 *
 * Why this lives separately from quality.ts:
 *   quality.ts judges an item AT INGEST. lifecycle.ts judges an item
 *   AS IT AGES. They evaluate the same fields but from different
 *   vantage points and at different cadences (ingest = per-write,
 *   lifecycle = per-sweep).
 *
 * What this module does NOT do:
 *   - It doesn't read or write Postgres / Qdrant. It returns a plan;
 *     a separate caller (cron script in /scripts/, or a runtime
 *     trigger) executes the writes.
 *   - It doesn't delete data. "evicted" only marks the row — the
 *     operator decides whether evicted rows get retained for audit
 *     or hard-deleted in a separate step.
 */

export type LifecycleTier = "working" | "archived" | "evicted";

export type LifecycleConfig = {
  /** Items younger than this stay in working tier regardless of score. */
  freshDays: number;
  /** Items with score >= this never archive (high-confidence keepers). */
  archiveScoreThreshold: number;
  /** A query hit in this window counts as "recently used". */
  recentUseDays: number;
  /** Items older than this AND low score → archive. */
  archiveAfterDays: number;
  /** Archived items unused this long → evict. */
  evictAfterDays: number;
};

export const DEFAULT_LIFECYCLE_CONFIG: LifecycleConfig = {
  freshDays: 14,
  archiveScoreThreshold: 70,
  recentUseDays: 30,
  archiveAfterDays: 90,
  evictAfterDays: 180,
};

export type LifecycleEvaluationInput = {
  currentTier: LifecycleTier | null | undefined;
  createdAt: Date | string | null | undefined;
  lastUsedAt: Date | string | null | undefined;
  /** 0-100, from quality.ts assessment. */
  qualityScore: number | null | undefined;
  validationStatus: string | null | undefined;
};

export type LifecycleDecision = {
  /** Tier the item SHOULD be in. */
  tier: LifecycleTier;
  /** True iff `tier` differs from `currentTier` and a write is required. */
  changed: boolean;
  /** Human-readable reasons for the chosen tier. Surfaced in audit logs. */
  reasons: string[];
};

function ageDays(ref: Date, value: Date | string | null | undefined): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const d = value instanceof Date ? value : new Date(value);
  const ms = d.getTime();
  if (!Number.isFinite(ms)) return Number.POSITIVE_INFINITY;
  return (ref.getTime() - ms) / (24 * 60 * 60 * 1000);
}

function normalizeTier(value: unknown): LifecycleTier {
  if (value === "working" || value === "archived" || value === "evicted") {
    return value;
  }
  return "working";
}

/**
 * Pure decision: given an item's age + quality + usage, return the
 * tier it should be in plus the reasoning.
 *
 * Rules, in order (first match wins):
 *
 *   1. Fresh (createdAt < freshDays) → working
 *      Don't archive things we just received. Lets users see new
 *      contributions before any age-based gating kicks in.
 *
 *   2. High-quality (qualityScore >= archiveScoreThreshold) → working
 *      Curated, validated, high-confidence items are keepers regardless
 *      of age. The eviction sweep is for low-signal items, not for
 *      "old but still good".
 *
 *   3. Recently used (lastUsedAt < recentUseDays) → working
 *      Even a low-score item that consumers keep querying has value
 *      to those consumers. Don't archive what's being touched.
 *
 *   4. Archived + still unused (currentTier='archived' AND ageOfArchive
 *      > evictAfterDays measured against lastUsedAt or createdAt) →
 *      evicted
 *      Things that already lost to archive and didn't come back get
 *      finally evicted.
 *
 *   5. Old + low-quality (createdAt > archiveAfterDays AND not high-
 *      quality AND not recently used) → archived
 *      The default path for the long tail of low-signal items.
 *
 *   6. Otherwise → working
 *      Including things younger than archiveAfterDays but past
 *      freshDays — they stay in working, eligible to age into archive
 *      later.
 */
export function evaluateLifecycleTier(
  input: LifecycleEvaluationInput,
  now: Date = new Date(),
  config: LifecycleConfig = DEFAULT_LIFECYCLE_CONFIG,
): LifecycleDecision {
  const currentTier = normalizeTier(input.currentTier);
  const created = ageDays(now, input.createdAt);
  const lastUse = ageDays(now, input.lastUsedAt);
  const score = typeof input.qualityScore === "number" ? input.qualityScore : 0;
  const reasons: string[] = [];

  // Rule 1: fresh
  if (created < config.freshDays) {
    reasons.push(`fresh (created ${created.toFixed(1)}d ago < ${config.freshDays}d)`);
    return { tier: "working", changed: currentTier !== "working", reasons };
  }

  // Rule 2: high-quality keepers
  if (score >= config.archiveScoreThreshold) {
    reasons.push(`high quality (score ${score} >= ${config.archiveScoreThreshold})`);
    return { tier: "working", changed: currentTier !== "working", reasons };
  }

  // Rule 3: recently used
  if (lastUse < config.recentUseDays) {
    reasons.push(`recently used (last hit ${lastUse.toFixed(1)}d ago < ${config.recentUseDays}d)`);
    return { tier: "working", changed: currentTier !== "working", reasons };
  }

  // Rule 4: archived + still unused → evict
  if (currentTier === "archived") {
    const sinceTouched = Math.min(lastUse, created);
    if (sinceTouched > config.evictAfterDays) {
      reasons.push(
        `archived + untouched ${sinceTouched.toFixed(1)}d > ${config.evictAfterDays}d`,
      );
      return { tier: "evicted", changed: true, reasons };
    }
    // Stay archived if not yet old enough to evict.
    reasons.push(
      `still archived (untouched ${sinceTouched.toFixed(1)}d < ${config.evictAfterDays}d evict threshold)`,
    );
    return { tier: "archived", changed: false, reasons };
  }

  // Rule 5: old + low quality → archive
  // At this point Rule 4 has already excluded the currentTier==="archived"
  // path, so we're transitioning a "working" or "evicted" item INTO
  // "archived" — that's always a state change.
  if (created > config.archiveAfterDays) {
    reasons.push(
      `old (${created.toFixed(1)}d > ${config.archiveAfterDays}d) + low quality (score ${score}) + unused`,
    );
    return { tier: "archived", changed: true, reasons };
  }

  // Rule 6: default stays working
  reasons.push("default working tier");
  return { tier: "working", changed: currentTier !== "working", reasons };
}

export type LifecycleItem = {
  id: string;
  currentTier: LifecycleTier | null | undefined;
  createdAt: Date | string | null | undefined;
  lastUsedAt: Date | string | null | undefined;
  qualityScore: number | null | undefined;
  validationStatus: string | null | undefined;
};

export type LifecyclePlan = {
  toArchive: string[];
  toEvict: string[];
  toRevive: string[];
  unchanged: number;
  evaluatedAt: string;
};

/**
 * Apply `evaluateLifecycleTier` to a batch of items. Returns a plan
 * the caller can execute as a few UPDATE statements — keeping the
 * decision logic separate from the I/O for testability.
 */
export function planLifecycleTransitions(
  items: LifecycleItem[],
  now: Date = new Date(),
  config: LifecycleConfig = DEFAULT_LIFECYCLE_CONFIG,
): LifecyclePlan {
  const toArchive: string[] = [];
  const toEvict: string[] = [];
  const toRevive: string[] = [];
  let unchanged = 0;

  for (const item of items) {
    const decision = evaluateLifecycleTier(
      {
        currentTier: item.currentTier,
        createdAt: item.createdAt,
        lastUsedAt: item.lastUsedAt,
        qualityScore: item.qualityScore,
        validationStatus: item.validationStatus,
      },
      now,
      config,
    );
    if (!decision.changed) {
      unchanged++;
      continue;
    }
    const current = normalizeTier(item.currentTier);
    if (decision.tier === "archived") toArchive.push(item.id);
    else if (decision.tier === "evicted") toEvict.push(item.id);
    else if (decision.tier === "working" && current !== "working") {
      // "revival" — an archived/evicted item that's been used or
      // re-scored above the keeper threshold. Useful signal for ops
      // dashboards (e.g., "X items resurrected this week").
      toRevive.push(item.id);
    }
  }

  return {
    toArchive,
    toEvict,
    toRevive,
    unchanged,
    evaluatedAt: now.toISOString(),
  };
}
