#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const root = process.env.PERKY_RESEARCH_ROOT || '/opt/perkos-standalone-agents/perky/workspace/research';
const indexPath = path.join(root, 'knowledge-tree', 'index.json');
const baseUrl = process.env.KNOWLEDGE_BASE_URL || 'https://knowledge.perkos.xyz';
const token = process.env.KNOWLEDGE_INGEST_TOKEN;

if (!token) {
  console.error('KNOWLEDGE_INGEST_TOKEN is required');
  process.exit(2);
}

if (!fs.existsSync(indexPath)) {
  console.error(`Missing knowledge tree index: ${indexPath}`);
  process.exit(2);
}

const index = JSON.parse(fs.readFileSync(indexPath, 'utf8'));
const items = Array.isArray(index.items) ? index.items : [];

(async () => {
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/ingest/research`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      source: 'perky-research',
      generatedAt: index.generatedAt,
      items,
    }),
  });

  const text = await res.text();
  if (!res.ok) {
    console.error(`Ingest failed: HTTP ${res.status}`);
    console.error(text);
    process.exit(1);
  }
  console.log(text);
})();
