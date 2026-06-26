import { describe, expect, it } from "vitest";

import {
  NETWORKS,
  buildPaymentRequirements,
  decodePaymentHeader,
  isPayNetwork,
  networkKeyFor,
  usdcBaseUnits,
} from "../lib/payments";

const CELO_USDC = "0xceba9300f2b948710d2653dd7b07f33a8b32118c";

describe("networks", () => {
  it("base + celo USDC (6-dec) configured", () => {
    expect(NETWORKS.base.usdc.toLowerCase()).toBe("0x833589fcd6edb6e08f4c7c32d4f71b54bda02913");
    expect(NETWORKS.base.chainId).toBe(8453);
    expect(NETWORKS.celo.usdc.toLowerCase()).toBe(CELO_USDC);
    expect(NETWORKS.celo.chainId).toBe(42220);
    expect(NETWORKS.celo.decimals).toBe(6);
  });
  it("isPayNetwork / networkKeyFor by name or chainId", () => {
    expect(isPayNetwork("base")).toBe(true);
    expect(isPayNetwork("celo")).toBe(true);
    expect(isPayNetwork("polygon")).toBe(false);
    expect(networkKeyFor("celo")).toBe("celo");
    expect(networkKeyFor("8453")).toBe("base");
    expect(networkKeyFor(42220)).toBe("celo");
    expect(networkKeyFor("xrpl")).toBeNull();
  });
});

describe("usdcBaseUnits", () => {
  it("6-dec conversion", () => {
    expect(usdcBaseUnits(1, "base")).toBe("1000000");
    expect(usdcBaseUnits(1.5, "celo")).toBe("1500000");
    expect(usdcBaseUnits(0.01, "base")).toBe("10000");
    expect(usdcBaseUnits(0, "base")).toBe("0");
    expect(usdcBaseUnits(-3, "celo")).toBe("0");
  });
});

describe("buildPaymentRequirements", () => {
  it("exact scheme + correct asset/network/amount/payTo", () => {
    process.env.KNOWLEDGE_X402_PAY_TO = "0x3f0D7b9916212fA0A9Ac0EF8f72a25EB56F7046C";
    const r = buildPaymentRequirements("celo", 2, "https://x/api/deposit");
    expect(r.scheme).toBe("exact");
    expect(r.network).toBe("celo");
    expect(r.asset.toLowerCase()).toBe(CELO_USDC);
    expect(r.maxAmountRequired).toBe("2000000");
    expect(r.payTo).toBe("0x3f0D7b9916212fA0A9Ac0EF8f72a25EB56F7046C");
    // Celo USDC's on-chain EIP-712 domain name is "USDC" (not "USD Coin").
    expect(r.extra).toEqual({ name: "USDC", version: "2" });
  });

  it("uses each token's real EIP-712 domain name (Base = USD Coin)", () => {
    process.env.KNOWLEDGE_X402_PAY_TO = "0x3f0D7b9916212fA0A9Ac0EF8f72a25EB56F7046C";
    const base = buildPaymentRequirements("base", 1, "https://x/api/deposit");
    expect(base.extra).toEqual({ name: "USD Coin", version: "2" });
  });
});

describe("decodePaymentHeader", () => {
  it("decodes base64 JSON", () => {
    const obj = { network: "base", scheme: "exact", payload: { x: 1 } };
    const b64 = Buffer.from(JSON.stringify(obj)).toString("base64");
    expect(decodePaymentHeader(b64)).toEqual(obj);
  });
  it("null on empty / undecodable", () => {
    expect(decodePaymentHeader(null)).toBeNull();
    expect(decodePaymentHeader("")).toBeNull();
    expect(decodePaymentHeader("§§§ not json §§§")).toBeNull();
  });
});
