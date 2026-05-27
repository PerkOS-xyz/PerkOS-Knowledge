#!/usr/bin/env node
/**
 * Cheap structural check for the dashboard JSON files in this folder.
 *
 * Not a full Grafana schema validator — Grafana ships ~600 KB of JSON
 * schema and most of it is panel-type-specific. What this catches:
 *
 *   - JSON parse errors (most common breakage)
 *   - Missing required top-level fields (uid, title, panels, schemaVersion)
 *   - Duplicate panel ids (silently breaks Grafana's layout)
 *   - Duplicate dashboard uids across files (the provisioner would clobber)
 *   - Panels that reference a Prometheus metric that contains a typo
 *     (we only check the `perkos_*` prefix is present, since every
 *     metric we instrument is namespaced — this catches dropped
 *     prefix in copy-paste, not naming-rot)
 *
 * Exit code is the number of files with errors; 0 means all good.
 *
 * Run: node grafana/validate.mjs
 */
import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const dashDir = join(here, "dashboards");

const REQUIRED_TOP_LEVEL = ["uid", "title", "panels", "schemaVersion"];
const SEEN_UIDS = new Map(); // uid -> file (for duplicate detection)

function fail(file, msg) {
  console.error(`  ✗ ${file}: ${msg}`);
  return 1;
}

async function validateOne(file) {
  let errors = 0;
  const raw = await readFile(join(dashDir, file), "utf8");
  let json;
  try {
    json = JSON.parse(raw);
  } catch (err) {
    return fail(file, `JSON parse error: ${err.message}`);
  }

  for (const key of REQUIRED_TOP_LEVEL) {
    if (json[key] === undefined) errors += fail(file, `missing required field: ${key}`);
  }

  if (SEEN_UIDS.has(json.uid)) {
    errors += fail(
      file,
      `duplicate uid "${json.uid}" — also in ${SEEN_UIDS.get(json.uid)}`,
    );
  } else {
    SEEN_UIDS.set(json.uid, file);
  }

  if (Array.isArray(json.panels)) {
    const ids = new Set();
    for (const p of json.panels) {
      if (p.id == null) errors += fail(file, `panel "${p.title ?? "?"}" missing id`);
      else if (ids.has(p.id))
        errors += fail(file, `duplicate panel id ${p.id}`);
      else ids.add(p.id);

      for (const t of p.targets ?? []) {
        const expr = String(t.expr ?? "");
        // Cheap sanity: any prom query in our dashboards must reference
        // at least one perkos_ metric, otherwise the panel is broken.
        if (expr && !expr.includes("perkos_")) {
          errors += fail(
            file,
            `panel ${p.id} target ${t.refId ?? "?"} expr has no perkos_ metric: ${expr}`,
          );
        }
      }
    }
  }

  if (errors === 0) console.log(`  ✓ ${file}`);
  return errors;
}

async function main() {
  const files = (await readdir(dashDir)).filter((f) => f.endsWith(".json")).sort();
  if (!files.length) {
    console.log("No dashboard JSON files to validate.");
    return;
  }
  console.log(`Validating ${files.length} dashboard file(s):`);

  let badFiles = 0;
  for (const f of files) {
    const errs = await validateOne(f);
    if (errs > 0) badFiles++;
  }

  if (badFiles > 0) {
    console.error(`\n${badFiles} file(s) failed validation.`);
    process.exit(badFiles);
  }
  console.log("\nAll dashboards valid.");
}

await main();
