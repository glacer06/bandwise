// Named errors for what leaves withTenant, withUser and withNoTenant, so a server log line says
// which part of the database failed. On 2026-10-05 two hosted runs logged only "Error": the pool
// could not open a connection because Supavisor refused the app role's password, and
// node-postgres reports that as a plain Error. Messages here stay generic; the driver error is
// kept as `cause` and never logged (core's errorType prints names and codes only).

import { DrizzleQueryError } from "drizzle-orm";

/** Why the pool could not hand out a working connection. A closed set, so it is safe to log. */
export type DbConnectionFailure = "auth_failed" | "too_many_connections" | "timeout" | "network" | "unknown";

/**
 * The transaction never started: the pool could not connect, or BEGIN failed on the connection it
 * handed out. Nothing ran, so nothing needs undoing.
 */
export class DbConnectionError extends Error {
  override readonly name = "DbConnectionError";
  readonly code: DbConnectionFailure;

  constructor(code: DbConnectionFailure, options: { cause: unknown }) {
    super(`The database connection failed: ${code}.`, options);
    this.code = code;
  }
}

/** A repository invariant broke, for example an insert that returned no row. */
export class DbInvariantError extends Error {
  override readonly name = "DbInvariantError";
}

const NETWORK_CODES: ReadonlySet<string> = new Set(["ECONNREFUSED", "ECONNRESET", "ENOTFOUND", "EAI_AGAIN", "EPIPE", "EHOSTUNREACH", "ENETUNREACH"]);

/**
 * Sorts a connect failure into DbConnectionFailure. It reads codes and messages of the error and
 * its causes to decide, and copies neither.
 *
 * - auth_failed: SQLSTATE 28P01 or 28000, or any SASL error from node-postgres. Supavisor answers a
 *   wrong password with a SCRAM `e=` reply, which node-postgres throws as a plain
 *   `Error("SASL: SCRAM-SERVER-FINAL-MESSAGE: server returned error ...")`, not a DatabaseError.
 * - too_many_connections: SQLSTATE 53300, or the pooler's client limit.
 * - timeout: ETIMEDOUT, or a connect or read timeout.
 * - network: refused, reset, unreachable or closed sockets.
 */
export function connectionFailure(e: unknown): DbConnectionFailure {
  let current: unknown = e;
  for (let depth = 0; current instanceof Error && depth < 4; depth += 1) {
    const code = (current as { code?: unknown }).code;
    const message = current.message;
    if (code === "28P01" || code === "28000" || message.startsWith("SASL:")) return "auth_failed";
    if (code === "53300" || /max client connections|too many (clients|connections)/i.test(message)) return "too_many_connections";
    if (code === "ETIMEDOUT" || /timeout/i.test(message)) return "timeout";
    if ((typeof code === "string" && NETWORK_CODES.has(code)) || /connection terminated|not queryable/i.test(message)) return "network";
    current = current.cause;
  }
  return "unknown";
}

/**
 * Drizzle 0.45 wraps every failed query in DrizzleQueryError and never sets its name, so it logs as
 * "Error". This names it in place and keeps the error itself, with its message and cause, for the
 * callers that read the Postgres error behind it.
 */
export function nameDriverError(e: unknown): unknown {
  if (e instanceof DrizzleQueryError && e.name === "Error") e.name = "DrizzleQueryError";
  return e;
}
