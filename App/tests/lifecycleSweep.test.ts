import { describe, expect, it, vi } from "vitest";

import { DEFAULT_LIFECYCLE_CONFIG } from "../lib/lifecycle";
import { runLifecycleSweep } from "../lib/lifecycleSweep";

const NOW = new Date("2026-06-01T00:00:00Z");
const day = (n: number) => new Date(NOW.getTime() - n * 86_400_000);

/**
 * Builds a fake pg Client whose `query` returns scripted batches of
 * research_items rows and records the UPDATE/DELETE calls. Lets us
 * assert the sweep applies the right plan + emits the right SQL
 * without standing up Postgres in CI.
 *
 * `pages` are returned in order; once exhausted, the next call
 * returns an empty rowset (which terminates the sweep loop).
 */
function makeFakeClient(pages: Array<Array<Record<string, unknown>>>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let cursor = 0;
  // The hard-delete sweep returns a fake rowCount = 7 so we can
  // assert it propagated to stats.hardDeleted.
  const hardDeletedRowCount = 7;

  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      const normalized = sql.trim();
      if (normalized.startsWith("BEGIN")) return { rowCount: 0, rows: [] };
      if (normalized.startsWith("COMMIT")) return { rowCount: 0, rows: [] };
      if (normalized.startsWith("ROLLBACK")) return { rowCount: 0, rows: [] };
      if (normalized.startsWith("UPDATE")) return { rowCount: 1, rows: [] };
      if (normalized.startsWith("DELETE")) {
        return { rowCount: hardDeletedRowCount, rows: [] };
      }
      // SELECT path — serve the next scripted page.
      if (cursor >= pages.length) return { rowCount: 0, rows: [] };
      const page = pages[cursor++]!;
      return { rowCount: page.length, rows: page };
    }),
  };
  return { client, calls };
}

const baseRow = (over: Record<string, unknown>) => ({
  id: "row-" + Math.random().toString(36).slice(2, 8),
  lifecycle_tier: "working",
  created_at: day(50),
  last_used_at: null,
  quality_score: 40,
  validation_status: "pending",
  ...over,
});

