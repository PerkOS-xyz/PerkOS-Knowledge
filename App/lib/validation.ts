/**
 * Independent validation — the credibility core of the "validated knowledge"
 * rail. Validating a request must (a) be done by an agent that is NOT the one
 * that fulfilled it or contributed the items (no self-approval), and (b) actually
 * promote the contributed research items to `validated` so the enterprise /
 * validated_only tier can return them. Both halves live here so the request
 * `validate` route and the admin quality tool share one implementation.
 */
import type { Client } from "pg";

import { assessKnowledgeQuality } from "./quality";

/**
 * Guard: a validator may not certify their own work. Reject when the validator
 * is the request's fulfiller or a contributor of any item being certified —
 * otherwise "validated" would just mean "self-approved". Pure + testable.
 */
export function assertValidatorIndependent(input: {
  validatorAgentId: string;
  fulfilledByAgentId?: string | null;
  contributorAgentIds?: Array<string | null | undefined>;
}): { ok: true } | { ok: false; reason: string } {
  const v = (input.validatorAgentId || "").trim().toLowerCase();
  if (!v) return { ok: false, reason: "validator_agent_required" };
  const fulfiller = (input.fulfilledByAgentId || "").trim().toLowerCase();
  if (fulfiller && fulfiller === v) return { ok: false, reason: "validator_is_the_fulfiller" };
  const contributors = (input.contributorAgentIds || [])
    .map((c) => (c || "").trim().toLowerCase())
    .filter(Boolean);
  if (contributors.includes(v)) return { ok: false, reason: "validator_is_a_contributor" };
  return { ok: true };
}

export type CertifiedItem = {
  id: string;
  validationStatus: "validated" | "pending";
  confidencePercent: number;
  trustTier: string;
  reasons: string[];
};

/**
 * Certify research items as independently validated. Recomputes the quality
 * rubric with `validationStatus='validated'` (so the validated bump applies) and
 * promotes each item to `validated` only when it clears the enterprise floor
 * (score >= 70); weaker items stay `pending` with a reason, so a thumbs-up can't
 * launder a thin item past the bar. Logs one `contributor_quality_events` row
 * per item (who validated it + the assessment). Mirrors `/api/admin/quality`.
 *
 * The caller owns the independence check ([assertValidatorIndependent]) and the
 * request-status transition; this only touches the items.
 */
export async function certifyResearchItems(
  client: Client,
  input: { itemIds: string[]; validatorAgentId: string },
): Promise<CertifiedItem[]> {
  const ids = input.itemIds.filter(Boolean);
  if (!ids.length) return [];

  const select = await client.query(
    `SELECT id, title, summary, confidence, evidence, validation_status, contributor_agent_id, content_hash
       FROM research_items WHERE id = ANY($1::text[])`,
    [ids],
  );

  const out: CertifiedItem[] = [];
  for (const row of select.rows) {
    const assessment = assessKnowledgeQuality({
      title: row.title,
      summary: row.summary,
      confidence: row.confidence,
      evidence: row.evidence,
      validationStatus: "validated",
      contributorAgentId: row.contributor_agent_id,
      contentHash: row.content_hash,
    });
    const finalStatus: CertifiedItem["validationStatus"] = assessment.score >= 70 ? "validated" : "pending";
    const reasons = finalStatus === "validated"
      ? assessment.reasons.filter((r) => r !== "awaiting independent validation" && r !== "not independently validated")
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
      [row.id, finalStatus, assessment.score, assessment.confidencePercent, assessment.tier, reasons],
    );
    await client.query(
      `INSERT INTO contributor_quality_events (research_item_id, contributor_agent_id, event_type, score, metadata)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        row.id,
        row.contributor_agent_id || null,
        finalStatus === "validated" ? "validated" : "assessed",
        assessment.score,
        { validatorAgentId: input.validatorAgentId, source: "request_validation", assessment },
      ],
    );
    out.push({
      id: row.id,
      validationStatus: finalStatus,
      confidencePercent: assessment.confidencePercent,
      trustTier: assessment.tier,
      reasons,
    });
  }
  return out;
}
