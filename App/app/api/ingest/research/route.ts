import { withDb } from '../../../../lib/db';
import { upsertVectors, type VectorItem } from '../../../../lib/vector';

export const dynamic = 'force-dynamic';

type Visibility = 'public' | 'private';

type ResearchItem = {
  date?: string;
  track?: string;
  title?: string;
  path?: string;
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
};

function unauthorized() {
  return Response.json({ ok: false, error: 'unauthorized' }, { status: 401 });
}

function normalizeVisibility(value?: string): Visibility {
  return value === 'public' ? 'public' : 'private';
}

function textOrNull(value: unknown) {
  const text = String(value || '').trim();
  return text || null;
}

async function ensureAgentAndOrg(client: import('pg').Client, item: ResearchItem, body: Record<string, unknown>) {
  const organizationId = textOrNull(item.organization_id || body.organization_id);
  const contributorAgentId = textOrNull(item.contributor_agent_id || body.contributor_agent_id);
  const contributorName = textOrNull(body.contributor_name) || contributorAgentId;
  const contributorWallet = textOrNull(item.contributor_wallet || body.contributor_wallet);
  const contributorErc8004 = textOrNull(item.contributor_erc8004_identity || body.contributor_erc8004_identity);

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
      [contributorAgentId, contributorName || contributorAgentId]
    );

    if (contributorWallet || contributorErc8004) {
      await client.query(
        `INSERT INTO agent_identities (agent_id, wallet, erc8004_identity, chain)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [contributorAgentId, contributorWallet, contributorErc8004, textOrNull(body.identity_chain)]
      );
    }

    if (organizationId) {
      await client.query(
        `INSERT INTO organization_agents (organization_id, agent_id, role, scopes)
         VALUES ($1, $2, 'contributor', ARRAY['ingest'])
         ON CONFLICT (organization_id, agent_id) DO NOTHING`,
        [organizationId, contributorAgentId]
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
  const source = String(body.source || 'unknown');
  const defaultVisibility = normalizeVisibility(String(body.visibility || 'public'));
  const items = Array.isArray(body.items) ? body.items as ResearchItem[] : [];

  if (!items.length) {
    return Response.json({ ok: false, error: 'items_required' }, { status: 400 });
  }

  const privateWithoutOrg = items.some((item) => normalizeVisibility(item.visibility || defaultVisibility) === 'private' && !textOrNull(item.organization_id || body.organization_id));
  if (privateWithoutOrg) {
    return Response.json({ ok: false, error: 'private_items_require_organization_id' }, { status: 400 });
  }

  const vectorItems: VectorItem[] = [];

  const result = await withDb(async (client) => {
    let upserted = 0;
    for (const item of items) {
      const path = String(item.path || '').trim();
      const title = String(item.title || path || 'Untitled').trim();
      if (!path) continue;

      const visibility = normalizeVisibility(item.visibility || defaultVisibility);
      const identity = await ensureAgentAndOrg(client, item, body);
      const id = `${source}:${visibility}:${identity.organizationId || 'public'}:${path}`;
      const validationStatus = item.validation_status || 'unvalidated';
      const sanitizationStatus = item.sanitization_status || 'unspecified';

      const vectorItem: VectorItem = {
        id,
        source,
        date: item.date || null,
        track: item.track || null,
        title,
        path,
        agents: item.agents || [],
        chains: item.chains || [],
        summary: item.summary || null,
        visibility,
        organization_id: identity.organizationId,
        contributor_agent_id: identity.contributorAgentId,
        validation_status: validationStatus,
        sanitization_status: sanitizationStatus,
      };
      vectorItems.push(vectorItem);

      await client.query(
        `INSERT INTO research_items
          (id, source, date, track, title, path, agents, chains, status, confidence, summary, raw,
           visibility, organization_id, contributor_agent_id, contributor_wallet, contributor_erc8004_identity,
           validation_status, sanitization_status, quality_score, submitted_at, updated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,now(),now())
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
          updated_at = now()`,
        [
          id,
          source,
          item.date || null,
          item.track || null,
          title,
          path,
          item.agents || [],
          item.chains || [],
          item.status || null,
          item.confidence || null,
          item.summary || null,
          item,
          visibility,
          identity.organizationId,
          identity.contributorAgentId,
          identity.contributorWallet,
          identity.contributorErc8004,
          validationStatus,
          sanitizationStatus,
          item.quality_score ?? null,
        ]
      );
      upserted += 1;
    }
    const count = await client.query('SELECT count(*)::int AS count FROM research_items');
    return { upserted, total: count.rows[0].count };
  });

  const vector = await upsertVectors(vectorItems);

  return Response.json({ ok: true, source, ...result, vector, ts: new Date().toISOString() });
}
