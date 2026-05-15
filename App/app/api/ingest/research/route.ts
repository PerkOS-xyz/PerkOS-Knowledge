import crypto from 'crypto';
import { withDb } from '../../../../lib/db';
import { assessKnowledgeQuality, normalizeEvidence, shouldRejectIngest } from '../../../../lib/quality';
import { upsertVectors, type VectorItem } from '../../../../lib/vector';
import {
  assertProviderCanSubmit,
  contributionId,
  defaultSanitizationStatus,
  defaultValidationStatus,
  getProviderIdentity,
  normalizeProviderVisibility,
  publicationStatus,
  storedVisibility,
  textOrNull,
  type ProviderIdentity,
} from '../../../../lib/providers';

export const dynamic = 'force-dynamic';

type Visibility = 'public' | 'private' | 'public_candidate';

type ResearchItem = {
  date?: string;
  track?: string;
  title?: string;
  path?: string;
  content?: string;
  agents?: string[];
  chains?: string[];
  status?: string;
  confidence?: string;
  summary?: string;
  visibility?: Visibility;
  organization_id?: string | null;
  contributor_agent_id?: string | null;
  contributor_wallet?: string | null;
  contributor_erc8004_identity?: string | null;
  validation_status?: string;
  sanitization_status?: string;
  quality_score?: number | null;
  contribution_type?: string;
  evidence?: unknown[];
  metadata?: Record<string, unknown>;
};

function unauthorized() {
  return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
}

function contentHash(item: ResearchItem) {
  return crypto
    .createHash('sha256')
    .update([item.title || '', item.summary || '', item.content || '', item.path || ''].join('\n'))
    .digest('hex');
}

function cleanTextArray(value: unknown, max = 20) {
  if (!Array.isArray(value)) return [];
  return value.map((entry) => String(entry).trim()).filter(Boolean).slice(0, max);
}

function cleanContributionType(value: unknown) {
  const text = String(value || 'research').trim().toLowerCase().replace(/[^a-z0-9:_-]+/g, '-');
  return text || 'research';
}

