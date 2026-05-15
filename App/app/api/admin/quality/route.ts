import { requireAdmin } from '../../../../lib/admin';
import { withDb } from '../../../../lib/db';
import { assessKnowledgeQuality } from '../../../../lib/quality';

export const dynamic = 'force-dynamic';

function publicQualityRow(row: Record<string, unknown>) {
  return {
    id: row.id,
    title: row.title,
    visibility: row.visibility,
    contributorAgentId: row.contributor_agent_id,
    validationStatus: row.validation_status,
    qualityScore: row.quality_score,
    confidencePercent: row.confidence_percent,
    trustTier: row.trust_tier,
    qualityReasons: row.quality_reasons,
    evidenceCount: row.evidence_count,
    updatedAt: row.updated_at,
  };
}

export async function GET(request: Request) {
  const unauthorized = requireAdmin(request);
  if (unauthorized) return unauthorized;

  const url = new URL(request.url);
  const status = url.searchParams.get('status') || 'pending';
  const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') || 50), 250));

  const result = await withDb(async (client) => {
    const stats = await client.query(`
      SELECT validation_status, trust_tier, count(*)::int AS count
      FROM research_items
      GROUP BY validation_status, trust_tier
      ORDER BY validation_status, trust_tier
    `);
    const rows = await client.query(
      `SELECT id, title, visibility, contributor_agent_id, validation_status, quality_score,
              confidence_percent, trust_tier, quality_reasons, jsonb_array_length(evidence) AS evidence_count, updated_at
       FROM research_items
       WHERE ($1 = 'all' OR validation_status = $1)
       ORDER BY coalesce(confidence_percent, quality_score, 0) ASC, updated_at DESC
       LIMIT $2`,
      [status, limit]
    );
    return { stats: stats.rows, items: rows.rows.map(publicQualityRow) };
  });

  return Response.json({ ok: true, ...result, ts: new Date().toISOString() });
}

export async function POST(request: Request) {
  const unauthorized = requireAdmin(request);
  if (unauthorized) return unauthorized;

  const body = await request.json().catch(() => ({}));
  const ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean).slice(0, 250) : [];
  const mode = String(body.mode || 'assess');
  const validatorAgentId = String(body.validatorAgentId || body.validator_agent_id || 'admin-quality-validator').trim();
  if (!ids.length && mode !== 'backfill') return Response.json({ ok: false, error: 'ids_required' }, { status: 400 });

  const result = await withDb(async (client) => {
    const select = mode === 'backfill'
      ? await client.query(
          `SELECT id, title, summary, confidence, evidence, validation_status, contributor_agent_id, content_hash
           FROM research_items
           WHERE confidence_percent IS NULL OR quality_score IS NULL OR trust_tier = 'untrusted'
           ORDER BY updated_at DESC
           LIMIT 250`
        )
      : await client.query(
          `SELECT id, title, summary, confidence, evidence, validation_status, contributor_agent_id, content_hash
           FROM research_items
           WHERE id = ANY($1::text[])`,
          [ids]
        );

    const updated: Array<Record<string, unknown>> = [];
    for (const row of select.rows) {
      const assessment = assessKnowledgeQuality({
        title: row.title,
        summary: row.summary,
        confidence: row.confidence,
        evidence: row.evidence,
        validationStatus: row.validation_status,
        contributorAgentId: row.contributor_agent_id,
        contentHash: row.content_hash,
      });
      const finalStatus = body.approve === true && assessment.score >= 70
        ? 'validated'
        : body.reject === true
          ? 'rejected'
          : assessment.status;
      const qualityReasons = finalStatus === 'validated'
        ? assessment.reasons.filter((reason) => reason !== 'awaiting independent validation')
        : assessment.reasons;
      await client.query(
        `UPDATE research_items
         SET validation_status = $2,
             quality_score = $3,
             confidence_percent = $4,
             trust_tier = $5,
             quality_reasons = $6,
             validated_at = CASE WHEN $2 = 'validated' THEN now() ELSE validated_at END,
             updated_at = now()
         WHERE id = $1`,
        [row.id, finalStatus, assessment.score, assessment.confidencePercent, assessment.tier, qualityReasons]
      );
      await client.query(
        `INSERT INTO contributor_quality_events (research_item_id, contributor_agent_id, event_type, score, metadata)
         VALUES ($1, $2, $3, $4, $5)`,
        [row.id, row.contributor_agent_id || null, finalStatus === 'validated' ? 'validated' : 'assessed', assessment.score, { validatorAgentId, assessment }]
      );
      updated.push({ id: row.id, validationStatus: finalStatus, confidencePercent: assessment.confidencePercent, trustTier: assessment.tier, reasons: qualityReasons });
    }
    return { updated };
  });

  return Response.json({ ok: true, ...result, ts: new Date().toISOString() });
}
