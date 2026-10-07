// The D3 observe operations through runOperation, on PGlite as the app role: usage.get per day,
// the review queue (list, resolve, dismiss, and an agent's answer that a person confirms), and
// runs and usage by the agent token that made them.

import type { OperationId, Scope, TenantContext } from "@bandwise/core";
import { repos, seedOrgs, type SeededOrg } from "@bandwise/db";
import { createTestDatabase, type TestDatabase } from "@bandwise/db/testing";
import { createTokenHasher } from "@bandwise/tenancy";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { authenticateBearer } from "../auth/bearer";
import { OperationError } from "../operations/errors";
import { runOperation, type OperationDeps } from "../operations/run-operation";
import type { AgentTokenView, ReviewItemView, RunDetail, RunSummary, UsageView } from "../operations/views";

const hasher = createTokenHasher("pepper-".repeat(6));
const NICK = "nick@internal.test";
const VIC = "vic@internal.test";

let t: TestDatabase;
let internal: SeededOrg;
let acme: SeededOrg;
let deps: OperationDeps;

const sys = (orgId: string): TenantContext => ({ orgId, actor: { type: "system" }, client: "job", plan: "internal", requestId: "test" });

function session(org: SeededOrg, email: string, role: "owner" | "viewer"): TenantContext {
  const userId = org.userIds[email];
  if (userId === undefined) throw new Error(`no user ${email}`);
  return { orgId: org.orgId, actor: { type: "user", userId, role, platformRole: null, impersonatorId: null }, client: "console", plan: "internal", requestId: "req-session" };
}

const owner = () => session(internal, NICK, "owner");

/** A run-only agent token named `name`, as the hooks use. Returns its id. */
async function namedToken(org: SeededOrg, name: string): Promise<string> {
  const userId = Object.values(org.userIds)[0] ?? "";
  const { hash } = hasher.mint("sa_live_", org.orgId);
  const row = await t.db.withTenant(sys(org.orgId), (tx) =>
    repos.agentTokens.insert(tx, { userId, name, client: "cli", hash, scopes: ["run"], roleCeiling: "editor", setIds: null, expiresAt: new Date(Date.now() + 86_400_000) }),
  );
  return row.id;
}

async function agent(org: SeededOrg, scopes: Scope[]) {
  const userId = org.userIds[NICK] ?? "";
  const { token, hash } = hasher.mint("sa_live_", org.orgId);
  await t.db.withTenant(sys(org.orgId), (tx) =>
    repos.agentTokens.insert(tx, { userId, name: "cli", client: "cli", hash, scopes, roleCeiling: "admin", setIds: null, expiresAt: new Date(Date.now() + 86_400_000) }),
  );
  return (await authenticateBearer(`Bearer ${token}`, { db: t.db, hasher, now: () => new Date(), requestId: "req-agent" })).ctx;
}

function op<K extends OperationId>(id: K, ctx: TenantContext, input: unknown) {
  return runOperation(id, ctx as never, input, {}, deps);
}

async function ok<T>(p: Promise<{ kind: string }>): Promise<T> {
  const r = (await p) as { kind: string; output?: unknown };
  if (r.kind !== "ok") throw new Error(`expected ok, got ${r.kind}`);
  return r.output as T;
}

async function refused(p: Promise<unknown>): Promise<OperationError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  if (!(e instanceof OperationError)) throw new Error(`expected an OperationError, got ${String(e)}`);
  return e;
}

async function auditRows(org: SeededOrg, action: string) {
  const page = await t.db.withTenant(sys(org.orgId), (tx) => repos.auditLog.list(tx, { limit: 200, cursor: null }));
  return page.data.filter((a) => a.action === action);
}

async function feedbackFor(org: SeededOrg, itemId: string) {
  return t.db.withTenant(sys(org.orgId), (tx) => repos.runFeedback.getByIdempotencyKey(tx, `review:${itemId}`));
}

/**
 * The first of this UTC month: the runs partitions cover this month and the next two. Read once,
 * so setup and the test agree even when the month turns mid-run.
 */
