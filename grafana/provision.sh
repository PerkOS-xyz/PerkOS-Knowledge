#!/usr/bin/env bash
# Idempotent Grafana dashboard provisioner.
#
# POSTs every JSON under grafana/dashboards/ to the Grafana HTTP API.
# Designed to be safely re-run: the API matches dashboards by `uid`
# and overwrites in place (overwrite=true). New dashboard? Created.
# Existing dashboard? Updated. Removed dashboard? Untouched (we do
# NOT prune so an operator can hand-edit experimental boards without
# fear of the next provision wiping them).
#
# Required env:
#   GRAFANA_URL       e.g. https://grafana.example.com
#   GRAFANA_API_KEY   Service-account API token with editor on the target folder
#
# Optional env:
#   GRAFANA_FOLDER_UID    Folder to land dashboards in. Default: General (root).
#   DASHBOARD_DIR         Directory to read from. Default: grafana/dashboards.
#   DRY_RUN               Set to 1 to print the curl bodies without sending.
#
# Exit codes:
#   0 — all dashboards uploaded (or printed in DRY_RUN).
#   1 — required env unset.
#   2 — at least one dashboard upload failed.

set -euo pipefail

: "${GRAFANA_URL:?GRAFANA_URL is required (e.g. https://grafana.example.com)}"
: "${GRAFANA_API_KEY:?GRAFANA_API_KEY is required}"

DASHBOARD_DIR="${DASHBOARD_DIR:-$(dirname "$0")/dashboards}"
FOLDER_UID="${GRAFANA_FOLDER_UID:-}"
DRY_RUN="${DRY_RUN:-0}"

if [[ ! -d "$DASHBOARD_DIR" ]]; then
  echo "Dashboard directory not found: $DASHBOARD_DIR" >&2
  exit 1
fi

shopt -s nullglob
DASHBOARDS=("$DASHBOARD_DIR"/*.json)
if [[ ${#DASHBOARDS[@]} -eq 0 ]]; then
  echo "No dashboards in $DASHBOARD_DIR" >&2
  exit 0
fi

failures=0

for file in "${DASHBOARDS[@]}"; do
  name=$(basename "$file")
  # Wrap the exported dashboard JSON in the API envelope. We always
  # set overwrite=true so a re-run updates instead of creating a
  # duplicate-uid error.
  if [[ -n "$FOLDER_UID" ]]; then
    payload=$(jq --argjson overwrite true \
                 --arg folder "$FOLDER_UID" \
                 '{dashboard: ., folderUid: $folder, overwrite: $overwrite, message: "Provisioned via grafana/provision.sh"}' \
                 "$file")
  else
    payload=$(jq --argjson overwrite true \
                 '{dashboard: ., overwrite: $overwrite, message: "Provisioned via grafana/provision.sh"}' \
                 "$file")
  fi

  if [[ "$DRY_RUN" == "1" ]]; then
    echo "--- would upload $name ---"
    echo "$payload" | jq -c '{title: .dashboard.title, uid: .dashboard.uid, overwrite: .overwrite}'
    continue
  fi

  echo -n "Uploading $name … "
  http_code=$(curl -sS -o /tmp/grafana-upload-resp.json -w "%{http_code}" \
    -X POST "${GRAFANA_URL%/}/api/dashboards/db" \
    -H "Authorization: Bearer $GRAFANA_API_KEY" \
    -H "Content-Type: application/json" \
    -d "$payload")

  if [[ "$http_code" == "200" || "$http_code" == "201" ]]; then
    url=$(jq -r '.url // ""' /tmp/grafana-upload-resp.json)
    echo "ok ($http_code) → $url"
  else
    echo "FAILED ($http_code)"
    cat /tmp/grafana-upload-resp.json >&2
    echo >&2
    failures=$((failures + 1))
  fi
done

if [[ $failures -gt 0 ]]; then
  echo "$failures dashboard(s) failed to upload" >&2
  exit 2
fi
