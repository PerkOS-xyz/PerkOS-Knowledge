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

function flag(name) {
  return process.argv.includes(`--${name}`);
}

function required(value, name) {
  if (!value) {
    console.error(`${name} is required`);
    process.exit(2);
  }
  return value;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function titleOf(text, file) {
  return (text.match(/^#\s+(.+)$/m) || [null, path.basename(file, path.extname(file))])[1].trim();
}

function summaryOf(text) {
  const lines = text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => /^[-*]\s+|^#{2,3}\s+/.test(line))
    .slice(0, 10)
    .map((line) => line.replace(/^#{2,3}\s+/, '').trim());
  return lines.join(' | ') || text.replace(/\s+/g, ' ').trim().slice(0, 700);
}

function cleanArray(value, fallback = []) {
  if (!value) return fallback;
  if (Array.isArray(value)) return value.map((entry) => String(entry).trim()).filter(Boolean);
  return String(value).split(',').map((entry) => entry.trim()).filter(Boolean);
}

function loadConfig() {
  const configPath = arg('config', process.env.KNOWLEDGE_PROVIDER_CONFIG || 'knowledge.provider.json');
  const config = readJson(configPath);
  const provider = config.provider || {};
  return {
    configPath,
    baseUrl: process.env.KNOWLEDGE_BASE_URL || config.baseUrl || 'https://knowledge.perkos.xyz',
    tokenEnv: config.auth && config.auth.tokenEnv || 'KNOWLEDGE_INGEST_TOKEN',
    provider: {
      agentId: required(provider.agentId, 'provider.agentId'),
      organizationId: required(provider.organizationId, 'provider.organizationId'),
      visibility: provider.visibility || 'private',
      source: provider.source || provider.agentId,
      contributionType: provider.contributionType || 'research',
    },
  };
}

async function requestJson(url, options = {}) {
  const res = await fetch(url, options);
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch (_) {}
  if (!res.ok) {
    const error = new Error(`HTTP ${res.status} ${url}: ${text}`);
    error.status = res.status;
    error.body = json || text;
    throw error;
  }
  return json;
}

function providerHeaders(token, provider) {
  return {
    authorization: `Bearer ${token}`,
    'content-type': 'application/json',
    'x-agent-id': provider.agentId,
    'x-organization-id': provider.organizationId,
  };
}

async function listRequests(baseUrl, status, limit) {
  return requestJson(`${baseUrl}/knowledge/requests?status=${encodeURIComponent(status)}&limit=${encodeURIComponent(limit)}`);
}

async function claimRequest(baseUrl, token, provider, requestId) {
  return requestJson(`${baseUrl}/knowledge/requests/${encodeURIComponent(requestId)}/claim`, {
    method: 'POST',
    headers: providerHeaders(token, provider),
    body: JSON.stringify({ source: 'knowledge-request-worker' }),
  });
}

async function ingestFile(baseUrl, token, provider, file, requestId) {
  const text = fs.readFileSync(file, 'utf8');
  const stat = fs.statSync(file);
  const rel = path.basename(file);
  const title = arg('title', titleOf(text, file));
  const track = arg('track', 'requested-research');
  const contributionType = arg('contribution-type', 'requested_research');
  const pathPrefix = arg('path-prefix', 'requests');
  const stablePath = arg('path', `${pathPrefix}/${requestId || path.basename(file, path.extname(file))}.md`);
  const evidence = cleanArray(arg('evidence', ''), []).map((url) => ({ type: 'url', url, note: 'research evidence' }));
  evidence.push({ type: 'file', path: rel, note: 'provider research fulfillment file' });

  const payload = {
    source: provider.source,
    visibility: provider.visibility,
    organization_id: provider.organizationId,
    contribution_type: contributionType,
    items: [{
      date: new Date().toISOString().slice(0, 10),
      track,
      title,
      path: stablePath,
      agents: [provider.agentId],
      chains: cleanArray(arg('chains', 'multi'), ['multi']),
      confidence: arg('confidence', 'medium'),
      summary: summaryOf(text),
      content: text,
      visibility: provider.visibility,
      organization_id: provider.organizationId,
      contribution_type: contributionType,
      evidence,
      metadata: {
        fulfilled_request_id: requestId || null,
        source_mtime: stat.mtime.toISOString(),
        worker: 'knowledge-request-worker',
      },
    }],
  };

  return requestJson(`${baseUrl}/api/ingest/research`, {
    method: 'POST',
    headers: providerHeaders(token, provider),
    body: JSON.stringify(payload),
  });
}

async function fulfillRequest(baseUrl, token, provider, requestId, itemIds, notes) {
  return requestJson(`${baseUrl}/knowledge/requests/${encodeURIComponent(requestId)}/fulfill`, {
    method: 'POST',
    headers: providerHeaders(token, provider),
    body: JSON.stringify({ research_item_ids: itemIds, notes }),
  });
}

async function main() {
  const { baseUrl, tokenEnv, provider } = loadConfig();
  const token = process.env[tokenEnv];
  const positional = process.argv.slice(2).find((entry, index, args) => !entry.startsWith('--') && (index === 0 || !args[index - 1].startsWith('--')));
  const command = arg('command', positional || 'list');
  const status = arg('status', 'open');
  const limit = Number(arg('limit', '10'));

  if (command === 'list') {
    const result = await listRequests(baseUrl.replace(/\/$/, ''), status, limit);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  required(token, tokenEnv);

  if (command === 'claim') {
    const requestId = required(arg('request'), '--request');
    const result = await claimRequest(baseUrl.replace(/\/$/, ''), token, provider, requestId);
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === 'fulfill') {
    const requestId = required(arg('request'), '--request');
    const file = required(arg('file'), '--file');
    const ingest = flag('skip-ingest') ? null : await ingestFile(baseUrl.replace(/\/$/, ''), token, provider, file, requestId);
    const itemIds = cleanArray(arg('item-ids', ''), ingest && Array.isArray(ingest.accepted) ? ingest.accepted.map((item) => item.id) : []);
    const result = await fulfillRequest(
      baseUrl.replace(/\/$/, ''),
      token,
      provider,
      requestId,
      itemIds,
      arg('notes', `Fulfilled by ${provider.agentId} via knowledge-request-worker`)
    );
    console.log(JSON.stringify({ ok: true, ingest, fulfillment: result }, null, 2));
    return;
  }

  console.error(`Unsupported command: ${command}`);
  process.exit(2);
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