async function ensureAgentAndOrg(client: import('pg').Client, item: ResearchItem, body: Record<string, unknown>, identity: ProviderIdentity) {
  const organizationId = textOrNull(item.organization_id) || identity.organizationId;
  const contributorAgentId = textOrNull(item.contributor_agent_id) || identity.agentId;
  const contributorWallet = textOrNull(item.contributor_wallet) || identity.wallet;
  const contributorErc8004 = textOrNull(item.contributor_erc8004_identity) || identity.erc8004Identity;

  // Organizations and agents should normally be onboarded through admin APIs first.
  // Keep this upsert for backward-compatible bootstrap/legacy ingest flows guarded by KNOWLEDGE_INGEST_TOKEN.
  if (organizationId) {
    await client.query(
      `INSERT INTO organizations (id, name, slug)
       VALUES ($1, $2, $1)
       ON CONFLICT (id) DO NOTHING`,
      [organizationId, organizationId]
    );
  }

  if (contributorAgentId) {
    await client.query(
      `INSERT INTO agents (id, display_name, agent_type)
       VALUES ($1, $2, 'contributor')
       ON CONFLICT (id) DO UPDATE SET updated_at = now()`,
      [contributorAgentId, contributorAgentId]
    );

    if (contributorWallet || contributorErc8004) {
      await client.query(
        `INSERT INTO agent_identities (agent_id, wallet, erc8004_identity, chain)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [contributorAgentId, contributorWallet, contributorErc8004, identity.identityChain]
      );
    }
  }

  return { organizationId, contributorAgentId, contributorWallet, contributorErc8004 };
}

export async function POST(request: Request) {
  const token = process.env.KNOWLEDGE_INGEST_TOKEN;
  if (!token) return Response.json({ ok: false, error: 'ingest_not_configured' }, { status: 503 });

  const auth = request.headers.get('authorization') || '';
  if (auth !== `Bearer ${token}`) return unauthorized();

  const body = await request.json();
  const source = String(body.source || 'provider-agent').trim() || 'provider-agent';
  const identity = getProviderIdentity(request, body);
  const defaultVisibility = normalizeProviderVisibility(body.visibility || 'private');
  const items = Array.isArray(body.items) ? body.items as ResearchItem[] : body.item ? [body.item as ResearchItem] : [];

  if (!items.length) {
    return Response.json({ ok: false, error: 'items_required' }, { status: 400 });
  }

  const vectorItems: VectorItem[] = [];

  const result = await withDb(async (client) => {
    let upserted = 0;
    const accepted: Array<{ id: string; path: string; visibility: string; publicationStatus: string; contributorAgentId: string | null }> = [];

    for (const item of items) {
      const path = String(item.path || '').trim();
      const title = String(item.title || path || 'Untitled').trim();
      if (!path) continue;

      const requestedVisibility = normalizeProviderVisibility(item.visibility || defaultVisibility);
      const visibility = storedVisibility(requestedVisibility);
      const publishStatus = publicationStatus(requestedVisibility);
      const requestedValidationStatus = defaultValidationStatus(textOrNull(item.validation_status));
      const sanitizationStatus = defaultSanitizationStatus(requestedVisibility, textOrNull(item.sanitization_status));
      const contributionType = cleanContributionType(item.contribution_type || body.contribution_type);
      const evidence = normalizeEvidence(item.evidence);
      const itemIdentity = await ensureAgentAndOrg(client, item, body, identity);

      const providerCheck = await assertProviderCanSubmit(
        client,
        { ...identity, agentId: itemIdentity.contributorAgentId, organizationId: itemIdentity.organizationId },
        visibility,
        publishStatus
      );
      if (!providerCheck.ok) {
        return { error: providerCheck.error, status: providerCheck.status };
      }

      const id = contributionId(source, itemIdentity.organizationId, path);
      const hash = contentHash(item);
      const quality = assessKnowledgeQuality({
        title,
        summary: item.summary || item.content,
        confidence: item.confidence,
        evidence,
        validationStatus: requestedValidationStatus,
        contributorAgentId: itemIdentity.contributorAgentId,
        contentHash: hash,
      });
      const qualityRejectReason = shouldRejectIngest(quality, {
        requireEvidence: process.env.KNOWLEDGE_REQUIRE_EVIDENCE !== '0',
        allowPending: process.env.KNOWLEDGE_ALLOW_PENDING_INGEST !== '0',
      });
      if (qualityRejectReason) {
        return { error: qualityRejectReason, status: 422 };
      }
      const validationStatus = quality.status;

      const vectorItem: VectorItem = {
        id,
        source,
        date: item.date || null,
        track: item.track || null,
        title,
        path,
        agents: cleanTextArray(item.agents),
        chains: cleanTextArray(item.chains),
        summary: item.summary || item.content || null,
        visibility,
        organization_id: itemIdentity.organizationId,
        contributor_agent_id: itemIdentity.contributorAgentId,
        validation_status: validationStatus,
        sanitization_status: sanitizationStatus,
      };
      vectorItems.push(vectorItem);

      await client.query(
        `INSERT INTO research_items
          (id, source, date, track, title, path, agents, chains, status, confidence, summary, raw,
           visibility, organization_id, contributor_agent_id, contributor_wallet, contributor_erc8004_identity,
           validation_status, sanitization_status, quality_score, contribution_type, publication_status, content_hash, evidence,
           quality_reasons, confidence_percent, trust_tier, submitted_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,now(),now())
         ON CONFLICT (id) DO UPDATE SET
          source = EXCLUDED.source,
          date = EXCLUDED.date,
          track = EXCLUDED.track,
          title = EXCLUDED.title,
          path = EXCLUDED.path,
          agents = EXCLUDED.agents,
          chains = EXCLUDED.chains,
          status = EXCLUDED.status,
          confidence = EXCLUDED.confidence,
          summary = EXCLUDED.summary,
          raw = EXCLUDED.raw,
          visibility = EXCLUDED.visibility,
          organization_id = EXCLUDED.organization_id,
          contributor_agent_id = EXCLUDED.contributor_agent_id,
          contributor_wallet = EXCLUDED.contributor_wallet,
          contributor_erc8004_identity = EXCLUDED.contributor_erc8004_identity,
          validation_status = EXCLUDED.validation_status,
          sanitization_status = EXCLUDED.sanitization_status,
          quality_score = EXCLUDED.quality_score,
          contribution_type = EXCLUDED.contribution_type,
          publication_status = EXCLUDED.publication_status,
          content_hash = EXCLUDED.content_hash,
          evidence = EXCLUDED.evidence,
          quality_reasons = EXCLUDED.quality_reasons,
          confidence_percent = EXCLUDED.confidence_percent,
          trust_tier = EXCLUDED.trust_tier,
          updated_at = now()`,
        [
          id,
          source,
          item.date || null,
          item.track || null,
          title,
          path,
          cleanTextArray(item.agents),
          cleanTextArray(item.chains),
          item.status || 'submitted',
          item.confidence || null,
          item.summary || item.content || null,
          { ...item, provider: { source, agent_id: itemIdentity.contributorAgentId, organization_id: itemIdentity.organizationId, publication_status: publishStatus } },
          visibility,
          itemIdentity.organizationId,
          itemIdentity.contributorAgentId,
          itemIdentity.contributorWallet,
          itemIdentity.contributorErc8004,
          validationStatus,
          sanitizationStatus,
          item.quality_score ?? quality.score,
          contributionType,
          publishStatus,
          hash,
          JSON.stringify(evidence),
          quality.reasons,
          quality.confidencePercent,
          quality.tier,
        ]
      );
      accepted.push({ id, path, visibility, publicationStatus: publishStatus, contributorAgentId: itemIdentity.contributorAgentId });
      upserted += 1;
    }
    const count = await client.query('SELECT count(*)::int AS count FROM research_items');
    return { upserted, total: count.rows[0].count, accepted };
  });

  if ('error' in result) {
    return Response.json({ ok: false, error: result.error }, { status: result.status });
  }

  const vector = await upsertVectors(vectorItems);

  return Response.json({
    ok: true,
    source,
    provider: {
      agentId: identity.agentId,
      organizationId: identity.organizationId,
      hasWallet: Boolean(identity.wallet),
      hasErc8004Identity: Boolean(identity.erc8004Identity),
    },
    ...result,
    vector,
    ts: new Date().toISOString(),
  });
}
