#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

function arg(name, fallback = null) {
  const prefix = `--${name}=`;
  const inline = process.argv.find((entry) => entry.startsWith(prefix));
  if (inline) return inline.slice(prefix.length);
  const index = process.argv.indexOf(`--${name}`);
  if (index >= 0 && process.argv[index + 1]) return process.argv[index + 1];
  return fallback;
}

const configPath = arg('config', process.env.KNOWLEDGE_PROVIDER_CONFIG || 'knowledge.provider.json');
const dryRun = process.argv.includes('--dry-run');

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function required(value, name) {
  if (!value) {
    console.error(`${name} is required`);
    process.exit(2);
  }
  return value;
}

function walk(dir, predicate, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, predicate, out);
    else if (entry.isFile() && predicate(full)) out.push(full);
  }
  return out;
}

function titleOf(text, file) {
  return (text.match(/^#\s+(.+)$/m) || [null, path.basename(file, path.extname(file))])[1].trim();
}

function summaryOf(text) {
  const bullets = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+|^#{2,3}\s+/.test(line))
    .slice(0, 8)
    .map((line) => line.replace(/^#{2,3}\s+/, '').trim());
  return bullets.join(' | ') || text.replace(/\s+/g, ' ').trim().slice(0, 500);
}

function dateFromName(name, fallback = null) {
  return (name.match(/\d{4}-\d{2}-\d{2}/) || [fallback || new Date().toISOString().slice(0, 10)])[0];
}

function pct(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return String(value ?? 'n/a');
  return `${(number * 100).toFixed(4)}%`;
}

function cleanArray(value, fallback = []) {
  if (!Array.isArray(value)) return fallback;
  return value.map((entry) => String(entry).trim()).filter(Boolean);
}

function normalizeItem(item, provider, sourceConfig) {
  return {
    ...item,
    visibility: item.visibility || provider.visibility,
    organization_id: item.organization_id || provider.organizationId,
    contribution_type: item.contribution_type || sourceConfig.contributionType || provider.contributionType || 'research',
    metadata: {
      ...(item.metadata || {}),
      provider_profile: provider.agentId,
      provider_source_type: sourceConfig.type,
    },
  };
}

function loadKnowledgeTree(sourceConfig, provider) {
  const indexPath = required(sourceConfig.indexPath, 'sources[].indexPath');
  const sourceRoot = sourceConfig.sourceRoot || path.dirname(path.dirname(indexPath));
  const index = readJson(indexPath);
  return (Array.isArray(index.items) ? index.items : []).map((item) => normalizeItem({
    ...item,
    organization_id: provider.organizationId,
    visibility: provider.visibility,
    contribution_type: sourceConfig.contributionType || 'research_digest',
    evidence: item.evidence || [{ type: 'file', path: item.path, note: 'knowledge tree source item' }],
    metadata: {
      ...(item.metadata || {}),
      generated_at: index.generatedAt || null,
      source_root: sourceRoot,
    },
  }, provider, sourceConfig));
}

function loadMarkdownDirectory(sourceConfig, provider) {
  const dir = required(sourceConfig.dir, 'sources[].dir');
  const files = walk(dir, (file) => file.endsWith('.md')).sort();
  return files.map((file) => {
    const text = fs.readFileSync(file, 'utf8');
    const stat = fs.statSync(file);
    const rel = path.relative(dir, file);
    return normalizeItem({
      date: dateFromName(rel, stat.mtime.toISOString().slice(0, 10)),
      track: sourceConfig.track || 'research',
      title: titleOf(text, file),
      path: path.posix.join(sourceConfig.pathPrefix || 'docs', rel.split(path.sep).join('/')),
      agents: cleanArray(sourceConfig.agents, [provider.agentId]),
      chains: cleanArray(sourceConfig.chains, ['multi']),
      confidence: sourceConfig.confidence || 'medium',
      summary: summaryOf(text),
      content: text.slice(0, sourceConfig.maxContentLength || 20000),
      evidence: [{ type: 'file', path: rel, note: sourceConfig.evidenceNote || 'provider markdown source' }],
      metadata: { source_mtime: stat.mtime.toISOString() },
    }, provider, sourceConfig);
  });
}

function fundingSummary(doc) {
  const rates = Array.isArray(doc.rates) ? doc.rates : [];
  const opportunities = doc.analysis && Array.isArray(doc.analysis.opportunities) ? doc.analysis.opportunities : [];
  const alerts = doc.analysis && Array.isArray(doc.analysis.alerts) ? doc.analysis.alerts : [];
  const symbols = [...new Set(rates.map((r) => r.symbol).filter(Boolean))];
  const rateBits = rates.slice(0, 12).map((r) => `${r.exchange || 'exchange'} ${r.symbol || 'symbol'} ${pct(r.fundingRate ?? r.rate ?? r.funding_rate)}`);
  return [
    `Funding-rate snapshot across ${symbols.length || 'tracked'} symbols: ${symbols.join(', ') || 'n/a'}.`,
    rateBits.length ? `Sample rates: ${rateBits.join('; ')}.` : '',
    opportunities.length ? `${opportunities.length} opportunities detected.` : 'No significant opportunities detected.',
    alerts.length ? `${alerts.length} alerts detected.` : 'No alerts detected.',
  ].filter(Boolean).join(' ');
}

function loadFundingRatesDirectory(sourceConfig, provider) {
  const dir = required(sourceConfig.dir, 'sources[].dir');
  const files = walk(dir, (file) => file.endsWith('.json')).sort();
  return files.map((file) => {
    const doc = readJson(file);
    const rel = path.relative(dir, file);
    const date = dateFromName(rel);
    const rates = Array.isArray(doc.rates) ? doc.rates : [];
    const symbols = [...new Set(rates.map((r) => r.symbol).filter(Boolean))];
    return normalizeItem({
      date,
      track: sourceConfig.track || 'markets',
      title: sourceConfig.title ? sourceConfig.title.replace('{date}', date) : `Funding-rate snapshot ${date}`,
      path: path.posix.join(sourceConfig.pathPrefix || 'funding-rates', date),
      agents: cleanArray(sourceConfig.agents, [provider.agentId]),
      chains: cleanArray(sourceConfig.chains, ['multi']),
      confidence: sourceConfig.confidence || 'medium',
      summary: fundingSummary(doc),
      content: JSON.stringify({ rates: doc.rates || [], analysis: doc.analysis || {}, metadata: doc.metadata || {} }).slice(0, sourceConfig.maxContentLength || 20000),
      evidence: [{ type: 'file', path: rel, note: sourceConfig.evidenceNote || 'provider funding-rate snapshot' }],
      metadata: {
        snapshot_timestamp: doc.timestamp || null,
        symbols,
        exchanges: doc.metadata && doc.metadata.exchanges || [],
      },
    }, provider, sourceConfig);
  });
}

const loaders = {
  'knowledge-tree-index': loadKnowledgeTree,
  'markdown-directory': loadMarkdownDirectory,
  'funding-rates-directory': loadFundingRatesDirectory,
};

async function main() {
  const config = readJson(configPath);
  const provider = {
    agentId: required(config.provider && config.provider.agentId, 'provider.agentId'),
    organizationId: required(config.provider && config.provider.organizationId, 'provider.organizationId'),
    visibility: (config.provider && config.provider.visibility) || 'private',
    source: (config.provider && config.provider.source) || (config.provider && config.provider.agentId),
    contributionType: config.provider && config.provider.contributionType || 'research',
  };

  const tokenEnv = config.auth && config.auth.tokenEnv || 'KNOWLEDGE_INGEST_TOKEN';
  const token = process.env[tokenEnv];
  const baseUrl = process.env.KNOWLEDGE_BASE_URL || config.baseUrl || 'https://knowledge.perkos.xyz';
  const sources = Array.isArray(config.sources) ? config.sources : [];
  if (!sources.length) required('', 'sources');

  const items = sources.flatMap((sourceConfig) => {
    const loader = loaders[sourceConfig.type];
    if (!loader) throw new Error(`Unsupported source type: ${sourceConfig.type}`);
    return loader(sourceConfig, provider);
  });

  if (dryRun) {
    console.log(JSON.stringify({ ok: true, dryRun: true, provider, count: items.length, first: items[0] || null }, null, 2));
    return;
  }

  required(token, tokenEnv);
  const res = await fetch(`${baseUrl.replace(/\/$/, '')}/api/ingest/research`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
      'x-agent-id': provider.agentId,
      'x-organization-id': provider.organizationId,
    },
    body: JSON.stringify({
      source: provider.source,
      visibility: provider.visibility,
      organization_id: provider.organizationId,
      contribution_type: provider.contributionType,
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
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
