import { describe, expect, it } from "vitest";

import { hashQuery, requestId } from "../lib/access";

describe("requestId", () => {
  it("returns kreq_<uuid>-shaped id", () => {
    const id = requestId();
    expect(id).toMatch(/^kreq_[0-9a-f-]{36}$/);
  });
  it("is unique across calls", () => {
    const ids = new Set(Array.from({ length: 100 }, () => requestId()));
    expect(ids.size).toBe(100);
  });
});

describe("hashQuery", () => {
  it("returns SHA256 hex for non-empty input", () => {
    const h = hashQuery("PerkOS knowledge");
    expect(h).toMatch(/^[a-f0-9]{64}$/);
  });
  it("returns null for empty/whitespace-only input", () => {
    expect(hashQuery("")).toBeNull();
    expect(hashQuery("   ")).toBeNull();
    expect(hashQuery("\t\n")).toBeNull();
  });
  it("normalizes whitespace boundaries (trim before hash)", () => {
    expect(hashQuery("  hello  ")).toBe(hashQuery("hello"));
  });
  it("is case-SENSITIVE — same content different case ≠ same hash", () => {
    // Document the behavior: hashQuery preserves case so an org's
    // sensitive query phrasing doesn't collide with a public one.
    expect(hashQuery("PerkOS")).not.toBe(hashQuery("perkos"));
  });
  it("produces different hashes for different content", () => {
    expect(hashQuery("a")).not.toBe(hashQuery("b"));
  });
});
