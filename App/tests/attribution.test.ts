import { describe, expect, it } from "vitest";

import { splitAmount } from "../lib/attribution";

describe("splitAmount", () => {
  it("splits equally across N items", () => {
    expect(splitAmount(1, 4)).toBe(0.25);
    expect(splitAmount(1, 1)).toBe(1);
    expect(splitAmount(0.1, 2)).toBeCloseTo(0.05, 12);
  });

  it("shares sum back to the original amount (no value lost)", () => {
    const amount = 0.3;
    const count = 7;
    const share = splitAmount(amount, count);
    expect(share * count).toBeCloseTo(amount, 12);
  });

  it("returns 0 for a non-positive amount", () => {
    expect(splitAmount(0, 5)).toBe(0);
    expect(splitAmount(-1, 5)).toBe(0);
  });

  it("returns 0 for a non-positive count (no division by zero)", () => {
    expect(splitAmount(1, 0)).toBe(0);
    expect(splitAmount(1, -3)).toBe(0);
  });

  it("returns 0 for non-finite input", () => {
    expect(splitAmount(Number.NaN, 4)).toBe(0);
    expect(splitAmount(Number.POSITIVE_INFINITY, 4)).toBe(0);
  });
});
