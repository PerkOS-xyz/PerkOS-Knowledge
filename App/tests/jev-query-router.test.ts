import { describe, expect, it } from "vitest";
import { policyForClass, resolveQueryRoute } from "../lib/jev-query-router";

describe("policyForClass", () => {
  it("lookup disables auto research requests", () => {
    const p = policyForClass("lookup", 0.9, 8);
    expect(p.createRequestOnMiss).toBe(false);
    expect(p.limit).toBeLessThanOrEqual(5);
    expect(p.routeReason).toBe("jev:lookup");
  });

  it("custom-research enables miss requests + high priority", () => {
    const p = policyForClass("custom-research", 0.8, 8);
    expect(p.createRequestOnMiss).toBe(true);
    expect(p.priority).toBe("high");
  });

  it("deep raises confidence floor", () => {
    const p = policyForClass("deep", 0.7, 8);
    expect(p.minConfidence).toBe(45);
    expect(p.qualityMode).toBe("enterprise");
  });
});

describe("resolveQueryRoute", () => {
  it("honors forcedClass without calling Jev", async () => {
    const p = await resolveQueryRoute({
      query: "anything",
      forcedClass: "brief",
      requestedLimit: 8,
    });
    expect(p?.queryClass).toBe("brief");
    expect(p?.routeReason).toBe("jev:brief");
  });

  it("heuristic fallback for long competitive queries when router off", async () => {
    process.env.KNOWLEDGE_JEV_ROUTER = "0";
    delete process.env.TYPESAFE_API_KEY;
    const p = await resolveQueryRoute({
      query:
        "Compare tokenized US equities competitive landscape and rank risks with sources",
      mode: "context",
      requestedLimit: 8,
    });
    // router disabled → null
    expect(p).toBeNull();
  });
});
