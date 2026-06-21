import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { exemptWallets } from "../lib/credits";
import { getX402Policy } from "../lib/x402";

describe("exemptWallets", () => {
  const KEY = "KNOWLEDGE_EXEMPT_WALLETS";
  let original: string | undefined;
  beforeEach(() => {
    original = process.env[KEY];
    delete process.env[KEY];
  });
  afterEach(() => {
    if (original === undefined) delete process.env[KEY];
    else process.env[KEY] = original;
  });

  it("is empty when unset", () => {
    expect(exemptWallets().size).toBe(0);
  });

  it("splits comma list, lowercases, trims, drops blanks", () => {
    process.env[KEY] = " 0xAbC , 0xDEF,, 0x123 ";
    const s = exemptWallets();
    expect([...s].sort()).toEqual(["0x123", "0xabc", "0xdef"]);
    expect(s.has("0xabc")).toBe(true);
    expect(s.has("0xAbC")).toBe(false); // membership is lowercase
  });
});

describe("getX402Policy mode", () => {
  const KEYS = [
    "KNOWLEDGE_X402_MODE",
    "KNOWLEDGE_X402_PUBLIC_PRICE_AMOUNT",
    "KNOWLEDGE_X402_PRICE_AMOUNT",
  ] as const;
  const orig: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const k of KEYS) {
      orig[k] = process.env[k];
      delete process.env[k];
    }
  });
  afterEach(() => {
    for (const k of KEYS) {
      if (orig[k] === undefined) delete process.env[k];
      else process.env[k] = orig[k];
    }
  });

  it("defaults to metered_free", () => {
    expect(getX402Policy().mode).toBe("metered_free");
  });

  it("recognizes the credit mode", () => {
    process.env.KNOWLEDGE_X402_MODE = "credit";
    const p = getX402Policy();
    expect(p.mode).toBe("credit");
    // credit mode does NOT use the facilitator path (debit is separate)
    expect(p.required).toBe(false);
  });

  it("enforce mode with a price marks required", () => {
    process.env.KNOWLEDGE_X402_MODE = "enforce";
    process.env.KNOWLEDGE_X402_PUBLIC_PRICE_AMOUNT = "0.01";
    expect(getX402Policy().mode).toBe("enforce");
    expect(getX402Policy().required).toBe(true);
  });
});
