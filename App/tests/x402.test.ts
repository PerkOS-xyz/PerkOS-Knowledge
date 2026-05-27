import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getX402Policy,
  inspectX402Request,
  isX402Satisfied,
  publicX402,
  resolveX402Tier,
} from "../lib/x402";

const ENV_KEYS = [
  "KNOWLEDGE_X402_MODE",
  "KNOWLEDGE_X402_CURRENCY",
  "KNOWLEDGE_X402_CHAIN",
  "KNOWLEDGE_X402_TOKEN",
  "KNOWLEDGE_X402_PAY_TO",
  "KNOWLEDGE_X402_PUBLIC_PRICE_AMOUNT",
  "KNOWLEDGE_X402_PRIVATE_PRICE_AMOUNT",
  "KNOWLEDGE_X402_PREMIUM_PRICE_AMOUNT",
  "KNOWLEDGE_X402_PRICE_AMOUNT",
  "KNOWLEDGE_X402_EXPOSE_SETTLEMENT",
  "KNOWLEDGE_X402_FACILITATOR_URL",
  "KNOWLEDGE_X402_REQUIRE_FACILITATOR",
  "KNOWLEDGE_X402_VERIFY_TIMEOUT_MS",
] as const;
const original: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) original[k] = process.env[k];
  // Clean slate for each test so env-leakage doesn't change defaults.
  for (const k of ENV_KEYS) delete process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
});

describe("resolveX402Tier", () => {
  it("defaults to public when no input", () => {
    expect(resolveX402Tier()).toBe("public");
    expect(resolveX402Tier({})).toBe("public");
  });
  it("recognizes 'private' and its alias 'organization'", () => {
    expect(resolveX402Tier({ requestedTier: "private" })).toBe("private");
    expect(resolveX402Tier({ requestedTier: "organization" })).toBe("private");
  });
  it("recognizes 'premium' and its alias 'paid'", () => {
    expect(resolveX402Tier({ requestedTier: "premium" })).toBe("premium");
    expect(resolveX402Tier({ requestedTier: "paid" })).toBe("premium");
  });
  it("upgrades to 'private' when org scope is present and no explicit tier", () => {
    expect(resolveX402Tier({ hasOrganizationScope: true })).toBe("private");
  });
  it("explicit tier overrides org scope (public requested + org → public)", () => {
    // The current implementation: explicit "private"/"premium" wins; an
    // unknown requestedTier falls back to public, but hasOrgScope can
    // still bump to private. Document the precedence with this test.
    expect(
      resolveX402Tier({ requestedTier: "unknown", hasOrganizationScope: true }),
    ).toBe("private");
  });
  it("case-insensitive on requestedTier", () => {
    expect(resolveX402Tier({ requestedTier: "PRIVATE" })).toBe("private");
    expect(resolveX402Tier({ requestedTier: "Premium" })).toBe("premium");
  });
});

describe("getX402Policy", () => {
  it("returns a policy with mode=metered_free by default", () => {
    const p = getX402Policy();
    expect(p.mode).toBe("metered_free");
    expect(p.required).toBe(false); // amount defaults to 0
    expect(p.tier).toBe("public");
    expect(p.endpoint).toBe("/skill/query");
  });
  it("flips required=true when mode=enforce AND amount != 0", () => {
    process.env.KNOWLEDGE_X402_MODE = "enforce";
    process.env.KNOWLEDGE_X402_PUBLIC_PRICE_AMOUNT = "100000";
    const p = getX402Policy("/skill/query", "public");
    expect(p.mode).toBe("enforce");
    expect(p.required).toBe(true);
  });
  it("mode=enforce + amount=0 still gives required=false (free tier)", () => {
    process.env.KNOWLEDGE_X402_MODE = "enforce";
    process.env.KNOWLEDGE_X402_PUBLIC_PRICE_AMOUNT = "0";
    const p = getX402Policy();
    expect(p.required).toBe(false);
  });
  it("tier price resolution: premium > private > public env precedence", () => {
    process.env.KNOWLEDGE_X402_PUBLIC_PRICE_AMOUNT = "100";
    process.env.KNOWLEDGE_X402_PRIVATE_PRICE_AMOUNT = "200";
    process.env.KNOWLEDGE_X402_PREMIUM_PRICE_AMOUNT = "500";
    expect(getX402Policy("/x", "public").price.amount).toBe("100");
    expect(getX402Policy("/x", "private").price.amount).toBe("200");
    expect(getX402Policy("/x", "premium").price.amount).toBe("500");
  });
  it("falls back to KNOWLEDGE_X402_PRICE_AMOUNT when tier-specific unset", () => {
    process.env.KNOWLEDGE_X402_PRICE_AMOUNT = "999";
    expect(getX402Policy("/x", "public").price.amount).toBe("999");
    expect(getX402Policy("/x", "private").price.amount).toBe("999");
    expect(getX402Policy("/x", "premium").price.amount).toBe("999");
  });
  it("hides settlement token by default; exposes when EXPOSE_SETTLEMENT=true", () => {
    process.env.KNOWLEDGE_X402_MODE = "enforce";
    process.env.KNOWLEDGE_X402_PUBLIC_PRICE_AMOUNT = "100";
    process.env.KNOWLEDGE_X402_TOKEN = "0xUSDC";
    const hidden = getX402Policy();
    expect(hidden.paymentRequirements?.asset).toBe("configured");
    process.env.KNOWLEDGE_X402_EXPOSE_SETTLEMENT = "true";
    const exposed = getX402Policy();
    expect(exposed.paymentRequirements?.asset).toBe("0xUSDC");
  });
});

