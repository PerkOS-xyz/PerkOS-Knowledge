import { describe, expect, it } from "vitest";

import {
  defaultTokenomics,
  feeWaterfall,
  priceForTier,
  rewardSplit,
  validateFees,
} from "../lib/tokenomics";

const cfg = defaultTokenomics();

describe("feeWaterfall", () => {
  it("splits 75/20/5 and sums back to the amount (no leak)", () => {
    const w = feeWaterfall(0.1, cfg);
    expect(w.platform).toBeCloseTo(0.02, 9);
    expect(w.reward).toBeCloseTo(0.005, 9);
    expect(w.provider).toBeCloseTo(0.075, 9);
    expect(w.provider + w.platform + w.reward).toBeCloseTo(0.1, 9);
  });
  it("honors a custom split and still sums to the amount", () => {
    const c2 = { ...cfg, feeProviderBps: 6000, feePlatformBps: 3000, feeRewardBps: 1000 };
    const w = feeWaterfall(1, c2);
    expect(w.provider).toBeCloseTo(0.6, 9);
    expect(w.platform).toBeCloseTo(0.3, 9);
    expect(w.reward).toBeCloseTo(0.1, 9);
    expect(w.provider + w.platform + w.reward).toBeCloseTo(1, 9);
  });
  it("zeros on a non-positive amount", () => {
    expect(feeWaterfall(0, cfg)).toEqual({ provider: 0, platform: 0, reward: 0 });
    expect(feeWaterfall(-1, cfg)).toEqual({ provider: 0, platform: 0, reward: 0 });
  });
});

describe("rewardSplit", () => {
  it("gives the researcher its configured share; sums to the reward", () => {
    const s = rewardSplit(0.005, cfg); // researcher 60%
    expect(s.researcher).toBeCloseTo(0.003, 9);
    expect(s.requester).toBeCloseTo(0.002, 9);
    expect(s.researcher + s.requester).toBeCloseTo(0.005, 9);
  });
  it("zeros on a non-positive reward", () => {
    expect(rewardSplit(0, cfg)).toEqual({ researcher: 0, requester: 0 });
  });
});

describe("validateFees", () => {
  it("accepts a split summing to 10000", () => {
    expect(validateFees(7500, 2000, 500)).toBeNull();
  });
  it("rejects a split that doesn't sum to 10000", () => {
    expect(validateFees(7000, 2000, 500)).toMatch(/sum/);
  });
  it("rejects out-of-range / non-integer shares", () => {
    expect(validateFees(-1, 10001, 0)).toBeTruthy();
    expect(validateFees(7500.5, 2000, 499.5)).toBeTruthy();
  });
});

describe("priceForTier / defaults", () => {
  it("returns the decided default ladder", () => {
    expect(priceForTier(cfg, "public")).toBe(0);
    expect(priceForTier(cfg, "private")).toBe(0.01);
    expect(priceForTier(cfg, "premium")).toBe(0.02);
    expect(priceForTier(cfg, "enterprise")).toBe(0.1);
  });
  it("default waterfall is a valid 75/20/5 split", () => {
    expect(validateFees(cfg.feeProviderBps, cfg.feePlatformBps, cfg.feeRewardBps)).toBeNull();
    expect(cfg.rewardResearcherBps).toBe(6000);
    expect(cfg.buybackEnabled).toBe(false);
  });
});
