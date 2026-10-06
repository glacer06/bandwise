// What leaves withTenant, withUser and withNoTenant has a name a server log can use (errors.ts).
//
// The connect cases run node-postgres against a fake server (testing/fake-postgres.ts) that refuses
// a SCRAM login the way Supavisor did on 2026-10-05: a server-final message with `e=` instead of a
// signature. No database is needed for those.

import { PGlite } from "@electric-sql/pglite";
import { errorType } from "@bandwise/core";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDatabase, wrapDrizzle, type BandwiseDb } from "./client.js";
import { connectionFailure, DbConnectionError } from "./errors.js";
import { drizzleOf, type DrizzleDb } from "./internal/drizzle.js";
import * as schema from "./schema/index.js";
import { pgErrorOf } from "./testing/errors.js";
import { closedPort, fakeUrl, startFakePostgres } from "./testing/fake-postgres.js";

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

const ORG = "00000000-0000-7000-8000-0000000000aa";
const ctx = { orgId: ORG, actor: { type: "system" as const }, client: "job" as const, plan: "internal", requestId: "t" };

describe("connect failures", () => {
  it("names a refused password DbConnectionError auth_failed, and keeps the secret out of the label", async () => {
    const server = await startFakePostgres(() => "refuse_password");
    const db = createDatabase({ connectionString: fakeUrl(server.port), max: 1 });
    try {
      for (const run of [() => db.withNoTenant(async () => 1), () => db.withTenant(ctx, async () => 1), () => db.withUser(ORG, async () => 1)]) {
        const e = await rejection(run());
        expect(e).toBeInstanceOf(DbConnectionError);
        expect((e as DbConnectionError).code).toBe("auth_failed");
        // node-postgres throws a plain Error for the SCRAM `e=` reply, which is what logged as "Error".
        expect(((e as Error).cause as Error).message).toMatch(/^SASL: SCRAM-SERVER-FINAL-MESSAGE: server returned error/);
        expect(errorType(e)).toBe("DbConnectionError auth_failed < Error");
        expect((e as Error).message).not.toMatch(/old-password|bandwise_console/);
      }
    } finally {
      await db.close();
      await server.close();
    }
  });

  it("names a refused socket DbConnectionError network", async () => {
    const db = createDatabase({ connectionString: fakeUrl(await closedPort()), max: 1 });
    try {
      const e = await rejection(db.withNoTenant(async () => 1));
      expect(e).toBeInstanceOf(DbConnectionError);
      expect(errorType(e)).toBe("DbConnectionError network < Error ECONNREFUSED");
    } finally {
      await db.close();
    }
  });
});

describe("connectionFailure", () => {
  const pgError = (code: string, message: string) => Object.assign(new Error(message), { name: "error", severity: "FATAL", code });
  const wrapped = (cause: Error) => new Error("Failed query: begin\nparams: ", { cause });

  it.each([
    [pgError("28P01", 'password authentication failed for user "bandwise_console"'), "auth_failed"],
    [new Error('SASL: SCRAM-SERVER-FINAL-MESSAGE: server returned error: "invalid-proof"'), "auth_failed"],
    [pgError("53300", "sorry, too many clients already"), "too_many_connections"],
    [pgError("XX000", "Max client connections reached"), "too_many_connections"],
    [new Error("timeout exceeded when trying to connect"), "timeout"],
    [Object.assign(new Error("connect ETIMEDOUT"), { code: "ETIMEDOUT" }), "timeout"],
    [wrapped(new Error("Connection terminated unexpectedly")), "network"],
    [wrapped(Object.assign(new Error("read ECONNRESET"), { code: "ECONNRESET" })), "network"],
    [new Error("something else"), "unknown"],
    ["not an error", "unknown"],
  ])("%s is %s", (e, expected) => {
    expect(connectionFailure(e)).toBe(expected);
  });
});

describe("query failures", () => {
  let pglite: PGlite;
  let db: BandwiseDb;

  beforeAll(async () => {
    pglite = new PGlite();
    const d: DrizzleDb = drizzle(pglite, { schema, casing: "snake_case" });
    db = wrapDrizzle(d, () => pglite.close());
  });

  afterAll(async () => {
    await db.close();
  });

  it("names drizzle's query error and keeps the Postgres error behind it", async () => {
    const failing = () => db.withNoTenant((tx) => drizzleOf(tx).execute(sql`select * from no_such_table`));
    const e = await rejection(failing());
    expect((e as Error).name).toBe("DrizzleQueryError");
    expect(errorType(e)).toBe("DrizzleQueryError < DatabaseError 42P01");
    // Callers that read the Postgres message through `cause` still can.
    expect(await pgErrorOf(failing())).toMatch(/no_such_table/);
  });

  it("passes an error thrown inside the transaction through as it is", async () => {
    class Refused extends Error {
      override readonly name = "Refused";
    }
    const thrown = new Refused("refused at key");
    expect(await rejection(db.withTenant(ctx, async () => Promise.reject(thrown)))).toBe(thrown);
  });
});
