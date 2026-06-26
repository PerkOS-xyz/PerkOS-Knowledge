/**
 * System error log — a lightweight, best-effort capture of server-side failures
 * (deposit/settle, query billing, claim build, …) so ops can see what's breaking
 * from the admin instead of tailing container logs over SSH.
 *
 * `logError` NEVER throws — a logging failure must not mask or escalate the
 * original error. Context is JSON-stringified and size-capped; redact secrets
 * before passing them in (this table is readable from the admin).
 */
import type { Client } from "pg";

export type ErrorSeverity = "error" | "warn" | "info";

export async function logError(
  client: Client,
  input: { scope: string; message: string; context?: unknown; severity?: ErrorSeverity },
): Promise<void> {
  try {
    const ctx = input.context === undefined ? null : JSON.stringify(input.context).slice(0, 12000);
    await client.query(
      `INSERT INTO system_errors (scope, severity, message, context) VALUES ($1, $2, $3, $4::jsonb)`,
      [input.scope.slice(0, 120), input.severity ?? "error", String(input.message).slice(0, 2000), ctx],
    );
  } catch {
    /* logging is best-effort — never throw */
  }
}

export type SystemError = {
  id: string;
  createdAt: string | null;
  scope: string;
  severity: string;
  message: string;
  context: unknown;
};

export async function recentErrors(
  client: Client,
  opts: { limit?: number; scope?: string } = {},
): Promise<SystemError[]> {
  const limit = Math.max(1, Math.min(opts.limit ?? 100, 500));
  const params: unknown[] = [];
  let where = "";
  if (opts.scope) {
    params.push(opts.scope);
    where = `WHERE scope = $${params.length}`;
  }
  params.push(limit);
  const r = await client.query(
    `SELECT id, created_at, scope, severity, message, context
       FROM system_errors ${where} ORDER BY created_at DESC LIMIT $${params.length}`,
    params,
  );
  return r.rows.map((row) => ({
    id: String(row.id),
    createdAt: row.created_at ?? null,
    scope: row.scope,
    severity: row.severity,
    message: row.message,
    context: row.context ?? null,
  }));
}