const MONTH_START = (() => {
  const now = new Date();
  return Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
})();

type RunInsert = Parameters<typeof repos.runs.insert>[1];

async function insertRun(org: SeededOrg, createdAt: Date, cost: number, actorTokenId: string | null = null, over: Partial<RunInsert> = {}) {
  const id = crypto.randomUUID();
  await t.db.withTenant(sys(org.orgId), (tx) =>
    repos.runs.insert(tx, {
      id,
      projectId: org.projectId,
      setId: org.setId,
      versionId: org.publishedVersionId,
      channel: "production",
      rollout: "shadow",
      source: "api",
      actorTokenId,
      keyMode: "platform",
      modelRequested: "jev-1.13.0",
      interfaceMajor: 1,
      stateHash: "sha256:x",
      stages: [],
      runBand: "medium",
      overallAction: "auto",
      inputTokens: 10,
      outputTokens: 1,
      systemOneCostMicroUsd: cost,
      systemOneCalls: 1,
      cfInputTokens: 100,
      cfOutputTokens: 10,
      counterfactualMicroUsd: cost * 10,
      counterfactualMode: "one_call",
      comparatorModel: "claude-haiku-4-5",
      savingsMicroUsd: cost * 9,
      savingsKind: "decision",
      escalationCostMicroUsd: 0,
      llmCallsMade: 0,
      llmCallsAvoided: 1,
      latencyMs: 5,
      status: "ok",
      createdAt,
      ...over,
    }),
  );
  return id;
}

async function insertItem(org: SeededOrg, runId: string, opts: { kind?: "action" | "label"; band?: "medium" | "low"; sampleRate?: number } = {}) {
  return t.db.withTenant(sys(org.orgId), (tx) =>
    repos.reviewItems.insert(tx, {
      runId,
      setId: org.setId,
      decisionId: "needs_reply",
      kind: opts.kind ?? "action",
      reason: opts.kind === "label" ? "audit" : "action",
      sampleRate: opts.sampleRate ?? null,
      band: opts.band ?? "medium",
      suggested: { value: true },
    }),
  );
}

let runId: string;

beforeAll(async () => {
  t = await createTestDatabase();
  deps = { db: t.db };
  [internal, acme] = (await seedOrgs(t.db, [
    {
      slug: "internal",
      name: "Internal",
      members: [
        { email: NICK, name: "Nick", role: "owner" },
        { email: VIC, name: "Vic", role: "viewer" },
      ],
    },
    { slug: "acme", name: "Acme", members: [{ email: "ada@acme.test", name: "Ada", role: "owner" }] },
  ])) as [SeededOrg, SeededOrg];
  const start = MONTH_START;
  runId = await insertRun(internal, new Date(start + 10 * 3_600_000), 4);
  await insertRun(internal, new Date(start + 11 * 3_600_000), 6);
  await insertRun(internal, new Date(start + 86_400_000 + 23.5 * 3_600_000), 10);
  await insertRun(acme, new Date(start + 10 * 3_600_000), 1000);
}, 120_000);

afterAll(async () => {
  await t.close();
});

describe("usage.get per day", () => {
  it("sums runs per UTC day, oldest first, for this org only", async () => {
    const start = MONTH_START;
    const range = { from: new Date(start).toISOString(), to: new Date(start + 3 * 86_400_000).toISOString() };
    const usage = await ok<UsageView>(op("usage.get", owner(), range));
    const day = (offset: number) => new Date(start + offset * 86_400_000).toISOString().slice(0, 10);
    expect(usage.days).toEqual([
      { day: day(0), runs: 2, errors: 0, systemOneCostMicroUsd: 10, counterfactualMicroUsd: 100, savingsMicroUsd: 90, llmCallsAvoided: 2 },
      { day: day(1), runs: 1, errors: 0, systemOneCostMicroUsd: 10, counterfactualMicroUsd: 100, savingsMicroUsd: 90, llmCallsAvoided: 1 },
    ]);
    expect(usage.totals.systemOneCostMicroUsd).toBe(20);
  });
});