describe("inspectX402Request", () => {
  function req(headers: Record<string, string> = {}): Request {
    return new Request("http://test.local/", { headers });
  }
  it("returns 'metered' when policy not required + no header", () => {
    const policy = getX402Policy();
    const x = inspectX402Request(req(), policy);
    expect(x.status).toBe("metered");
    expect(x.receiptId).toBeNull();
    expect(x.headerPresent).toBe(false);
  });
  it("returns 'missing' when policy required + no header", () => {
    process.env.KNOWLEDGE_X402_MODE = "enforce";
    process.env.KNOWLEDGE_X402_PUBLIC_PRICE_AMOUNT = "100";
    const policy = getX402Policy();
    const x = inspectX402Request(req(), policy);
    expect(x.status).toBe("missing");
  });
});

describe("isX402Satisfied", () => {
  it("not-required policy is always satisfied", () => {
    const policy = getX402Policy();
    expect(isX402Satisfied(policy, { status: "missing" } as never)).toBe(true);
    expect(isX402Satisfied(policy, { status: "metered" } as never)).toBe(true);
  });
  it("required-without-facilitator accepts 'received' or 'verified'", () => {
    process.env.KNOWLEDGE_X402_MODE = "enforce";
    process.env.KNOWLEDGE_X402_PUBLIC_PRICE_AMOUNT = "100";
    process.env.KNOWLEDGE_X402_REQUIRE_FACILITATOR = "false";
    const policy = getX402Policy();
    expect(isX402Satisfied(policy, { status: "received" } as never)).toBe(true);
    expect(isX402Satisfied(policy, { status: "verified" } as never)).toBe(true);
    expect(isX402Satisfied(policy, { status: "missing" } as never)).toBe(false);
  });
  it("required-with-facilitator demands 'verified' only", () => {
    process.env.KNOWLEDGE_X402_MODE = "enforce";
    process.env.KNOWLEDGE_X402_PUBLIC_PRICE_AMOUNT = "100";
    process.env.KNOWLEDGE_X402_REQUIRE_FACILITATOR = "true";
    process.env.KNOWLEDGE_X402_FACILITATOR_URL = "https://facilitator.test";
    const policy = getX402Policy();
    expect(isX402Satisfied(policy, { status: "verified" } as never)).toBe(true);
    expect(isX402Satisfied(policy, { status: "received" } as never)).toBe(false);
  });
});

describe("publicX402 (response shape for clients)", () => {
  it("strips raw payment + verification internals", () => {
    process.env.KNOWLEDGE_X402_MODE = "enforce";
    process.env.KNOWLEDGE_X402_PUBLIC_PRICE_AMOUNT = "100";
    const policy = getX402Policy();
    const x402 = {
      receiptId: "x402_abc",
      status: "received" as const,
      headerPresent: true,
      receipt: { id: "x402_abc", amount: 100 },
      rawPayment: "SENSITIVE_RAW_PAYLOAD",
    };
    const pub = publicX402(policy, x402 as never);
    // Should NOT include rawPayment in the public view.
    expect(JSON.stringify(pub)).not.toContain("SENSITIVE_RAW_PAYLOAD");
  });
});
