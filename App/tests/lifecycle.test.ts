import { describe, expect, it } from "vitest";

import {
  DEFAULT_LIFECYCLE_CONFIG,
  evaluateLifecycleTier,
  planLifecycleTransitions,
  type LifecycleConfig,
  type LifecycleItem,
} from "../lib/lifecycle";

const NOW = new Date("2026-06-01T00:00:00Z");
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

describe("evaluateLifecycleTier", () => {
  it("Rule 1: fresh items stay working regardless of low score", () => {
    const d = evaluateLifecycleTier(
      {
        currentTier: "working",
        createdAt: day(3), // < 14 day freshDays
        lastUsedAt: null,
        qualityScore: 5,
        validationStatus: "pending",
      },
      NOW,
    );
    expect(d.tier).toBe("working");
    expect(d.changed).toBe(false);
    expect(d.reasons[0]).toMatch(/fresh/);
  });

  it("Rule 2: high-quality items stay working even when ancient", () => {
    const d = evaluateLifecycleTier(
      {
        currentTier: "working",
        createdAt: day(500),
        lastUsedAt: null,
        qualityScore: 90, // > 70 threshold
        validationStatus: "validated",
      },
      NOW,
    );
    expect(d.tier).toBe("working");
    expect(d.reasons[0]).toMatch(/high quality/);
  });

  it("Rule 3: recently-used items stay working even if old + low score", () => {
    const d = evaluateLifecycleTier(
      {
        currentTier: "working",
        createdAt: day(200),
        lastUsedAt: day(5), // < 30d recentUseDays
        qualityScore: 20,
        validationStatus: "unvalidated",
      },
      NOW,
    );
    expect(d.tier).toBe("working");
    expect(d.reasons[0]).toMatch(/recently used/);
  });

  it("Rule 4: archived + still unused past evict threshold → evicted", () => {
    const d = evaluateLifecycleTier(
      {
        currentTier: "archived",
        createdAt: day(400),
        lastUsedAt: day(400), // > 180d evictAfterDays
        qualityScore: 30,
        validationStatus: "unvalidated",
      },
      NOW,
    );
    expect(d.tier).toBe("evicted");
    expect(d.changed).toBe(true);
    expect(d.reasons[0]).toMatch(/archived.*untouched/);
  });

  it("Rule 4: archived + recent usage NOT yet evicted but stays archived (waits for revive logic)", () => {
    // The function is structured so that Rule 3 (recent use) triggers
    // BEFORE Rule 4 — so a recently-used archived item revives to
    // working. Without recent use, archived items stay archived
    // until the evict window passes.
    const d = evaluateLifecycleTier(
      {
        currentTier: "archived",
        createdAt: day(100),
        lastUsedAt: day(100), // 100 days untouched < 180d evict
        qualityScore: 30,
        validationStatus: "unvalidated",
      },
      NOW,
    );
    expect(d.tier).toBe("archived");
    expect(d.changed).toBe(false);
  });

  it("Rule 4b: archived + RECENT use → revived to working (via Rule 3)", () => {
    const d = evaluateLifecycleTier(
      {
        currentTier: "archived",
        createdAt: day(200),
        lastUsedAt: day(5), // recent → Rule 3 triggers
        qualityScore: 30,
        validationStatus: "unvalidated",
      },
      NOW,
    );
    expect(d.tier).toBe("working");
    expect(d.changed).toBe(true); // archived → working = revival
    expect(d.reasons[0]).toMatch(/recently used/);
  });

  it("Rule 5: old + low quality + unused → archived", () => {
    const d = evaluateLifecycleTier(
      {
        currentTier: "working",
        createdAt: day(120), // > 90d archiveAfterDays
        lastUsedAt: null,
        qualityScore: 30,
        validationStatus: "unvalidated",
      },
      NOW,
    );
    expect(d.tier).toBe("archived");
    expect(d.changed).toBe(true);
    expect(d.reasons[0]).toMatch(/old.*low quality/);
  });

  it("Rule 6: middling age + middling score stays working (eligible to age later)", () => {
    const d = evaluateLifecycleTier(
      {
        currentTier: "working",
        createdAt: day(50), // > 14 fresh, < 90 archiveAfter
        lastUsedAt: null,
        qualityScore: 40,
        validationStatus: "pending",
      },
      NOW,
    );
    expect(d.tier).toBe("working");
    expect(d.changed).toBe(false);
    expect(d.reasons[0]).toMatch(/default working/);
  });

  it("missing currentTier is treated as 'working' (backwards compat for existing rows)", () => {
    const d = evaluateLifecycleTier(
      {
        currentTier: null,
        createdAt: day(3),
        lastUsedAt: null,
        qualityScore: null,
        validationStatus: null,
      },
      NOW,
    );
    expect(d.tier).toBe("working");
    expect(d.changed).toBe(false);
  });

  it("missing createdAt → treated as infinitely old (skips fresh rule, archives if low quality)", () => {
    const d = evaluateLifecycleTier(
      {
        currentTier: "working",
        createdAt: null,
        lastUsedAt: null,
        qualityScore: 10,
        validationStatus: "unvalidated",
      },
      NOW,
    );
    expect(d.tier).toBe("archived");
  });

  it("respects custom config", () => {
    const aggressive: LifecycleConfig = {
      ...DEFAULT_LIFECYCLE_CONFIG,
      freshDays: 1, // very short fresh window
      archiveAfterDays: 10, // archive after just 10 days
    };
    const d = evaluateLifecycleTier(
      {
        currentTier: "working",
        createdAt: day(15),
        lastUsedAt: null,
        qualityScore: 30,
        validationStatus: "unvalidated",
      },
      NOW,
      aggressive,
    );
    expect(d.tier).toBe("archived");
  });

  it("invalid currentTier string is normalized to 'working'", () => {
    const d = evaluateLifecycleTier(
      {
        currentTier: "weird-value" as never,
        createdAt: day(3),
        lastUsedAt: null,
        qualityScore: 50,
        validationStatus: "pending",
      },
      NOW,
    );
    expect(d.tier).toBe("working");
  });
});

