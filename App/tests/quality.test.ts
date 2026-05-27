import { describe, expect, it } from "vitest";

import {
  assessKnowledgeQuality,
  normalizeEvidence,
  shouldRejectIngest,
} from "../lib/quality";

describe("normalizeEvidence", () => {
  it("returns empty array for nullish/empty/non-array input", () => {
    expect(normalizeEvidence(undefined)).toEqual([]);
    expect(normalizeEvidence(null)).toEqual([]);
    expect(normalizeEvidence("string")).toEqual([]);
    expect(normalizeEvidence({})).toEqual([]);
    expect(normalizeEvidence([])).toEqual([]);
  });
  it("normalizes URL or URI field to url", () => {
    const out = normalizeEvidence([
      { type: "url", uri: "https://example.com/x" },
      { type: "url", url: "https://example.com/y" },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0]?.url).toBe("https://example.com/x");
    expect(out[1]?.url).toBe("https://example.com/y");
  });
  it("preserves type, url, hash, note, verified", () => {
    const out = normalizeEvidence([
      {
        type: "explorer",
        url: "https://basescan.org/tx/0xabc",
        hash: "0xabc",
        note: "tx receipt",
        verified: true,
      },
    ]);
    expect(out[0]).toMatchObject({
      type: "explorer",
      url: "https://basescan.org/tx/0xabc",
      hash: "0xabc",
      note: "tx receipt",
      verified: true,
    });
  });
  it("folds `source` into `note` when note is empty (source is not preserved as its own field)", () => {
    const out = normalizeEvidence([
      { type: "url", url: "https://x.test", source: "manual" },
    ]);
    expect(out[0]?.note).toBe("manual");
  });
  it("verified must be exactly `true` (truthy is not enough)", () => {
    const out = normalizeEvidence([
      { type: "url", url: "https://x.test", verified: 1 },
      { type: "url", url: "https://y.test", verified: "yes" },
      { type: "url", url: "https://z.test", verified: true },
    ]);
    expect(out[0]?.verified).toBe(false);
    expect(out[1]?.verified).toBe(false);
    expect(out[2]?.verified).toBe(true);
  });
  it("normalizes type to lowercase + slug", () => {
    const out = normalizeEvidence([
      { type: "Official Doc!!!", url: "https://x.test" },
    ]);
    expect(out[0]?.type).toBe("official_doc_");
  });
  it("caps to max entries (default 25)", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({
      type: "note",
      note: `n${i}`,
    }));
    expect(normalizeEvidence(many)).toHaveLength(25);
    expect(normalizeEvidence(many, 5)).toHaveLength(5);
  });
});

