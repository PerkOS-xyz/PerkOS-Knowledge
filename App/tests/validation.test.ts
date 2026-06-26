import { describe, expect, it, vi } from "vitest";

import { assertValidatorIndependent, certifyResearchItems } from "../lib/validation";

describe("assertValidatorIndependent", () => {
  it("accepts a validator distinct from the fulfiller and contributors", () => {
    expect(
      assertValidatorIndependent({ validatorAgentId: "Vera", fulfilledByAgentId: "Pablo", contributorAgentIds: ["Pablo", "Carla"] }),
    ).toEqual({ ok: true });
  });

  it("rejects the fulfiller validating their own request (case-insensitive)", () => {
    const r = assertValidatorIndependent({ validatorAgentId: "Pablo", fulfilledByAgentId: "pablo" });
    expect(r).toEqual({ ok: false, reason: "validator_is_the_fulfiller" });
  });

  it("rejects a contributor of the items being certified", () => {
    const r = assertValidatorIndependent({ validatorAgentId: "Carla", fulfilledByAgentId: "Pablo", contributorAgentIds: ["Carla"] });
    expect(r).toEqual({ ok: false, reason: "validator_is_a_contributor" });
  });

  it("rejects an empty validator id", () => {
    expect(assertValidatorIndependent({ validatorAgentId: "  " }).ok).toBe(false);
  });

  it("tolerates null/undefined contributor entries", () => {
    expect(
      assertValidatorIndependent({ validatorAgentId: "Vera", fulfilledByAgentId: null, contributorAgentIds: [null, undefined, "Pablo"] }),
    ).toEqual({ ok: true });
  });
});

// Fake pg Client: serve the SELECT of items, capture UPDATE/INSERT.
function fakeClient(items: Array<Record<string, unknown>>) {
  const updates: unknown[][] = [];
  const events: unknown[][] = [];
  const query = vi.fn(async (sql: string, paramsArg: unknown[] = []) => {
    if (/SELECT id, title, summary/.test(sql)) return { rows: items, rowCount: items.length };
    if (/UPDATE research_items/.test(sql)) { updates.push(paramsArg); return { rows: [], rowCount: 1 }; }
    if (/INSERT INTO contributor_quality_events/.test(sql)) { events.push(paramsArg); return { rows: [], rowCount: 1 }; }
    return { rows: [], rowCount: 0 };
  });
  return { client: { query } as never, updates, events };
}

const strongItem = {
  id: "item-strong",
  title: "Base smart-wallet gas sponsorship",
  summary: "A".repeat(140), // >= 120 chars
  confidence: "high",
  evidence: [
    { type: "url", url: "https://docs.base.org/x", verified: true },
    { type: "url", url: "https://basescan.org/tx/0xabc" },
  ],
  validation_status: "pending",
  contributor_agent_id: "Pablo",
  content_hash: "deadbeef",
};

const weakItem = {
  id: "item-weak",
  title: "x", // too short
  summary: "thin", // too thin
  confidence: "low",
  evidence: [],
  validation_status: "pending",
  contributor_agent_id: null,
  content_hash: "",
};

describe("certifyResearchItems", () => {
  it("promotes an evidenced, well-formed item to validated", async () => {
    const { client, updates, events } = fakeClient([strongItem]);
    const out = await certifyResearchItems(client, { itemIds: ["item-strong"], validatorAgentId: "Vera" });
    expect(out[0].validationStatus).toBe("validated");
    expect(out[0].confidencePercent).toBeGreaterThanOrEqual(70);
    // the UPDATE wrote 'validated' and the event logged 'validated' by the validator
    expect(updates[0][1]).toBe("validated");
    expect(events[0][2]).toBe("validated");
    expect((events[0][4] as { validatorAgentId: string }).validatorAgentId).toBe("Vera");
    // the "not independently validated" reason is stripped once certified
    expect(out[0].reasons).not.toContain("not independently validated");
  });

  it("keeps a thin item pending (a thumbs-up can't launder it past the floor)", async () => {
    const { client, updates } = fakeClient([weakItem]);
    const out = await certifyResearchItems(client, { itemIds: ["item-weak"], validatorAgentId: "Vera" });
    expect(out[0].validationStatus).toBe("pending");
    expect(out[0].confidencePercent).toBeLessThan(70);
    expect(updates[0][1]).toBe("pending");
  });

  it("returns [] for no item ids", async () => {
    const { client } = fakeClient([]);
    expect(await certifyResearchItems(client, { itemIds: [], validatorAgentId: "Vera" })).toEqual([]);
  });
});