describe("planLifecycleTransitions", () => {
  function item(over: Partial<LifecycleItem>): LifecycleItem {
    return {
      id: "item-" + Math.random().toString(36).slice(2, 8),
      currentTier: "working",
      createdAt: day(50),
      lastUsedAt: null,
      qualityScore: 40,
      validationStatus: "pending",
      ...over,
    };
  }

  it("buckets each item into archive/evict/revive/unchanged correctly", () => {
    const plan = planLifecycleTransitions(
      [
        // Fresh — unchanged
        item({ id: "fresh-1", createdAt: day(3) }),
        // High quality, ancient — unchanged (stays working)
        item({ id: "keeper-1", createdAt: day(500), qualityScore: 95 }),
        // Old + low + unused — archive
        item({ id: "stale-1", createdAt: day(120), qualityScore: 30 }),
        // Already archived + still untouched past evict → evict
        item({
          id: "evict-1",
          currentTier: "archived",
          createdAt: day(400),
          lastUsedAt: day(400),
        }),
        // Archived + recent use → revive to working
        item({
          id: "revive-1",
          currentTier: "archived",
          createdAt: day(200),
          lastUsedAt: day(2),
        }),
      ],
      NOW,
    );

    expect(plan.toArchive).toEqual(["stale-1"]);
    expect(plan.toEvict).toEqual(["evict-1"]);
    expect(plan.toRevive).toEqual(["revive-1"]);
    expect(plan.unchanged).toBe(2); // fresh-1 + keeper-1
  });

  it("emits ISO evaluatedAt for audit logs", () => {
    const plan = planLifecycleTransitions([], NOW);
    expect(plan.evaluatedAt).toBe(NOW.toISOString());
  });

  it("zero items → all-empty plan", () => {
    const plan = planLifecycleTransitions([]);
    expect(plan).toMatchObject({
      toArchive: [],
      toEvict: [],
      toRevive: [],
      unchanged: 0,
    });
  });
});
