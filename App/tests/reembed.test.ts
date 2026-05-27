import { describe, expect, it, vi } from "vitest";

import { runReembed, type ReembedDeps } from "../lib/reembed";

/**
 * Builds a fake pg Client whose SELECTs return the supplied pages in
 * order, and remembers UPDATE calls so we can assert on them.
 *
 * Importantly: when the test under test does a SELECT after a previous
 * batch was successfully marked done, we serve the next page —
 * mirroring the real WHERE-clause-as-cursor behavior of reembed.ts
 * (rows whose vector_provider matches are no longer selectable).
 */
function makeFakeClient(pages: Array<Array<Record<string, unknown>>>) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  let nextPage = 0;
  const client = {
    query: vi.fn(async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      const verb = sql.trim().split(/\s+/)[0];
      if (verb === "SELECT") {
        if (nextPage >= pages.length) return { rowCount: 0, rows: [] };
        const page = pages[nextPage++]!;
        // Honor the SQL LIMIT (last param) so tests around `limit`
        // and `batchSize` reflect real Postgres behavior.
        const sqlLimit = typeof params?.[1] === "number" ? (params[1] as number) : page.length;
        const sliced = page.slice(0, sqlLimit);
        return { rowCount: sliced.length, rows: sliced };
      }
      // UPDATE — pretend N rows were marked done.
      return { rowCount: (params?.[1] as unknown[])?.length ?? 0, rows: [] };
    }),
  };
  return { client, calls };
}

const baseRow = (over: Record<string, unknown>) => ({
  id: "row-" + Math.random().toString(36).slice(2, 8),
  source: "test",
  date: null,
  track: null,
  title: "T",
  path: "/p",
  agents: ["openclaw"],
  chains: [],
  summary: "s",
  visibility: "public",
  organization_id: null,
  contributor_agent_id: null,
  validation_status: "pending",
  sanitization_status: "internal",
  ...over,
});

function okUpsert(): ReembedDeps {
  return {
    upsert: vi.fn(async () => ({ ok: true, upserted: 0 })),
  };
}

describe("runReembed", () => {
  it("processes all rows across multiple batches and marks them done", async () => {
    const { client, calls } = makeFakeClient([
      [baseRow({ id: "a" }), baseRow({ id: "b" })],
      [baseRow({ id: "c" })],
    ]);
    const deps = okUpsert();

    const stats = await runReembed(client as never, deps, { batchSize: 2 });

    expect(stats.scanned).toBe(3);
    expect(stats.reembedded).toBe(3);
    expect(stats.failed).toBe(0);
    expect(deps.upsert).toHaveBeenCalledTimes(2);

    const updates = calls.filter((c) => c.sql.trim().startsWith("UPDATE"));
    expect(updates.length).toBe(2);
    expect(updates[0]!.params[0]).toBe("openai"); // default target provider
    expect(updates[0]!.params[1]).toEqual(["a", "b"]);
    expect(updates[1]!.params[1]).toEqual(["c"]);
  });

  it("dryRun does not call upsert and does not mark rows done", async () => {
    const { client, calls } = makeFakeClient([[baseRow({ id: "a" })]]);
    const deps = okUpsert();

    const stats = await runReembed(client as never, deps, { dryRun: true });

    expect(stats.scanned).toBe(1);
    expect(stats.reembedded).toBe(1); // counted as "would reembed"
    expect(stats.dryRun).toBe(true);
    expect(deps.upsert).not.toHaveBeenCalled();
    const updates = calls.filter((c) => c.sql.trim().startsWith("UPDATE"));
    expect(updates.length).toBe(0);
  });

  it("on upsert failure: records errors, does NOT mark rows done, breaks early", async () => {
    const { client, calls } = makeFakeClient([
      [baseRow({ id: "fail-a" }), baseRow({ id: "fail-b" })],
      [baseRow({ id: "wouldve-c" })], // should NOT be reached
    ]);
    const deps: ReembedDeps = {
      upsert: vi.fn(async () => ({ ok: false, error: "qdrant 503" })),
    };

    const stats = await runReembed(client as never, deps, { batchSize: 2 });

    expect(stats.scanned).toBe(2);
    expect(stats.reembedded).toBe(0);
    expect(stats.failed).toBe(2);
    expect(stats.errors.length).toBe(2);
    expect(stats.errors[0]!.error).toContain("qdrant 503");

    // Critical: rows are NOT marked done so the next invocation
    // retries them.
    const updates = calls.filter((c) => c.sql.trim().startsWith("UPDATE"));
    expect(updates.length).toBe(0);

    // And we broke out before pulling the second page.
    expect(deps.upsert).toHaveBeenCalledTimes(1);
  });

  it("catches exceptions thrown by upsert and treats them as a batch failure", async () => {
    const { client } = makeFakeClient([[baseRow({ id: "throw" })]]);
    const deps: ReembedDeps = {
      upsert: vi.fn(async () => {
        throw new Error("network down");
      }),
    };

    const stats = await runReembed(client as never, deps);
    expect(stats.failed).toBe(1);
    expect(stats.errors[0]!.error).toContain("network down");
  });

  it("respects custom targetProvider", async () => {
    const { client, calls } = makeFakeClient([[baseRow({ id: "a" })]]);
    await runReembed(client as never, okUpsert(), { targetProvider: "hash" });
    const select = calls.find((c) => c.sql.trim().startsWith("SELECT"));
    expect(select!.params[0]).toBe("hash");
    const update = calls.find((c) => c.sql.trim().startsWith("UPDATE"));
    expect(update!.params[0]).toBe("hash");
  });

  it("respects limit (caps total scanned across batches)", async () => {
    const { client } = makeFakeClient([
      [baseRow({ id: "a" }), baseRow({ id: "b" })],
      [baseRow({ id: "c" }), baseRow({ id: "d" })],
    ]);
    const stats = await runReembed(client as never, okUpsert(), {
      batchSize: 2,
      limit: 3,
    });
    expect(stats.scanned).toBeLessThanOrEqual(3);
  });

  it("empty corpus: returns zeros without crashing", async () => {
    const { client } = makeFakeClient([[]]);
    const stats = await runReembed(client as never, okUpsert());
    expect(stats.scanned).toBe(0);
    expect(stats.reembedded).toBe(0);
    expect(stats.failed).toBe(0);
  });

  it("normalizes row.visibility to 'public' when value is not 'private'", async () => {
    // Defensive — VectorItem.visibility is the strict union.
    const { client } = makeFakeClient([
      [baseRow({ id: "weird", visibility: "totally-not-a-thing" })],
    ]);
    const captured: unknown[] = [];
    const deps: ReembedDeps = {
      upsert: vi.fn(async (items) => {
        captured.push(items[0]!.visibility);
        return { ok: true };
      }),
    };
    await runReembed(client as never, deps);
    expect(captured[0]).toBe("public");
  });

  it("returns stats with iso startedAt and non-negative durationMs", async () => {
    const { client } = makeFakeClient([[]]);
    const stats = await runReembed(client as never, okUpsert());
    expect(stats.startedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(stats.durationMs).toBeGreaterThanOrEqual(0);
  });
});
