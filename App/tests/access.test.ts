import { describe, expect, it, vi } from "vitest";

import { getAccessContext, hashQuery, requestId } from "../lib/access";

// Minimal fake pg Client: dispatch by the SQL it sees so getAccessContext can be
// unit-tested without a real DB. `agentsRow` is what `SELECT status FROM agents`
// returns (null = no row).
function fakeClient(opts: { agentsRow?: { status: string } | null } = {}) {
  const calls: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });
    if (/FROM agent_identities/.test(sql)) return { rows: [], rowCount: 0 };
    if (/SELECT status FROM agents/.test(sql)) {
      const row = opts.agentsRow ?? null;
      return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
    }
    if (/INSERT INTO agents/.test(sql)) return { rows: [], rowCount: 1 };
    if (/FROM organization_agents/.test(sql)) return { rows: [], rowCount: 0 };
    return { rows: [], rowCount: 0 };
  });
  return { client: { query } as never, calls, query };
}

function req(headers: Record<string, string>) {
  return new Request("https://knowledge.perkos.xyz/skill/query", { headers });
}

describe("getAccessContext — consumer attribution", () => {
  it("self-registers an unknown agent as a consumer when a wallet is present, and keeps the id", async () => {
    const { client, query } = fakeClient({ agentsRow: null });
    const access = await getAccessContext(client, req({ "x-agent-id": "Aria", "x-agent-wallet": "0x" + "a".repeat(40) }));
    expect(access.agentId).toBe("Aria"); // captured, not dropped
    const insert = query.mock.calls.find((c) => /INSERT INTO agents/.test(c[0] as string));
    expect(insert).toBeTruthy(); // a consumer row was upserted
    expect((insert as unknown[])[1]).toEqual(["Aria", "0x" + "a".repeat(40)]);
  });

  it("treats an unknown agent with NO wallet as a public consumer (agentId null, no insert)", async () => {
    const { client, query } = fakeClient({ agentsRow: null });
    const access = await getAccessContext(client, req({ "x-agent-id": "Anon" }));
    expect(access.agentId).toBeNull();
    expect(query.mock.calls.some((c) => /INSERT INTO agents/.test(c[0] as string))).toBe(false);
  });

  it("keeps an already-active agent without inserting", async () => {
    const { client, query } = fakeClient({ agentsRow: { status: "active" } });
    const access = await getAccessContext(client, req({ "x-agent-id": "Known", "x-agent-wallet": "0x" + "b".repeat(40) }));
    expect(access.agentId).toBe("Known");
    expect(query.mock.calls.some((c) => /INSERT INTO agents/.test(c[0] as string))).toBe(false);
  });

  it("nulls out a disabled agent (never attributes to it)", async () => {
    const { client } = fakeClient({ agentsRow: { status: "disabled" } });
    const access = await getAccessContext(client, req({ "x-agent-id": "Banned", "x-agent-wallet": "0x" + "c".repeat(40) }));
    expect(access.agentId).toBeNull();
  });
});

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
