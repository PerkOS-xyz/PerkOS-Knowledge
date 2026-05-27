/**
 * Prometheus scrape endpoint.
 *
 * Returns the full registry in Prometheus text format. Public on
 * purpose — metrics endpoints are usually unauthenticated so the
 * scraper doesn't need a key rotation playbook; any per-metric value
 * that's sensitive should not be put in a metric label in the first
 * place. (We don't expose any consumer wallet ids here — all
 * counters are aggregated by tier/result, not per-actor.)
 *
 * Scrape config example for Grafana Alloy / Prometheus:
 *
 *   scrape_configs:
 *     - job_name: perkos-knowledge
 *       scrape_interval: 30s
 *       static_configs:
 *         - targets: [knowledge.perkos.xyz]
 *       metrics_path: /api/metrics
 *       scheme: https
 */
import { renderMetrics } from "../../../lib/metrics";

export const dynamic = "force-dynamic";

export async function GET() {
  const { body, contentType } = await renderMetrics();
  return new Response(body, {
    status: 200,
    headers: { "content-type": contentType },
  });
}
