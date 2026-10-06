// A local socket that speaks just enough of the Postgres wire protocol for node-postgres, so pool
// and connect failures can be tested without a database. Each new connection gets a behavior:
//
// - serve: log in with no password check, then answer every query with an empty result;
// - refuse_password: ask for SCRAM-SHA-256 and refuse the proof with a server-final `e=` reply,
//   the way Supavisor refused the app role on 2026-10-05;
// - drop_on_query: log in, then close the socket on the first query (a dead pooled connection);
// - silent: accept the socket and never answer.
//
// Excluded from the build with the rest of src/testing.

import { createServer, type Server, type Socket } from "node:net";

export type FakeBehavior = "serve" | "refuse_password" | "drop_on_query" | "silent";

export interface FakePostgres {
  port: number;
  /** Connections accepted so far. */
  readonly connections: number;
  /** Closes every open socket from the server side, as a pooler restart would. */
  dropAll(): void;
  close(): Promise<void>;
}

function message(type: string, body: Buffer): Buffer {
  const head = Buffer.alloc(5);
  head.write(type, 0, "ascii");
  head.writeInt32BE(4 + body.length, 1);
  return Buffer.concat([head, body]);
}

const int32 = (n: number) => {
  const b = Buffer.alloc(4);
  b.writeInt32BE(n, 0);
  return b;
};

const auth = (code: number, data = "") => message("R", Buffer.concat([int32(code), Buffer.from(data, "utf8")]));
const ready = () => message("Z", Buffer.from("I", "ascii"));
const complete = () => message("C", Buffer.from("SELECT 0\0", "utf8"));

function handle(sock: Socket, behavior: FakeBehavior): void {
  if (behavior === "silent") return;
  let buf = Buffer.alloc(0);
  let started = false;
  let scram: "first" | "final" | null = null;
  sock.on("error", () => undefined);
  sock.on("data", (chunk) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      if (!started) {
        // The startup message has no type byte: int32 length, then the protocol and parameters.
        if (buf.length < 4 || buf.length < buf.readInt32BE(0)) return;
        buf = buf.subarray(buf.readInt32BE(0));
        started = true;
        if (behavior === "refuse_password") {
          sock.write(auth(10, "SCRAM-SHA-256\0\0"));
          scram = "first";
        } else {
          sock.write(Buffer.concat([auth(0), ready()]));
        }
        continue;
      }
      if (buf.length < 5 || buf.length < 1 + buf.readInt32BE(1)) return;
      const type = String.fromCharCode(buf[0] as number);
      const body = buf.subarray(5, 1 + buf.readInt32BE(1));
      buf = buf.subarray(1 + buf.readInt32BE(1));

      if (scram === "first") {
        // SASLInitialResponse: mechanism, a null, an int32 length, then "n,,n=*,r=<client nonce>".
        const first = body.subarray(body.indexOf(0) + 5).toString("utf8");
        const nonce = /r=([^,]+)/.exec(first)?.[1] ?? "";
        sock.write(auth(11, `r=${nonce}server,s=${Buffer.from("salt").toString("base64")},i=4096`));
        scram = "final";
        continue;
      }
      if (scram === "final") {
        sock.end(auth(12, 'e=password authentication failed for user "bandwise_console"'));
        return;
      }
      if (type === "X") {
        sock.end();
        return;
      }
      if (behavior === "drop_on_query") {
        sock.destroy();
        return;
      }
      // Simple query, or the extended protocol's Parse, Bind, Describe, Execute and Sync.
      if (type === "Q") sock.write(Buffer.concat([complete(), ready()]));
      else if (type === "P") sock.write(message("1", Buffer.alloc(0)));
      else if (type === "B") sock.write(message("2", Buffer.alloc(0)));
      else if (type === "D") sock.write(message("n", Buffer.alloc(0)));
      else if (type === "E") sock.write(complete());
      else if (type === "S") sock.write(ready());
    }
  });
}

/** Starts a fake server. `behaviorFor` picks each connection's behavior by its index, from 0. */
export async function startFakePostgres(behaviorFor: (index: number) => FakeBehavior): Promise<FakePostgres> {
  const sockets = new Set<Socket>();
  let connections = 0;
  const server: Server = createServer((sock) => {
    sockets.add(sock);
    sock.on("close", () => sockets.delete(sock));
    handle(sock, behaviorFor(connections));
    connections += 1;
  });
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
    });
  });
  return {
    port,
    get connections() {
      return connections;
    },
    dropAll() {
      for (const s of sockets) s.destroy();
    },
    close() {
      for (const s of sockets) s.destroy();
      return new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A port nothing listens on, for a refused connection. */
export async function closedPort(): Promise<number> {
  const server = createServer();
  const port = await new Promise<number>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      resolve(typeof addr === "object" && addr !== null ? addr.port : 0);
    });
  });
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return port;
}

export const fakeUrl = (port: number) => `postgres://bandwise_console:old-password@127.0.0.1:${port}/postgres`;
