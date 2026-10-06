// The database handle. It never hands out a raw drizzle instance: every query runs inside
// withTenant (org scope), withUser (pre-org lookups) or withNoTenant (auth and platform tables).

import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import pg from "pg";

import { TenantContext, UserId } from "@bandwise/core/contracts";

import { connectionFailure, DbConnectionError, nameDriverError } from "./errors.js";
import { DRIZZLE, type DrizzleDb, type DrizzleTx, type NoTenantTx, type TenantTx, type UserTx } from "./internal/drizzle.js";
import { TENANT_SETTING, USER_SETTING } from "./rls.js";
import * as schema from "./schema/index.js";

export type { NoTenantTx, TenantTx, UserTx, AnyTx } from "./internal/drizzle.js";

export interface BandwiseDb {
  /**
   * Opens a transaction, runs `select set_config('app.org_id', orgId, true)` (transaction-local,
   * so a pooled connection never keeps it), and hands `fn` a scope that tenant repositories accept.
   * Repositories add their own org filter on top, and RLS catches anything they miss.
   */
  withTenant<T>(ctx: TenantContext, fn: (tx: TenantTx) => Promise<T>): Promise<T>;
  /** Pre-org lookups for one signed-in user (ADR-002): sets app.user_id, never app.org_id. */
  withUser<T>(userId: string, fn: (tx: UserTx) => Promise<T>): Promise<T>;
  /** Auth tables and platform reads. Tenant tables return zero rows in this scope. */
  withNoTenant<T>(fn: (tx: NoTenantTx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * One transaction, with every failure named (errors.ts): a DbConnectionError when it never
 * started (the pool could not connect, or BEGIN failed), else the error as thrown, with drizzle's
 * query error named.
 */
async function transaction<T>(db: DrizzleDb, fn: (d: DrizzleTx) => Promise<T>): Promise<T> {
  let started = false;
  try {
    return await db.transaction((d) => {
      started = true;
      return fn(d);
    });
  } catch (e) {
    if (!started) throw new DbConnectionError(connectionFailure(e), { cause: e });
    throw nameDriverError(e);
  }
}

/** Runs `fn` in one transaction. The scopes below differ only in what they set first. */
type RunTransaction = <T>(fn: (d: DrizzleTx) => Promise<T>) => Promise<T>;

function scopes(run: RunTransaction, close: () => Promise<void>): BandwiseDb {
  return {
    async withTenant(ctx, fn) {
      const parsed = TenantContext.parse(ctx);
      return run(async (d) => {
        await d.execute(sql`select set_config(${TENANT_SETTING}, ${parsed.orgId}, true)`);
        return fn({ kind: "tenant", orgId: parsed.orgId, ctx: parsed, [DRIZZLE]: d });
      });
    },
    async withUser(userId, fn) {
      const id = UserId.parse(userId);
      return run(async (d) => {
        await d.execute(sql`select set_config(${USER_SETTING}, ${id}, true)`);
        return fn({ kind: "user", userId: id, [DRIZZLE]: d });
      });
    },
    withNoTenant(fn) {
      return run(async (d) => fn({ kind: "none", [DRIZZLE]: d }));
    },
    close,
  };
}

/** Wraps a drizzle database. Internal: callers use createDatabase or the test harness. */
export function wrapDrizzle(db: DrizzleDb, close: () => Promise<void>): BandwiseDb {
  return scopes((fn) => transaction(db, fn), close);
}

/** How long a transaction waits for a pooled connection, new or free, before DbConnectionError timeout. */
export const DEFAULT_CONNECTION_TIMEOUT_MS = 5_000;

export interface CreateDatabaseOptions {
  /** DATABASE_URL. The login role must be a member of bandwise_app and must not have BYPASSRLS. */
  connectionString: string;
  /** Pool size. Defaults to 10. */
  max?: number;
  /** Wait for a connection, in ms. Defaults to DEFAULT_CONNECTION_TIMEOUT_MS. */
  connectionTimeoutMillis?: number;
  /**
   * Called when an idle pooled connection fails (the server or the network closed it). The pool
   * has already dropped it. Log the error type only (core's errorType), never the message.
   */
  onIdleError?: (e: Error) => void;
}

/**
 * A pooled node-postgres database. It checks connections out and back in itself, rather than
 * through drizzle's pool path, because drizzle 0.45 runs BEGIN before its try block: a BEGIN that
 * fails on a dead connection never released it, and with a small pool and no connect timeout the
 * instance then waited forever for a connection. Here every checkout is released, a broken
 * connection is dropped instead of reused, and every wait has a limit.
 */
export function createDatabase(opts: CreateDatabaseOptions): BandwiseDb {
  const pool = new pg.Pool({
    connectionString: opts.connectionString,
    max: opts.max ?? 10,
    connectionTimeoutMillis: opts.connectionTimeoutMillis ?? DEFAULT_CONNECTION_TIMEOUT_MS,
  });
  // Without a listener, an idle connection that fails is an uncaught error that ends the process.
  pool.on("error", (e) => opts.onIdleError?.(e));

  // One drizzle instance per pooled connection, built once: building one costs about 0.25 ms.
  const perClient = new WeakMap<pg.PoolClient, DrizzleDb>();
  const dbFor = (client: pg.PoolClient): DrizzleDb => {
    let db = perClient.get(client);
    if (db === undefined) {
      db = drizzle(client, { schema, casing: "snake_case" });
      perClient.set(client, db);
    }
    return db;
  };

  const run: RunTransaction = async (fn) => {
    let client: pg.PoolClient;
    try {
      client = await pool.connect();
    } catch (e) {
      throw new DbConnectionError(connectionFailure(e), { cause: e });
    }
    // pg-pool drops its own listener while a connection is checked out, so a connection that dies
    // mid-transaction would also be an uncaught error. The query in flight fails with it anyway.
    let broken: Error | undefined;
    const onError = (e: Error) => {
      broken ??= e;
    };
    client.on("error", onError);
    try {
      return await transaction(dbFor(client), fn);
    } catch (e) {
      // BEGIN failed: do not hand this connection out again.
      if (e instanceof DbConnectionError) broken ??= e;
      throw e;
    } finally {
      client.removeListener("error", onError);
      client.release(broken);
    }
  };
  return scopes(run, () => pool.end());
}