describe("runLifecycleSweep", () => {
  it("buckets items and emits the right UPDATE/DELETE shape", async () => {
    const { client, calls } = makeFakeClient([
      [
        baseRow({ id: "fresh-1", created_at: day(3) }),
        baseRow({ id: "keeper-1", created_at: day(500), quality_score: 95 }),
        baseRow({ id: "stale-1", created_at: day(120), quality_score: 30 }),
        baseRow({
          id: "evict-1",
          lifecycle_tier: "archived",
          created_at: day(400),
          last_used_at: day(400),
        }),
        baseRow({
          id: "revive-1",
          lifecycle_tier: "archived",
          created_at: day(200),
          last_used_at: day(2),
        }),
      ],
    ]);

    const stats = await runLifecycleSweep(client as never, { now: NOW });

    expect(stats.scanned).toBe(5);
    expect(stats.archived).toBe(1); // stale-1
    expect(stats.evicted).toBe(1); // evict-1
    expect(stats.revived).toBe(1); // revive-1
    expect(stats.unchanged).toBe(2); // fresh-1 + keeper-1
    expect(stats.hardDeleted).toBe(7); // from fake DELETE
    expect(stats.dryRun).toBe(false);

    // Verify the SQL we emitted: BEGIN, archive UPDATE, evict UPDATE,
    // revive UPDATE, COMMIT, plus the hard-delete DELETE.
    const sqls = calls.map((c) => c.sql.trim().split(/\s+/)[0]).join(" ");
    expect(sqls).toContain("BEGIN");
    expect(sqls).toContain("UPDATE UPDATE UPDATE");
    expect(sqls).toContain("COMMIT");
    expect(sqls).toContain("DELETE");

    // Evict UPDATE should set evicted_at via COALESCE.
    const evictUpdate = calls.find(
      (c) =>
        c.sql.includes("lifecycle_tier = 'evicted'") &&
        c.sql.includes("evicted_at"),
    );
    expect(evictUpdate).toBeDefined();
    expect(evictUpdate!.params[0]).toEqual(["evict-1"]);

    // Revive UPDATE should clear evicted_at.
    const reviveUpdate = calls.find(
      (c) =>
        c.sql.includes("lifecycle_tier = 'working'") &&
        c.sql.includes("evicted_at = NULL"),
    );
    expect(reviveUpdate).toBeDefined();
    expect(reviveUpdate!.params[0]).toEqual(["revive-1"]);
  });

  it("dryRun=true writes nothing (no BEGIN, no UPDATE, no DELETE)", async () => {
    const { client, calls } = makeFakeClient([
      [
        baseRow({ id: "stale-1", created_at: day(120), quality_score: 30 }),
      ],
    ]);

    const stats = await runLifecycleSweep(client as never, {
      now: NOW,
      dryRun: true,
    });

    expect(stats.scanned).toBe(1);
    expect(stats.archived).toBe(1); // counted in plan…
    expect(stats.dryRun).toBe(true);
    expect(stats.hardDeleted).toBe(0); // …but not applied

    const verbs = calls.map((c) => c.sql.trim().split(/\s+/)[0]);
    expect(verbs).not.toContain("BEGIN");
    expect(verbs).not.toContain("UPDATE");
    expect(verbs).not.toContain("DELETE");
  });

  it("pages with cursor: stops when a batch is short", async () => {
    // Two full pages of 2 rows then a short page → loop exits without
    // an extra SELECT round-trip.
    const { client, calls } = makeFakeClient([
      [
        baseRow({ id: "a", created_at: day(50) }),
        baseRow({ id: "b", created_at: day(50) }),
      ],
      [baseRow({ id: "c", created_at: day(50) })], // short → terminate
    ]);

    const stats = await runLifecycleSweep(client as never, {
      now: NOW,
      batchSize: 2,
    });

    expect(stats.scanned).toBe(3);
    const selects = calls.filter((c) => c.sql.trim().startsWith("SELECT"));
    expect(selects.length).toBe(2);
    // Second select should carry the cursor of the last row from page 1.
    expect(selects[1]!.params).toContain("b");
  });

  it("rolls back on UPDATE failure (transaction safety)", async () => {
    const calls: Array<{ sql: string }> = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        calls.push({ sql });
        const verb = sql.trim().split(/\s+/)[0];
        if (verb === "SELECT") {
          if (calls.filter((c) => c.sql.trim().startsWith("SELECT")).length > 1) {
            return { rowCount: 0, rows: [] };
          }
          return {
            rowCount: 1,
            rows: [baseRow({ id: "stale-1", created_at: day(120), quality_score: 30 })],
          };
        }
        if (verb === "BEGIN") return { rowCount: 0, rows: [] };
        if (verb === "UPDATE") throw new Error("simulated db failure");
        return { rowCount: 0, rows: [] };
      }),
    };

    await expect(
      runLifecycleSweep(client as never, { now: NOW }),
    ).rejects.toThrow(/simulated db failure/);

    const verbs = calls.map((c) => c.sql.trim().split(/\s+/)[0]);
    expect(verbs).toContain("ROLLBACK");
    expect(verbs).not.toContain("COMMIT");
  });

  it("returns stats with isoformat startedAt and positive durationMs", async () => {
    const { client } = makeFakeClient([[]]);
    const stats = await runLifecycleSweep(client as never);
    expect(stats.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(stats.durationMs).toBeGreaterThanOrEqual(0);
    expect(stats.retentionDays).toBe(90); // default
  });

  it("respects custom retentionDays and batchSize", async () => {
    const { client, calls } = makeFakeClient([[]]);
    await runLifecycleSweep(client as never, {
      retentionDays: 30,
      batchSize: 10,
      config: DEFAULT_LIFECYCLE_CONFIG,
    });

    const select = calls.find((c) => c.sql.trim().startsWith("SELECT"));
    expect(select!.params).toContain(10); // batchSize

    const del = calls.find((c) => c.sql.trim().startsWith("DELETE"));
    expect(del!.params).toEqual(["30"]); // retentionDays as string for interval
  });

  it("skips applyPlan transactions when batch has no changes", async () => {
    // All rows are fresh → plan has empty toArchive/toEvict/toRevive.
    const { client, calls } = makeFakeClient([
      [baseRow({ id: "fresh-a", created_at: day(3) })],
    ]);

    await runLifecycleSweep(client as never, { now: NOW });

    const verbs = calls.map((c) => c.sql.trim().split(/\s+/)[0]);
    expect(verbs).not.toContain("BEGIN"); // no transaction opened
    expect(verbs).toContain("DELETE"); // hard-delete still runs
  });
});
