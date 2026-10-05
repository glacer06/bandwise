// The log label for an error nobody expected: its type and a safe code, then the same for each
// cause. Never the message. A database, env or provider message can quote state, SQL params or a
// secret, so a server log names what failed and leaves the detail on the error object.
//
//   DbConnectionError auth_failed < Error
//   DrizzleQueryError < DatabaseError 40P01
//   TokenPepperError
//
// It is only as good as the names it reads. Every error class in this repo sets `name` as a string
// literal, which survives minified server bundles where a constructor name does not.

/** How many errors of a cause chain to print. Longer chains, and cycles, stop here. */
const MAX_DEPTH = 4;
/** A name or code is printed only in these shapes, so neither can carry free text into a log. */
const SAFE_NAME = /^[A-Za-z][A-Za-z0-9_.]{0,59}$/;
const SAFE_CODE = /^[A-Za-z0-9_]{1,40}$/;

function label(e: Error): string {
  const fields = e as Error & { code?: unknown; severity?: unknown };
  // node-postgres names every server error "error" (pg-protocol's DatabaseError). Its code is the
  // SQLSTATE, which is safe to print.
  let name = e.name === "error" && typeof fields.severity === "string" ? "DatabaseError" : e.name;
  if (!SAFE_NAME.test(name)) name = "Error";
  return typeof fields.code === "string" && SAFE_CODE.test(fields.code) ? `${name} ${fields.code}` : name;
}

/** The type of `e` and of its causes, for a server log line. Never includes a message. */
export function errorType(e: unknown): string {
  if (!(e instanceof Error)) return "unknown error";
  const parts: string[] = [];
  let current: unknown = e;
  while (current instanceof Error && parts.length < MAX_DEPTH) {
    parts.push(label(current));
    current = current.cause;
  }
  return parts.join(" < ");
}
