/**
 * Metrics module tests — exercise the registry shape + the
 * render-to-text path. We intentionally don't lock down full label
 * sets / help strings; those are mostly for humans and shouldn't be
 * a maintenance tax on test runs.
 */
import { describe, expect, it } from "vitest";

import { getMetrics, getRegistry, renderMetrics } from "../lib/metrics";

describe("knowledge metrics registry", () => {
  it("is singleton across calls (no duplicate registration)", () => {
    const a = getRegistry();
    const b = getRegistry();
    expect(a).toBe(b);
  });

  it("exposes the expected named metrics", () => {
    const m = getMetrics();
    expect(m.lifecycleSweepTotal).toBeDefined();
    expect(m.lifecycleSweepDuration).toBeDefined();
    expect(m.lifecycleTransitionsTotal).toBeDefined();
    expect(m.lifecycleHardDeletedTotal).toBeDefined();
    expect(m.lifecycleVectorsDeletedTotal).toBeDefined();
    expect(m.reembedRunTotal).toBeDefined();
    expect(m.reembedRunDuration).toBeDefined();
    expect(m.reembedItemsTotal).toBeDefined();
  });

  it("counters increment and surface in the rendered text", async () => {
    const m = getMetrics();
    m.lifecycleSweepTotal.inc({ result: "ok", dryRun: "false" });
    m.lifecycleTransitionsTotal.inc({ to: "evicted" }, 3);
    m.reembedItemsTotal.inc({ result: "reembedded" }, 7);

    const { body, contentType } = await renderMetrics();

    // text/plain content-type with prom version marker.
    expect(contentType).toContain("text/plain");
    expect(body).toContain("perkos_knowledge_lifecycle_sweep_total");
    expect(body).toContain('result="ok"');
    expect(body).toContain("perkos_knowledge_lifecycle_transitions_total");
    expect(body).toMatch(/perkos_knowledge_lifecycle_transitions_total\{to="evicted"\} \d+/);
    expect(body).toContain("perkos_knowledge_reembed_items_total");
  });

  it("includes default process metrics under the perkos_knowledge_ prefix", async () => {
    const { body } = await renderMetrics();
    // collectDefaultMetrics emits process_cpu_user_seconds_total +
    // process_resident_memory_bytes among others — all prefixed.
    expect(body).toMatch(/perkos_knowledge_process_resident_memory_bytes/);
  });
});
