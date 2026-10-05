import { describe, expect, it } from "vitest";

import { errorType } from "./error-type.js";

class Named extends Error {
  override readonly name = "Named";
}

describe("errorType", () => {
  it("prints the name, never the message", () => {
    expect(errorType(new Named("password hunter2 for user bandwise_console"))).toBe("Named");
    expect(errorType(new TypeError("state text"))).toBe("TypeError");
  });

  it("follows the cause chain and prints safe codes", () => {
    // The 2026-10-05 shape: a connection error over node-postgres' plain SASL Error.
    const sasl = new Error('SASL: SCRAM-SERVER-FINAL-MESSAGE: server returned error: "password authentication failed"');
    const top = Object.assign(new Error("The database connection failed: auth_failed.", { cause: sasl }), { name: "DbConnectionError", code: "auth_failed" });
    expect(errorType(top)).toBe("DbConnectionError auth_failed < Error");

    const reset = Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" });
    expect(errorType(new Error("Failed query: begin", { cause: reset }))).toBe("Error < Error ECONNRESET");
  });

  it("names node-postgres server errors DatabaseError with their SQLSTATE", () => {
    const pg = Object.assign(new Error('duplicate key value violates unique constraint "organizations_slug_key"'), {
      name: "error",
      severity: "ERROR",
      code: "23505",
    });
    const drizzle = Object.assign(new Error("Failed query: insert into organizations\nparams: internal", { cause: pg }), { name: "DrizzleQueryError" });
    expect(errorType(drizzle)).toBe("DrizzleQueryError < DatabaseError 23505");
  });

  it("drops a name or code that could carry free text", () => {
    const odd = Object.assign(new Error("x"), { name: "Bad name: secret", code: "has spaces in it" });
    expect(errorType(odd)).toBe("Error");
  });

  it("stops on a cycle and on a long chain", () => {
    const a = new Named("a");
    const b = new Named("b", { cause: a });
    Object.defineProperty(a, "cause", { value: b });
    expect(errorType(a)).toBe("Named < Named < Named < Named");
  });

  it("labels a thrown non-error", () => {
    expect(errorType("password")).toBe("unknown error");
    expect(errorType(undefined)).toBe("unknown error");
  });
});
