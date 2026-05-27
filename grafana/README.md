# Grafana dashboards-as-code — knowledge service

Versioned dashboards for the Prometheus metrics that `knowledge.perkos.xyz` exposes at `/api/metrics` ([source](../App/lib/metrics.ts)).

This mirrors the same pattern as [PerkOS/grafana/](https://github.com/PerkOS-xyz/PerkOS/tree/main/grafana) so an operator can use one provisioning script across both repos.

## Why this exists

Before this folder, Grafana dashboards for the knowledge service lived only in whatever Grafana instance someone clicked together. This folder is the source of truth — `provision.sh` is how it lands in Grafana.

## Layout

```
grafana/
├── README.md                            # you're here
├── provision.sh                         # idempotent uploader (POST → /api/dashboards/db)
├── validate.mjs                         # cheap structural validator (node grafana/validate.mjs)
└── dashboards/
    └── perkos-knowledge.json            # lifecycle sweep + re-embed + process metrics
```

## What the dashboard shows

| Panel | Answers |
|---|---|
| Lifecycle sweeps — last 24h | "Did the daily sweep cron run, and was it healthy?" |
| Hard-deletes — last 24h | "How many rows + Qdrant points are being recovered? Are we accumulating orphans?" |
| Lifecycle transitions — last 24h | "Where is the lifecycle moving items: into archived, into evicted, back to working?" |
| Sweep duration p50 / p95 | "Is the sweep getting slower as the corpus grows?" |
| Re-embed — items / minute | "Is a migration in flight, and how fast is it going?" |
| Process — RSS + event loop lag | "Is the container healthy beneath the domain metrics?" |

Tagged `perkos` + `knowledge` so it's easy to filter for in Grafana's dashboard list.

## Validating locally

```bash
node grafana/validate.mjs
```

Catches: JSON parse errors, missing required fields, duplicate panel ids, duplicate uids across files, and panels whose `expr` doesn't reference any `perkos_` metric.

## Provisioning to Grafana

Required env:

```bash
export GRAFANA_URL=https://your-grafana.example.com
export GRAFANA_API_KEY=glsa_xxxxxxxxxxxxxxxxxxxxx  # service-account token, editor on target folder
```

Optional:

```bash
export GRAFANA_FOLDER_UID=perkos-prod
export DRY_RUN=1
```

Run:

```bash
./grafana/provision.sh
```

Idempotent — re-running updates in place by `uid` (`overwrite=true`). Does not prune dashboards removed from the folder.

## Adding a new dashboard

Same flow as PerkOS/grafana/:
1. Build in Grafana UI.
2. Export with "Export for sharing externally".
3. Drop into `grafana/dashboards/`, rename to `perkos-<name>.json`.
4. Set `uid` to `perkos-knowledge-<descriptive-name>` so re-exports update in place.
5. `node grafana/validate.mjs`.
6. `./grafana/provision.sh`.

## Prometheus scrape

Add to your Prometheus / Grafana Alloy config:

```yaml
scrape_configs:
  - job_name: perkos-knowledge
    scrape_interval: 30s
    static_configs:
      - targets: [knowledge.perkos.xyz]
    metrics_path: /api/metrics
    scheme: https
```

The endpoint is **unauthenticated** by design — no per-actor metric labels, so there's nothing sensitive to gate behind a token. Same convention as the mini-app's `/metrics`.
