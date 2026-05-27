# Data retention — `research_items`

This doc captures the retention policy for knowledge items (`research_items`) and how the lifecycle sweep enforces it. It is the operator's reference; the compliance-facing answer ("how long do we keep your data?") lives in PerkOS's privacy policy and links back here for the mechanism.

## Two-stage lifecycle

A knowledge item moves through three tiers; the sweep is what makes those transitions happen.

| Tier | Meaning | Set by |
|---|---|---|
| `working` | Active. Returned by `/skill/query`, indexed for search. | Default at ingest; revival from archived. |
| `archived` | Soft-removed. Not surfaced in normal queries; still on disk. | `runLifecycleSweep` when Rule 5 fires (old + low quality + unused). |
| `evicted` | Marked for hard deletion. Still on disk until retention window passes. | `runLifecycleSweep` when an archived item passes the evict threshold without revival. |

The decision rules live in [`lib/lifecycle.ts`](lib/lifecycle.ts) and are pure functions. The executor that applies them and runs the hard-delete is [`lib/lifecycleSweep.ts`](lib/lifecycleSweep.ts).

## Retention windows

| Window | Default | Override |
|---|---|---|
| `freshDays` — items younger than this stay `working` regardless of score | 14 | `LifecycleConfig.freshDays` |
| `archiveAfterDays` — items older than this AND low score → `archived` | 90 | `LifecycleConfig.archiveAfterDays` |
| `evictAfterDays` — archived items untouched this long → `evicted` | 180 | `LifecycleConfig.evictAfterDays` |
| `retentionDays` — evicted rows are hard-deleted after this much time in `evicted` state | **90** | Sweep request body `retentionDays` |

Combined, a low-quality item that is never read or re-scored is hard-deleted approximately **`archiveAfterDays + evictAfterDays + retentionDays` = 360 days** after creation. High-quality items (`qualityScore >= 70`) and items used within `recentUseDays` are protected indefinitely.

## Why hard-delete is gated on `evicted_at`, not `lifecycle_evaluated_at`

`evicted_at` is set only on the transition into `evicted`. If a row is revived (e.g. someone runs a query that returns it, or its quality is re-assessed upward), `evicted_at` is cleared. The hard-delete query specifically requires:

```sql
WHERE lifecycle_tier = 'evicted'
  AND evicted_at IS NOT NULL
  AND evicted_at < NOW() - INTERVAL 'N days'
```

This means a revived-then-re-evicted item resets the retention clock — it gets the full window again. That's the safer default because revivals indicate "someone actually used this row".

## Running the sweep

### Production (cron on the knowledge VPS)

The Next.js server doesn't have a built-in scheduler — sweep is fired by `cron` on the host. Example crontab:

```cron
# Daily at 04:30 UTC. Adjust the URL if knowledge.perkos.xyz changes.
30 4 * * * curl -sS -X POST \
  -H "Authorization: Bearer ${KNOWLEDGE_ADMIN_TOKEN}" \
  -H "content-type: application/json" \
  -d '{"dryRun": false}' \
  https://knowledge.perkos.xyz/api/admin/lifecycle/sweep \
  >> /var/log/perkos/knowledge-lifecycle.log 2>&1
```

`KNOWLEDGE_ADMIN_TOKEN` is the same bearer token that protects `/api/admin/*`. It lives in the Hetzner VPS env (`/etc/perkos/knowledge.env`) and **must not** be rotated without also updating the cron entry.

### Manual / ad-hoc (dry-run first)

Always run a dry-run before flipping a tuning knob in production:

```bash
curl -X POST \
  -H "Authorization: Bearer $KNOWLEDGE_ADMIN_TOKEN" \
  -H "content-type: application/json" \
  -d '{"dryRun": true, "retentionDays": 60}' \
  https://knowledge.perkos.xyz/api/admin/lifecycle/sweep | jq .
```

Returns:

```json
{
  "ok": true,
  "stats": {
    "scanned": 1234,
    "archived": 12,
    "evicted": 4,
    "revived": 1,
    "unchanged": 1217,
    "hardDeleted": 0,
    "durationMs": 184,
    "startedAt": "2026-05-27T16:30:00.000Z",
    "retentionDays": 60,
    "dryRun": true
  }
}
```

`hardDeleted` is always `0` for dry-runs. Re-issue without `"dryRun": true` to actually delete.

## Compliance / right-to-erasure

When a wallet requests deletion of items they contributed:

1. Identify rows: `SELECT id FROM research_items WHERE contributor_wallet = lower(:wallet)`.
2. Force-evict by updating those rows directly: `UPDATE research_items SET lifecycle_tier = 'evicted', evicted_at = NOW() WHERE id = ANY(:ids)`.
3. Either wait the retention window for the sweep to hard-delete, or pass `retentionDays=0` and trigger one manual sweep to delete immediately.

For right-to-erasure under GDPR a `retentionDays=0` sweep targeted at the affected rows is the documented procedure. Log the call (cron output covers this for scheduled sweeps; manual deletions should be entered into the audit log).

## What the sweep does NOT do

- **It does not delete `working` or `archived` rows.** Only `evicted` rows with `evicted_at` older than the cutoff.
- **It does not back up.** Postgres dumps are the operator's job (see infra runbook), not this sweep.
- **It does not anonymize, only deletes.** If a future requirement is "keep the row but strip PII", we'd add a separate `lifecycle_tier = 'anonymized'` path.

## What it DOES do (formerly gaps)

- **It cleans up Qdrant.** Hard-deletes in Postgres now trigger a `deleteVectors()` call into the `perkos_research` collection (PR #32). Failures are non-fatal and surface as `stats.vectorsError`; orphans can be retried by a later sweep or a one-shot janitor.
- **It emits Prometheus metrics.** `perkos_knowledge_lifecycle_sweep_total`, `perkos_knowledge_lifecycle_transitions_total{to}`, `perkos_knowledge_lifecycle_hard_deleted_total`, `perkos_knowledge_lifecycle_vectors_deleted_total`, and a sweep-duration histogram are exposed at `/api/metrics`. The `grafana/dashboards/perkos-knowledge.json` board in this repo visualizes them.