describe("usage.get would-act counts (ADR-010 Amendment 1)", () => {
  it("counts high band runs whose policy action is auto, split by route; older rows without one are left out", async () => {
    // A window of its own, after the per-day runs above and the by-token runs below.
    const at = (h: number) => new Date(MONTH_START + 10 * 86_400_000 + h * 3_600_000);
    const shadow = { rollout: "shadow" as const, overallAction: "fallback" as const };
    await insertRun(internal, at(1), 1, null, { ...shadow, runBand: "high", policyAction: "auto", route: "continue" });
    await insertRun(internal, at(2), 1, null, { ...shadow, runBand: "high", policyAction: "auto", route: "continue" });
    await insertRun(internal, at(3), 1, null, { ...shadow, runBand: "high", policyAction: "auto", route: "stop" });
    await insertRun(internal, at(4), 1, null, { ...shadow, runBand: "high", policyAction: "review", route: "continue" });
    await insertRun(internal, at(5), 1, null, { ...shadow, runBand: "medium", policyAction: "auto", route: "continue" });
    await insertRun(internal, at(6), 1, null, { ...shadow, runBand: "high", policyAction: null, route: "continue" });
    await insertRun(acme, at(1), 1, null, { ...shadow, runBand: "high", policyAction: "auto", route: "continue" });
    const range = { from: at(0).toISOString(), to: at(7).toISOString() };
    const usage = await ok<UsageView>(op("usage.get", owner(), range));
    expect(usage.sets).toHaveLength(1);
    expect(usage.sets[0]).toMatchObject({ runs: 6, bandHigh: 5, bandMedium: 1, wouldActControlled: 3 });
    expect(usage.sets[0]?.wouldActRoutes).toEqual([
      { route: "continue", runs: 2 },
      { route: "stop", runs: 1 },
    ]);
    expect(usage.totals.wouldActControlled).toBe(3);
  });
});

