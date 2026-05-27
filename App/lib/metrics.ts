/**
 * Prometheus metrics registry + named metrics for the knowledge service.
 *
 * Single shared `register` per process — the /api/metrics route and
 * any in-process instrumentation pull from it. All metrics are
 * namespaced `perkos_knowledge_*` so they don't collide with the
 * mini-app's `perkos_*` namespace when scraped into the same
 * Prometheus.
 *
 * Why prom-client (not OpenTelemetry):
 *   Mirrors the mini-app's choice in PerkOS/app/lib/metrics.ts — a
 *   small footprint, a /metrics text endpoint a vanilla scraper can
 *   hit, no network deps. OTel is a bigger surface; layer on later
 *   if/when we need traces.
 *
 * What's instrumented (today):
 *   - Lifecycle sweep: per-run outcome counter + duration histogram +
 *     per-tier transition counters.
 *   - Re-embed: per-run outcome + reembedded/failed counters +
 *     duration histogram.
 *   - Process basics (cpu/mem/event-loop) via collectDefaultMetrics.
 *
 * What's NOT instrumented (deliberate gap):
 *   - Per-route HTTP latency — needs Next.js middleware. Layer on
 *     once traffic patterns are clear enough to size buckets.
 *   - Qdrant request metrics — would belong on the Qdrant side of
 *     the network, not here.
 */
import { collectDefaultMetrics, Counter, Histogram, Registry } from "prom-client";

declare global {
  // eslint-disable-next-line no-var
  var __perkosKnowledgeMetricsRegistry: Registry | undefined;
  // eslint-disable-next-line no-var
  var __perkosKnowledgeMetrics: KnowledgeMetrics | undefined;
}

export type KnowledgeMetrics = {
  /** Total lifecycle sweep invocations, labelled by outcome ("ok" | "error"). */
  lifecycleSweepTotal: Counter<"result" | "dryRun">;
  /** Duration of a single lifecycle sweep run. */
  lifecycleSweepDuration: Histogram<"dryRun">;
  /** Items moved from one tier to another in a sweep, labelled by transition. */
  lifecycleTransitionsTotal: Counter<"to">;
  /** Rows hard-deleted by retention sweep. */
  lifecycleHardDeletedTotal: Counter<never>;
  /** Qdrant points cleaned up alongside hard-deletes. */
  lifecycleVectorsDeletedTotal: Counter<never>;

  /** Total re-embed invocations, labelled by outcome ("ok" | "error"). */
  reembedRunTotal: Counter<"result" | "dryRun">;
  /** Duration of a single re-embed run. */
  reembedRunDuration: Histogram<"dryRun">;
  /** Items successfully re-embedded into Qdrant. */
  reembedItemsTotal: Counter<"result">;
};

function init(): { register: Registry; metrics: KnowledgeMetrics } {
  if (globalThis.__perkosKnowledgeMetricsRegistry && globalThis.__perkosKnowledgeMetrics) {
    return {
      register: globalThis.__perkosKnowledgeMetricsRegistry,
      metrics: globalThis.__perkosKnowledgeMetrics,
    };
  }
  const register = new Registry();
  // Default process metrics under the same namespace — gives an
  // operator the basics (CPU, RSS, event-loop lag) on the same
  // dashboard as the domain metrics.
  collectDefaultMetrics({ register, prefix: "perkos_knowledge_" });

  const lifecycleSweepTotal = new Counter({
    name: "perkos_knowledge_lifecycle_sweep_total",
    help: "Number of lifecycle sweep invocations, labelled by outcome and dryRun flag.",
    labelNames: ["result", "dryRun"] as const,
    registers: [register],
  });
  const lifecycleSweepDuration = new Histogram({
    name: "perkos_knowledge_lifecycle_sweep_duration_seconds",
    help: "Wall-clock seconds spent in a single lifecycle sweep.",
    labelNames: ["dryRun"] as const,
    // 50ms → 5min spread; sweep over <1k rows should land in the 0.5–5s band.
    buckets: [0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 300],
    registers: [register],
  });
  const lifecycleTransitionsTotal = new Counter({
    name: "perkos_knowledge_lifecycle_transitions_total",
    help: "Lifecycle tier transitions performed by the sweep, labelled by target tier (archived | evicted | working).",
    labelNames: ["to"] as const,
    registers: [register],
  });
  const lifecycleHardDeletedTotal = new Counter({
    name: "perkos_knowledge_lifecycle_hard_deleted_total",
    help: "Rows hard-deleted from research_items by the retention sweep.",
    registers: [register],
  });
  const lifecycleVectorsDeletedTotal = new Counter({
    name: "perkos_knowledge_lifecycle_vectors_deleted_total",
    help: "Qdrant points removed alongside Postgres hard-deletes.",
    registers: [register],
  });

  const reembedRunTotal = new Counter({
    name: "perkos_knowledge_reembed_run_total",
    help: "Number of re-embed pass invocations, labelled by outcome and dryRun flag.",
    labelNames: ["result", "dryRun"] as const,
    registers: [register],
  });
  const reembedRunDuration = new Histogram({
    name: "perkos_knowledge_reembed_run_duration_seconds",
    help: "Wall-clock seconds spent in a single re-embed pass.",
    labelNames: ["dryRun"] as const,
    buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 30, 60, 120, 300],
    registers: [register],
  });
  const reembedItemsTotal = new Counter({
    name: "perkos_knowledge_reembed_items_total",
    help: "Items processed by the re-embed pass, labelled by per-item result (reembedded | failed).",
    labelNames: ["result"] as const,
    registers: [register],
  });

  const metrics: KnowledgeMetrics = {
    lifecycleSweepTotal,
    lifecycleSweepDuration,
    lifecycleTransitionsTotal,
    lifecycleHardDeletedTotal,
    lifecycleVectorsDeletedTotal,
    reembedRunTotal,
    reembedRunDuration,
    reembedItemsTotal,
  };

  globalThis.__perkosKnowledgeMetricsRegistry = register;
  globalThis.__perkosKnowledgeMetrics = metrics;
  return { register, metrics };
}

export function getRegistry(): Registry {
  return init().register;
}

export function getMetrics(): KnowledgeMetrics {
  return init().metrics;
}

/**
 * Render the registry to Prometheus text format. Async because
 * collectDefaultMetrics samples lazily on collect().
 */
export async function renderMetrics(): Promise<{ body: string; contentType: string }> {
  const register = getRegistry();
  return {
    body: await register.metrics(),
    contentType: register.contentType,
  };
}
