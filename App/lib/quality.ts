export type EvidenceInput = {
  type?: unknown;
  url?: unknown;
  uri?: unknown;
  path?: unknown;
  hash?: unknown;
  note?: unknown;
  source?: unknown;
  retrievedAt?: unknown;
  verified?: unknown;
};

export type QualityAssessment = {
  status: 'validated' | 'pending' | 'rejected';
  score: number;
  confidencePercent: number;
  tier: 'high' | 'medium' | 'low' | 'untrusted';
  reasons: string[];
  evidenceCount: number;
  verifiedEvidenceCount: number;
  primaryEvidenceCount: number;
};

const PRIMARY_TYPES = new Set(['url', 'api', 'rpc', 'explorer', 'transaction', 'tx', 'contract', 'official_doc', 'file', 'dataset']);
const WEAK_TYPES = new Set(['note', 'llm', 'summary', 'claim']);

function text(value: unknown) {
  return String(value || '').trim();
}

function clamp(value: number, min = 0, max = 100) {
  return Math.max(min, Math.min(max, Math.round(value)));
}

export function normalizeEvidence(value: unknown, max = 25) {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (entry && typeof entry === 'object' ? entry as EvidenceInput : { note: String(entry || '') }))
    .map((entry) => {
      const type = text(entry.type || 'note').toLowerCase().replace(/[^a-z0-9:_-]+/g, '_') || 'note';
      const url = text(entry.url || entry.uri);
      const path = text(entry.path);
      const hash = text(entry.hash);
      const note = text(entry.note || entry.source);
      const retrievedAt = text(entry.retrievedAt);
      const verified = entry.verified === true;
      return { type, url, path, hash, note, retrievedAt, verified };
    })
    .filter((entry) => entry.url || entry.path || entry.hash || entry.note)
    .slice(0, max);
}

export function assessKnowledgeQuality(input: {
  title?: unknown;
  summary?: unknown;
  content?: unknown;
  confidence?: unknown;
  evidence?: unknown;
  validationStatus?: unknown;
  contributorAgentId?: unknown;
  contentHash?: unknown;
}): QualityAssessment {
  const evidence = normalizeEvidence(input.evidence);
  const title = text(input.title);
  const summary = text(input.summary || input.content);
  const status = text(input.validationStatus).toLowerCase();
  const contributor = text(input.contributorAgentId);
  const contentHash = text(input.contentHash);
  const confidenceText = text(input.confidence).toLowerCase();
  const reasons: string[] = [];
  let score = 0;

  if (title.length >= 8) score += 8;
  else reasons.push('title too short');

  if (summary.length >= 120) score += 18;
  else if (summary.length >= 40) score += 10;
  else reasons.push('summary/content too thin');

  if (contributor) score += 10;
  else reasons.push('missing registered contributor');

  if (contentHash) score += 8;
  else reasons.push('missing content hash');

  const evidenceCount = evidence.length;
  const verifiedEvidenceCount = evidence.filter((entry) => entry.verified).length;
  const primaryEvidenceCount = evidence.filter((entry) => PRIMARY_TYPES.has(entry.type) && !WEAK_TYPES.has(entry.type)).length;
  const urlEvidenceCount = evidence.filter((entry) => entry.url && /^https?:\/\//i.test(entry.url)).length;
  const fileEvidenceCount = evidence.filter((entry) => entry.path).length;

  if (evidenceCount === 0) {
    reasons.push('no evidence attached');
  } else {
    score += Math.min(28, evidenceCount * 7);
    if (primaryEvidenceCount > 0) score += Math.min(16, primaryEvidenceCount * 8);
    else reasons.push('no primary evidence');
    if (verifiedEvidenceCount > 0) score += Math.min(12, verifiedEvidenceCount * 6);
    if (urlEvidenceCount + fileEvidenceCount >= 2) score += 6;
  }

  if (confidenceText === 'high') score += 8;
  if (confidenceText === 'low') score -= 8;

  if (status === 'validated') score += 14;
  if (status === 'rejected') score = Math.min(score, 25);
  if (status === 'unvalidated') reasons.push('not independently validated');
  if (status === 'pending' && evidenceCount > 0) reasons.push('awaiting independent validation');

  score = clamp(score);
  const derivedStatus: QualityAssessment['status'] = status === 'rejected'
    ? 'rejected'
    : status === 'validated' && score >= 70
      ? 'validated'
      : 'pending';
  const tier: QualityAssessment['tier'] = score >= 85 ? 'high' : score >= 70 ? 'medium' : score >= 45 ? 'low' : 'untrusted';

  return {
    status: derivedStatus,
    score,
    confidencePercent: score,
    tier,
    reasons,
    evidenceCount,
    verifiedEvidenceCount,
    primaryEvidenceCount,
  };
}

export function shouldRejectIngest(assessment: QualityAssessment, options: { requireEvidence: boolean; allowPending: boolean }) {
  if (options.requireEvidence && assessment.evidenceCount === 0) return 'evidence_required';
  if (!options.allowPending && assessment.score < 70) return 'quality_score_below_enterprise_threshold';
  return null;
}
