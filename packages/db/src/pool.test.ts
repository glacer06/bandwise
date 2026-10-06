// The pooled database (createDatabase) against a fake server (testing/fake-postgres.ts): every
// checkout is released, a broken connection is dropped and never reused, a dying connection never
// becomes an uncaught error, and every wait for a connection has a limit.
//
// Each test ends with db.close(), which waits for every connection the pool still holds. A leaked
// checkout would make it hang, and the test would time out.

import { errorType } from "@bandwise/core";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";

import { createDatabase } from "./client.js";
import { DbConnectionError } from "./errors.js";
import { drizzleOf } from "./internal/drizzle.js";
import { fakeUrl, startFakePostgres } from "./testing/fake-postgres.js";

async function rejection(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a rejection");
}

const pause = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("createDatabase", () => {
  it("runs a transaction end to end on the fake server", async () => {
    const server = await startFakePostgres(() => "serve");
    const db = createDatabase({ connectionString: fakeUrl(server.port), max: 1 });
    try {
      await expect(db.withNoTenant(async (tx) => (await drizzleOf(tx).execute(sql`select 1`), "ok"))).resolves.toBe("ok");
    } finally {
      await db.close();
      await server.close();
    }
  });

  it("releases a connection whose BEGIN failed, so the next transaction gets a new one", async () => {
    // Drizzle 0.45 runs BEGIN before its try block and never released this connection. With one
    // slot and no connect timeout, the second call below used to wait forever.
    const server = await startFakePostgres((i) => (i === 0 ? "drop_on_query" : "serve"));
    const db = createDatabase({ connectionString: fakeUrl(server.port), max: 1 });
    try {
      const e = await rejection(db.withNoTenant(async () => 1));
      expect(e).toBeInstanceOf(DbConnectionError);
      expect((e as DbConnectionError).code).toBe("network");
      await expect(db.withNoTenant(async () => 2)).resolves.toBe(2);
      expect(server.connections).toBe(2);
    } finally {
      await db.close();
      await server.close();
    }
  });

  it("survives a connection that dies mid-transaction, and does not reuse it", async () => {
    // pg-pool removes its error listener while a connection is checked out. Without one of ours,
    // the client's error event would be uncaught and fail this run.
    const server = await startFakePostgres(() => "serve");
    const db = createDatabase({ connectionString: fakeUrl(server.port), max: 1 });
    try {
      const e = await rejection(
        db.withNoTenant(async (tx) => {
          server.dropAll();
          await pause(50);
          return drizzleOf(tx).execute(sql`select 1`);
        }),
      );
      expect((e as Error).name).toBe("DrizzleQueryError");
      await expect(db.withNoTenant(async () => "fresh")).resolves.toBe("fresh");
      expect(server.connections).toBe(2);
    } finally {
      await db.close();
      await server.close();
    }
  });

  it("reports an idle connection that fails instead of crashing, and replaces it", async () => {
    const server = await startFakePostgres(() => "serve");
    let reported: (e: Error) => void = () => undefined;
    const idleError = new Promise<Error>((resolve) => {
      reported = resolve;
    });
    const db = createDatabase({ connectionString: fakeUrl(server.port), max: 1, onIdleError: (e) => reported(e) });
    try {
      await db.withNoTenant(async () => 1);
      server.dropAll();
      const e = await idleError;
      expect(errorType(e)).toBe("Error");
      await expect(db.withNoTenant(async () => "again")).resolves.toBe("again");
      expect(server.connections).toBe(2);
    } finally {
      await db.close();
      await server.close();
    }
  });

  it("gives up on a server that never answers with DbConnectionError timeout", async () => {
    const server = await startFakePostgres(() => "silent");
    const db = createDatabase({ connectionString: fakeUrl(server.port), max: 1, connectionTimeoutMillis: 200 });
    try {
      const began = Date.now();
      const e = await rejection(db.withNoTenant(async () => 1));
      expect(e).toBeInstanceOf(DbConnectionError);
      expect((e as DbConnectionError).code).toBe("timeout");
      expect(Date.now() - began).toBeLessThan(2_000);
    } finally {
      await db.close();
      await server.close();
    }
  });

  it("gives up waiting for a busy pool with DbConnectionError timeout", async () => {
    const server = await startFakePostgres(() => "serve");
    const db = createDatabase({ connectionString: fakeUrl(server.port), max: 1, connectionTimeoutMillis: 200 });
    let finish: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      finish = resolve;
    });
    try {
      const first = db.withNoTenant(async () => {
        await held;
        return "first";
      });
      await pause(20);
      const e = await rejection(db.withNoTenant(async () => "second"));
      expect(e).toBeInstanceOf(DbConnectionError);
      expect((e as DbConnectionError).code).toBe("timeout");
      finish();
      await expect(first).resolves.toBe("first");
    } finally {
      finish();
      await db.close();
      await server.close();
    }
  });
});