describe("review queue", () => {
  it("lists items newest first with filters, and hides another org's items", async () => {
    const medium = await insertItem(internal, runId, { band: "medium" });
    const low = await insertItem(internal, runId, { band: "low" });
    const other = await insertItem(acme, runId);
    const page = await ok<{ data: ReviewItemView[] }>(op("review.list", owner(), { status: "open" }));
    const ids = page.data.map((i) => i.id);
    expect(ids).toEqual(expect.arrayContaining([medium.id, low.id]));
    expect(ids).not.toContain(other.id);
    const lows = await ok<{ data: ReviewItemView[] }>(op("review.list", owner(), { band: "low", set: "inbox-triage" }));
    expect(lows.data.map((i) => i.id)).toEqual([low.id]);
    expect(lows.data[0]).toMatchObject({ kind: "action", reason: "action", suggested: { value: true }, runId });
    expect((await refused(op("review.list", owner(), { cursor: "not-a-cursor" }))).code).toBe("invalid_request");
  });

  it("resolves an item, writes a reviewer truth row and an audit row, and refuses a second answer", async () => {
    const item = await insertItem(internal, runId);
    const out = await ok<ReviewItemView>(op("review.resolve", owner(), { id: item.id, resolution: { value: false }, failureClass: "model_error" }));
    expect(out).toMatchObject({ status: "resolved", resolution: { value: false }, resolvedBy: { userId: internal.userIds[NICK] } });
    expect(await feedbackFor(internal, item.id)).toMatchObject({ source: "reviewer", observed: false, decisionId: "needs_reply", runId });
    const audit = (await auditRows(internal, "review.resolve")).find((a) => a.targetId === item.id);
    expect(audit?.diff).toMatchObject({ status: { from: "open", to: "resolved" }, failureClass: "model_error" });
    expect((await refused(op("review.resolve", owner(), { id: item.id, resolution: { value: true } }))).code).toBe("already_exists");
  });

  it("writes an audit truth row for an item the random audit picked", async () => {
    const item = await insertItem(internal, runId, { kind: "label", sampleRate: 0.1 });
    await ok(op("review.resolve", owner(), { id: item.id, resolution: { value: true } }));
    expect(await feedbackFor(internal, item.id)).toMatchObject({ source: "audit", observed: true });
  });

  it("dismisses an item with an audit row, and refuses a viewer and another org", async () => {
    const item = await insertItem(internal, runId);
    expect((await refused(op("review.dismiss", session(internal, VIC, "viewer"), { id: item.id }))).code).toBe("insufficient_scope");
    expect((await refused(op("review.dismiss", session(acme, "ada@acme.test", "owner"), { id: item.id }))).code).toBe("not_found");
    const out = await ok<ReviewItemView>(op("review.dismiss", owner(), { id: item.id }));
    expect(out.status).toBe("dismissed");
    expect(await feedbackFor(internal, item.id)).toBeNull();
    expect((await auditRows(internal, "review.dismiss")).map((a) => a.targetId)).toContain(item.id);
  });

  it("keeps an agent's answer pending until a person confirms or replaces it", async () => {
    const cli = await agent(internal, ["review:read", "review:write"]);
    const kept = await insertItem(internal, runId);
    const proposed = await ok<ReviewItemView>(op("review.resolve", cli, { id: kept.id, resolution: { value: false } }));
    expect(proposed).toMatchObject({ status: "pending_confirmation", resolvedAt: null });
    expect(await feedbackFor(internal, kept.id)).toMatchObject({ source: "agent", confirmedByUserId: null });
    expect((await refused(op("review.dismiss", cli, { id: kept.id }))).code).toBe("insufficient_scope");
    expect((await refused(op("review.confirm", cli, { id: kept.id }))).code).toBe("insufficient_scope");
    expect((await refused(op("review.resolve", owner(), { id: kept.id, resolution: { value: true } }))).code).toBe("already_exists");

    const confirmed = await ok<ReviewItemView>(op("review.confirm", owner(), { id: kept.id }));
    expect(confirmed).toMatchObject({ status: "resolved", resolution: { value: false } });
    expect(await feedbackFor(internal, kept.id)).toMatchObject({ source: "agent", observed: false, confirmedByUserId: internal.userIds[NICK] });

    const replaced = await insertItem(internal, runId);
    await ok(op("review.resolve", cli, { id: replaced.id, resolution: { value: false } }));
    const out = await ok<ReviewItemView>(op("review.confirm", owner(), { id: replaced.id, resolution: { value: true } }));
    expect(out.resolution).toEqual({ value: true });
    expect(await feedbackFor(internal, replaced.id)).toMatchObject({ source: "reviewer", observed: true, userId: internal.userIds[NICK] });
    expect((await auditRows(internal, "review.confirm")).map((a) => a.targetId)).toEqual(expect.arrayContaining([kept.id, replaced.id]));
  });
});