describe("assessKnowledgeQuality", () => {
  it("untrusted when nothing provided", () => {
    const a = assessKnowledgeQuality({});
    expect(a.tier).toBe("untrusted");
    expect(a.status).toBe("pending");
    expect(a.reasons).toContain("title too short");
    expect(a.reasons).toContain("summary/content too thin");
    expect(a.reasons).toContain("missing registered contributor");
    expect(a.reasons).toContain("no evidence attached");
  });

  it("reaches high tier with title + summary + contributor + content hash + 3 primary evidence + validated", () => {
    const a = assessKnowledgeQuality({
      title: "ERC-8004 agent identity on Base — overview",
      summary:
        "ERC-8004 standardizes agent identity verification on Base via on-chain registration with optional ENS binding. " +
          "Specifies signing keys, rotation, recovery, and revocation. Includes reference contracts and example flows. " +
          "Validators verify on-chain state matches the off-chain claims agents send to PerkOS Knowledge.",
      contributorAgentId: "agent-researcher-1",
      contentHash:
        "0xdeadbeef00112233445566778899aabbccddeeff00112233445566778899aabb",
      validationStatus: "validated",
      confidence: "high",
      evidence: [
        { type: "url", url: "https://eips.ethereum.org/EIPS/eip-8004", verified: true },
        { type: "contract", url: "https://basescan.org/address/0x...", verified: true },
        { type: "official_doc", url: "https://docs.base.org/erc8004", verified: true },
      ],
    });
    expect(a.tier).toBe("high");
    expect(a.score).toBeGreaterThanOrEqual(85);
    expect(a.status).toBe("validated");
    expect(a.evidenceCount).toBe(3);
    expect(a.primaryEvidenceCount).toBe(3);
    expect(a.verifiedEvidenceCount).toBe(3);
  });

  it("rejected → status='rejected' AND score clamped to ≤25", () => {
    const a = assessKnowledgeQuality({
      title: "Suspicious unverified claim about a token",
      summary: "Some claim with no evidence backing.",
      validationStatus: "rejected",
      confidence: "low",
    });
    expect(a.status).toBe("rejected");
    expect(a.score).toBeLessThanOrEqual(25);
  });

  it("confidence='low' drops score by 8", () => {
    const baseInput = {
      title: "A reasonable title here",
      summary:
        "Some summary text with enough length to qualify for the 18-point bucket of the summary scoring rule.",
      contributorAgentId: "agent-1",
      contentHash: "abc",
    };
    const noConfidence = assessKnowledgeQuality(baseInput);
    const low = assessKnowledgeQuality({ ...baseInput, confidence: "low" });
    expect(low.score).toBe(Math.max(0, noConfidence.score - 8));
  });

  it("score is clamped to [0, 100]", () => {
    const a = assessKnowledgeQuality({
      validationStatus: "validated",
      title: "Long title with enough content to count",
      summary:
        "Very long summary content here ".repeat(50) +
          "designed to maximize all scoring buckets",
      contributorAgentId: "agent-1",
      contentHash: "abc",
      confidence: "high",
      evidence: Array.from({ length: 10 }, () => ({
        type: "official_doc",
        url: "https://example.com",
        verified: true,
      })),
    });
    expect(a.score).toBeLessThanOrEqual(100);
    expect(a.score).toBeGreaterThanOrEqual(0);
  });
});

describe("shouldRejectIngest (returns reason-string or null, NOT bool)", () => {
  it("'evidence_required' when requireEvidence=true AND evidenceCount=0", () => {
    const a = assessKnowledgeQuality({ title: "Short", summary: "Short summary" });
    expect(
      shouldRejectIngest(a, { requireEvidence: true, allowPending: true }),
    ).toBe("evidence_required");
  });
  it("'quality_score_below_enterprise_threshold' when allowPending=false AND score<70", () => {
    const a = assessKnowledgeQuality({
      title: "Has a reasonable title here",
      summary:
        "Has a reasonable summary that's long enough to score, with enough text to qualify",
      contributorAgentId: "agent-1",
      contentHash: "abc",
      evidence: [{ type: "url", url: "https://example.com" }],
    });
    expect(a.status).toBe("pending");
    expect(a.score).toBeLessThan(70);
    expect(
      shouldRejectIngest(a, { requireEvidence: true, allowPending: false }),
    ).toBe("quality_score_below_enterprise_threshold");
  });
  it("null (accept) when allowPending=true AND evidence is present", () => {
    const a = assessKnowledgeQuality({
      title: "Has a reasonable title here",
      summary:
        "Has a reasonable summary that's long enough to score, with enough text to qualify",
      contributorAgentId: "agent-1",
      contentHash: "abc",
      evidence: [{ type: "url", url: "https://example.com" }],
    });
    expect(
      shouldRejectIngest(a, { requireEvidence: true, allowPending: true }),
    ).toBeNull();
  });
  it("DOCUMENTED GAP: 'rejected' validation status is NOT auto-rejected by this guard", () => {
    // The guard checks evidenceCount + score < 70 only. A
    // validationStatus='rejected' assessment still flows through —
    // upstream caller must check `assessment.status === 'rejected'`
    // separately. Worth surfacing as a finding when we tighten this.
    const a = assessKnowledgeQuality({
      validationStatus: "rejected",
      title: "Bad claim with required evidence backing somehow",
      contributorAgentId: "agent-1",
      contentHash: "abc",
      evidence: [{ type: "url", url: "https://example.com" }],
    });
    expect(a.status).toBe("rejected");
    // allowPending=true + evidence present + score capped at 25.
    // Guard returns 'quality_score_below_enterprise_threshold' when
    // allowPending=false, but NOT when allowPending=true. Document.
    expect(
      shouldRejectIngest(a, { requireEvidence: true, allowPending: true }),
    ).toBeNull();
  });
});
