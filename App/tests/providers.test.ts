import { describe, expect, it } from "vitest";

import {
  contributionId,
  defaultSanitizationStatus,
  defaultValidationStatus,
  getProviderIdentity,
  normalizeProviderVisibility,
  PROVIDER_SCOPES,
  publicationStatus,
  storedVisibility,
  textOrNull,
} from "../lib/providers";

describe("textOrNull", () => {
  it("returns trimmed string when non-empty", () => {
    expect(textOrNull("  hello  ")).toBe("hello");
  });
  it("returns null for nullish/empty/whitespace-only", () => {
    expect(textOrNull(null)).toBeNull();
    expect(textOrNull(undefined)).toBeNull();
    expect(textOrNull("")).toBeNull();
    expect(textOrNull("   ")).toBeNull();
  });
  it("coerces non-string input to string before testing", () => {
    expect(textOrNull(42)).toBe("42");
    expect(textOrNull(0)).toBeNull(); // `0` falsy → String(0||'')=''
  });
});

describe("normalizeProviderVisibility", () => {
  it("accepts the 3 documented inputs", () => {
    expect(normalizeProviderVisibility("public")).toBe("public");
    expect(normalizeProviderVisibility("private")).toBe("private");
    expect(normalizeProviderVisibility("public_candidate")).toBe("public_candidate");
  });
  it("defaults unknown/missing to 'private' (fail-closed for safety)", () => {
    expect(normalizeProviderVisibility(undefined)).toBe("private");
    expect(normalizeProviderVisibility(null)).toBe("private");
    expect(normalizeProviderVisibility("garbage")).toBe("private");
    expect(normalizeProviderVisibility(42)).toBe("private");
  });
});

describe("storedVisibility", () => {
  it("only 'public' is stored as public — public_candidate is stored as private until validated", () => {
    expect(storedVisibility("public")).toBe("public");
    expect(storedVisibility("public_candidate")).toBe("private");
    expect(storedVisibility("private")).toBe("private");
  });
});

describe("publicationStatus", () => {
  it("public_candidate requires review", () => {
    expect(publicationStatus("public_candidate")).toBe("review_required");
  });
  it("public is immediately published", () => {
    expect(publicationStatus("public")).toBe("published");
  });
  it("private stays private", () => {
    expect(publicationStatus("private")).toBe("private");
  });
});

describe("defaultSanitizationStatus", () => {
  it("public_candidate defaults to pending sanitization", () => {
    expect(defaultSanitizationStatus("public_candidate")).toBe("pending");
  });
  it("public defaults to sanitized", () => {
    expect(defaultSanitizationStatus("public")).toBe("sanitized");
  });
  it("private defaults to internal", () => {
    expect(defaultSanitizationStatus("private")).toBe("internal");
  });
  it("explicit override wins", () => {
    expect(defaultSanitizationStatus("public", "internal")).toBe("internal");
    expect(defaultSanitizationStatus("private", "sanitized")).toBe("sanitized");
  });
});

describe("defaultValidationStatus", () => {
  it("defaults to 'pending' (NOT 'unvalidated' — providers must opt in to validated)", () => {
    expect(defaultValidationStatus()).toBe("pending");
    expect(defaultValidationStatus(undefined)).toBe("pending");
    expect(defaultValidationStatus(null)).toBe("pending");
  });
  it("preserves explicit non-empty value", () => {
    expect(defaultValidationStatus("validated")).toBe("validated");
    expect(defaultValidationStatus("unvalidated")).toBe("unvalidated");
  });
});

describe("contributionId", () => {
  it("returns deterministic kitem_<hex> shaped id", () => {
    const a = contributionId("mysource", "org-1", "/path/to/doc");
    const b = contributionId("mysource", "org-1", "/path/to/doc");
    expect(a).toBe(b);
    expect(a).toMatch(/^kitem_[a-f0-9]+$/);
  });
  it("differs across (source, org, path) tuples", () => {
    const a = contributionId("s1", "o1", "/p");
    const b = contributionId("s2", "o1", "/p");
    const c = contributionId("s1", "o2", "/p");
    const d = contributionId("s1", "o1", "/p2");
    expect(new Set([a, b, c, d]).size).toBe(4);
  });
  it("treats null org id as 'public' bucket consistently", () => {
    const a = contributionId("s", null, "/p");
    const b = contributionId("s", null, "/p");
    expect(a).toBe(b);
  });
});

describe("PROVIDER_SCOPES", () => {
  it("declares the documented 5 scopes", () => {
    expect(PROVIDER_SCOPES).toEqual([
      "research:submit",
      "knowledge:contribute",
      "knowledge:private",
      "knowledge:public_candidate",
      "ingest",
    ]);
  });
});

describe("getProviderIdentity", () => {
  function req(headers: Record<string, string>): Request {
    return new Request("http://test.local/", { headers });
  }
  it("reads from headers", () => {
    const r = req({
      "x-agent-id": "agent-42",
      "x-organization-id": "org-1",
      "x-agent-wallet": "0xABCDEF",
      "x-agent-erc8004": "0x1234",
      "x-agent-chain": "base-sepolia",
    });
    const id = getProviderIdentity(r, {});
    expect(id.agentId).toBe("agent-42");
    expect(id.organizationId).toBe("org-1");
    // wallet is trimmed but NOT lowercased in providers (different
    // from auth.normalizeWallet — the doc field preserves the
    // original casing for explorer-deeplink fidelity).
    expect(id.wallet).toBe("0xABCDEF");
    expect(id.erc8004Identity).toBe("0x1234");
    expect(id.identityChain).toBe("base-sepolia");
  });
  it("falls back to body when headers absent (uses snake_case field names)", () => {
    const r = req({});
    const id = getProviderIdentity(r, {
      contributor_agent_id: "agent-from-body",
      organization_id: "org-body",
      contributor_wallet: "0xbody",
      contributor_erc8004_identity: "ercbody",
      identity_chain: "celo",
    });
    expect(id.agentId).toBe("agent-from-body");
    expect(id.organizationId).toBe("org-body");
    expect(id.wallet).toBe("0xbody");
    expect(id.erc8004Identity).toBe("ercbody");
    expect(id.identityChain).toBe("celo");
  });
  it("returns nulls for everything missing", () => {
    const id = getProviderIdentity(req({}), {});
    expect(id.agentId).toBeNull();
    expect(id.organizationId).toBeNull();
    expect(id.wallet).toBeNull();
    expect(id.erc8004Identity).toBeNull();
  });
});
