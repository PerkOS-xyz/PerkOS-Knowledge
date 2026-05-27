import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getAllowedWallet,
  isAllowedWallet,
  normalizeWallet,
} from "../lib/auth";

const ENV_KEYS = ["KNOWLEDGE_ALLOWED_WALLET", "ALLOWED_WALLET"] as const;
const original: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const k of ENV_KEYS) original[k] = process.env[k];
});
afterEach(() => {
  for (const k of ENV_KEYS) {
    if (original[k] === undefined) delete process.env[k];
    else process.env[k] = original[k];
  }
});

describe("normalizeWallet", () => {
  it("trims and lowercases", () => {
    expect(normalizeWallet("  0xABCDef1234  ")).toBe("0xabcdef1234");
  });
  it("returns empty string for null/undefined/empty", () => {
    expect(normalizeWallet(null)).toBe("");
    expect(normalizeWallet(undefined)).toBe("");
    expect(normalizeWallet("")).toBe("");
    expect(normalizeWallet("   ")).toBe("");
  });
});

describe("getAllowedWallet", () => {
  it("reads KNOWLEDGE_ALLOWED_WALLET first", () => {
    process.env.KNOWLEDGE_ALLOWED_WALLET = "0xABCDef";
    process.env.ALLOWED_WALLET = "0xother";
    expect(getAllowedWallet()).toBe("0xabcdef");
  });
  it("falls back to ALLOWED_WALLET", () => {
    delete process.env.KNOWLEDGE_ALLOWED_WALLET;
    process.env.ALLOWED_WALLET = "0xBackup";
    expect(getAllowedWallet()).toBe("0xbackup");
  });
  it("returns empty when neither set", () => {
    delete process.env.KNOWLEDGE_ALLOWED_WALLET;
    delete process.env.ALLOWED_WALLET;
    expect(getAllowedWallet()).toBe("");
  });
});

describe("isAllowedWallet", () => {
  beforeEach(() => {
    process.env.KNOWLEDGE_ALLOWED_WALLET = "0xadmin";
  });
  it("matches case-insensitively", () => {
    expect(isAllowedWallet("0xADMIN")).toBe(true);
    expect(isAllowedWallet("0xadmin")).toBe(true);
  });
  it("rejects non-matching wallets", () => {
    expect(isAllowedWallet("0xother")).toBe(false);
  });
  it("rejects falsy input", () => {
    expect(isAllowedWallet(null)).toBe(false);
    expect(isAllowedWallet(undefined)).toBe(false);
    expect(isAllowedWallet("")).toBe(false);
  });
  it("when allowed-wallet env is empty, NO wallet is allowed (fail-closed)", () => {
    delete process.env.KNOWLEDGE_ALLOWED_WALLET;
    delete process.env.ALLOWED_WALLET;
    expect(isAllowedWallet("0xadmin")).toBe(false);
    expect(isAllowedWallet("0xanyone")).toBe(false);
  });
});