describe("runs by token", () => {
  // A window of its own, after the per-day test's range.
  const at = (hours: number) => new Date(MONTH_START + 5 * 86_400_000 + hours * 3_600_000);
  const range = { from: at(0).toISOString(), to: at(24).toISOString() };
  let nickHooks: string;
  let simsHooks: string;
  let simsRotated: string;
  let acmeHooks: string;
  let nickRun: string;
  let simsRun: string;
  let rotatedRun: string;
  let forgedRun: string;

  beforeAll(async () => {
    nickHooks = await namedToken(internal, "nick-hooks");
    simsHooks = await namedToken(internal, "sims-hooks");
    // A rotated token keeps its name, so a name filter covers both.
    simsRotated = await namedToken(internal, "sims-hooks");
    acmeHooks = await namedToken(acme, "acme-hooks");
    nickRun = await insertRun(internal, at(1), 3, nickHooks);
    simsRun = await insertRun(internal, at(2), 5, simsHooks);
    rotatedRun = await insertRun(internal, at(3), 7, simsRotated);
    await insertRun(internal, at(4), 11);
    await insertRun(acme, at(1), 13, acmeHooks);
    // A run row naming another org's token: the name lookup runs in this org, so it reads nothing.
    forgedRun = await insertRun(internal, at(5), 17, acmeHooks);
  });

  const list = async (ctx: TenantContext, extra: Record<string, unknown>) =>
    (await ok<{ data: RunSummary[] }>(op("run.list", ctx, { ...range, ...extra }))).data;

  it("shows the token id and name on each run summary", async () => {
    const runs = await list(owner(), {});
    const byId = new Map(runs.map((r) => [r.id, r]));
    expect(byId.get(nickRun)).toMatchObject({ actorTokenId: nickHooks, actorTokenName: "nick-hooks" });
    expect(byId.get(simsRun)).toMatchObject({ actorTokenId: simsHooks, actorTokenName: "sims-hooks" });
    expect(byId.get(forgedRun)).toMatchObject({ actorTokenId: acmeHooks, actorTokenName: null });
    expect(runs.find((r) => r.actorTokenId === null)?.actorTokenName).toBeNull();
    expect(JSON.stringify(runs)).not.toContain("sa_live_");
  });

  it("filters run.list by token name or id", async () => {
    expect((await list(owner(), { token: "sims-hooks" })).map((r) => r.id).sort()).toEqual([simsRun, rotatedRun].sort());
    expect((await list(owner(), { token: nickHooks })).map((r) => r.id)).toEqual([nickRun]);
    expect((await list(owner(), { token: simsRotated })).map((r) => r.id)).toEqual([rotatedRun]);
  });

  it("shows the token on run.get", async () => {
    const detail = await ok<RunDetail>(op("run.get", owner(), { id: simsRun }));
    expect(detail).toMatchObject({ actorTokenId: simsHooks, actorTokenName: "sims-hooks" });
  });

  it("splits usage.get totals by token", async () => {
    const all = await ok<UsageView>(op("usage.get", owner(), range));
    expect(all.token).toBeNull();
    expect(all.totals.systemOneCostMicroUsd).toBe(3 + 5 + 7 + 11 + 17);
    const sims = await ok<UsageView>(op("usage.get", owner(), { ...range, token: "sims-hooks" }));
    expect(sims.token).toBe("sims-hooks");
    expect(sims.totals).toMatchObject({ runs: 2, systemOneCostMicroUsd: 12 });
    expect(sims.days.reduce((n, d) => n + d.runs, 0)).toBe(2);
    const nick = await ok<UsageView>(op("usage.get", owner(), { ...range, token: nickHooks }));
    expect(nick).toMatchObject({ token: "nick-hooks", totals: { runs: 1, systemOneCostMicroUsd: 3 } });
  });

  it("never finds another org's token by name or id", async () => {
    for (const token of ["acme-hooks", acmeHooks]) {
      expect((await refused(op("run.list", owner(), { ...range, token }))).code).toBe("not_found");
      expect((await refused(op("usage.get", owner(), { ...range, token }))).code).toBe("not_found");
    }
    const ada = session(acme, "ada@acme.test", "owner");
    for (const token of ["sims-hooks", simsHooks]) {
      expect((await refused(op("run.list", ada, { ...range, token }))).code).toBe("not_found");
    }
    const acmeRuns = await list(ada, {});
    expect(acmeRuns.map((r) => r.actorTokenName)).toEqual(["acme-hooks"]);
    expect(JSON.stringify(acmeRuns)).not.toContain("sims-hooks");
  });

  it("lists the org's agent tokens by name, without hashes, for this org only", async () => {
    const tokens = (await ok<{ data: AgentTokenView[] }>(op("agent_token.list", owner(), { limit: 200 }))).data;
    expect(tokens.map((x) => x.name)).toEqual(expect.arrayContaining(["nick-hooks", "sims-hooks"]));
    expect(tokens.map((x) => x.name)).not.toContain("acme-hooks");
    for (const x of tokens) {
      expect(Object.keys(x)).not.toContain("hash");
      expect(Object.keys(x)).not.toContain("prefix");
    }
  });
});
