import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { canSettleOnChain, computePayout } from "../lib/settlement";

describe("computePayout", () => {
  it("pays the full balance when no amount requested", () => {
    expect(computePayout(undefined, 0.5)).toBe(0.5);
  });
  it("caps the requested amount at the balance", () => {
    expect(computePayout(10, 0.5)).toBe(0.5);
    expect(computePayout(0.3, 0.5)).toBe(0.3);
  });
  it("returns 0 for a non-positive balance", () => {
    expect(computePayout(undefined, 0)).toBe(0);
    expect(computePayout(5, 0)).toBe(0);
    expect(computePayout(5, -1)).toBe(0);
  });
  it("returns 0 for a non-positive requested amount", () => {
    expect(computePayout(0, 1)).toBe(0);
    expect(computePayout(-2, 1)).toBe(0);
  });
});

describe("canSettleOnChain", () => {
  const KEYS = ["KNOWLEDGE_TREASURY_ADDRESS", "KNOWLEDGE_TREASURY_PRIVATE_KEY"] as const;
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

  it("false without a treasury key", () => {
    process.env.KNOWLEDGE_TREASURY_ADDRESS = "0x3f0D7b9916212fA0A9Ac0EF8f72a25EB56F7046C";
    expect(canSettleOnChain()).toBe(false);
  });
  it("false with a malformed key", () => {
    process.env.KNOWLEDGE_TREASURY_ADDRESS = "0x3f0D7b9916212fA0A9Ac0EF8f72a25EB56F7046C";
    process.env.KNOWLEDGE_TREASURY_PRIVATE_KEY = "not-a-key";
    expect(canSettleOnChain()).toBe(false);
  });
  it("true with address + a 32-byte hex key", () => {
    process.env.KNOWLEDGE_TREASURY_ADDRESS = "0x3f0D7b9916212fA0A9Ac0EF8f72a25EB56F7046C";
    process.env.KNOWLEDGE_TREASURY_PRIVATE_KEY = "0x" + "a".repeat(64);
    expect(canSettleOnChain()).toBe(true);
  });
});
