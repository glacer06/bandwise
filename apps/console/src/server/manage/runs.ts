// Handlers for run.list, run.get and usage.get (management-api.md, Runs and usage). Runs are read
// without state except in run.get, and only for sets the caller's allowlist admits.

import type { Action, Band, Channel, RunRecordSource, RunStatus } from "@bandwise/core";
import { repos, type RunPageFilter, type RunSetTotals, type RunTotalsRange } from "@bandwise/db";

import type { OperationEnv } from "../operations/define";
import { OperationError } from "../operations/errors";
import type { RunDetail, RunSummary, UsageView } from "../operations/views";
import { allowlistOf, findSet, inAllowlist, iso, isoOrNull, isUuid, setNotFound } from "./common";
import { cursorOf } from "./sets";

/** usage.get without a range: the last seven days. */
export const DEFAULT_USAGE_DAYS = 7;

type RunRow = Awaited<ReturnType<typeof repos.runs.listPage>>["data"][number];

type TokenNames = ReadonlyMap<string, string>;

function summary(r: RunRow, names: TokenNames): RunSummary {
  return {
    id: r.id,
    setId: r.setId,
    versionId: r.versionId,
    channel: r.channel,
    rollout: r.rollout,
    source: r.source,
    status: r.status,
    runBand: r.runBand,
    overallAction: r.overallAction,
    route: r.route,
    modelRequested: r.modelRequested,
    modelResolved: r.modelResolved,
    latencyMs: r.latencyMs,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    systemOneCostMicroUsd: r.systemOneCostMicroUsd,
    counterfactualMicroUsd: r.counterfactualMicroUsd,
    savingsMicroUsd: r.savingsMicroUsd,
    errorCode: r.errorCode,
    actorTokenId: r.actorTokenId,
    actorTokenName: r.actorTokenId === null ? null : (names.get(r.actorTokenId) ?? null),
    createdAt: iso(r.createdAt),
  };
}

/** The set filter: a set the caller can see, or 404 with the same message as a missing set. */
export async function visibleSetId(env: OperationEnv, ref: string): Promise<string> {
  const set = await findSet(env.tx, ref);
  if (!inAllowlist(env.ctx, set.id)) throw new OperationError("not_found", setNotFound(ref));
  return set.id;
}

/**
 * The names of the agent tokens that made these runs, read in the caller's tenant transaction, so
 * RLS and the org filter both apply. Only the id and the name leave this function.
 */
async function tokenNames(env: OperationEnv, rows: readonly { actorTokenId: string | null }[]): Promise<TokenNames> {
  const ids = [...new Set(rows.flatMap((r) => (r.actorTokenId === null ? [] : [r.actorTokenId])))];
  const found = await repos.agentTokens.namesByIds(env.tx, ids);
  return new Map(found.map((t) => [t.id, t.name]));
}

/**
 * The token filter: an agent token id, or a name, which matches every token in the caller's org
 * with that name (revoked ones too, so a rotated token keeps its history). 404 when none matches.
 */
export async function tokenFilter(env: OperationEnv, ref: string): Promise<{ name: string; ids: string[] }> {
  const found = isUuid(ref) ? await repos.agentTokens.namesByIds(env.tx, [ref]) : await repos.agentTokens.listByName(env.tx, ref);
  const first = found[0];
  if (first === undefined) throw new OperationError("not_found", `No agent token ${ref} in this org.`);
  return { name: first.name, ids: found.map((t) => t.id) };
}

const date = (v: string | undefined): Date | undefined => (v === undefined ? undefined : new Date(v));

export async function listRuns(
  env: OperationEnv,
  input: {
    set?: string | undefined;
    version?: number | undefined;
    channel?: Channel | undefined;
    source?: RunRecordSource | undefined;
    status?: RunStatus | undefined;
    band?: Band | undefined;
    action?: Action | undefined;
    token?: string | undefined;
    from?: string | undefined;
    to?: string | undefined;
    limit: number;
    cursor?: string | undefined;
  },
) {
  env.authorize({});
  const filter: RunPageFilter = {};
  const allow = allowlistOf(env.ctx);
  if (allow !== undefined) filter.setIds = allow;
  if (input.set !== undefined) filter.setId = await visibleSetId(env, input.set);
  if (input.version !== undefined) {
    if (filter.setId === undefined) throw new OperationError("invalid_request", "version needs set.");
    const v = await repos.questionSetVersions.getByNumber(env.tx, filter.setId, input.version);
    if (v === null) return { data: [], nextCursor: null };
    filter.versionId = v.id;
  }
  if (input.channel !== undefined) filter.channel = input.channel;
  if (input.source !== undefined) filter.source = input.source;
  if (input.status !== undefined) filter.status = input.status;
  if (input.band !== undefined) filter.band = input.band;
  if (input.action !== undefined) filter.action = input.action;
  if (input.token !== undefined) filter.actorTokenIds = (await tokenFilter(env, input.token)).ids;
  const from = date(input.from);
  const to = date(input.to);
  if (from !== undefined) filter.from = from;
  if (to !== undefined) filter.to = to;
  const page = await repos.runs.listPage(env.tx, filter, { limit: input.limit, cursor: cursorOf(input.cursor, "uuid") });
  const names = await tokenNames(env, page.data);
  return { data: page.data.map((r) => summary(r, names)), nextCursor: page.nextCursor };
}

export async function getRun(env: OperationEnv, input: { id: string }): Promise<RunDetail> {
  const notFound = `No run ${input.id} is visible to this caller.`;
  const run = isUuid(input.id) ? await repos.runs.get(env.tx, input.id) : null;
  if (run === null) {
    env.authorize({}, undefined, notFound);
    throw new OperationError("not_found", notFound);
  }
  env.authorize({ setId: run.setId }, undefined, notFound);
  const items = await repos.reviewItems.listByRun(env.tx, run.id);
  const names = await tokenNames(env, [run]);
  return {
    ...summary(run, names),
    stages: run.stages,
    checks: run.checks,
    answers: (run.answers ?? null) as RunDetail["answers"],
    decisions: (run.decisions ?? null) as RunDetail["decisions"],
    warnings: run.warnings,
    state: (run.state ?? null) as RunDetail["state"],
    reviewItems: items.map((i) => ({
      id: i.id,
      decisionId: i.decisionId,
      kind: i.kind,
      reason: i.reason,
      band: i.band,
      status: i.status,
      resolution: (i.resolution ?? null) as RunDetail["reviewItems"][number]["resolution"],
      resolvedAt: isoOrNull(i.resolvedAt),
    })),
  };
}

const ZERO: Omit<RunSetTotals, "setId"> = {
  runs: 0,
  bandHigh: 0,
  bandMedium: 0,
  bandLow: 0,
  wouldActControlled: 0,
  errors: 0,
  inputTokens: 0,
  outputTokens: 0,
  systemOneCostMicroUsd: 0,
  counterfactualMicroUsd: 0,
  savingsMicroUsd: 0,
  llmCallsAvoided: 0,
};

/**
 * usage.get reads the runs table directly. The usage_daily rollup and the savings ledger land with
 * the jobs runner (Phase 2); the numbers are the same sums.
 */
export async function getUsage(
  env: OperationEnv,
  input: { from?: string | undefined; to?: string | undefined; set?: string | undefined; token?: string | undefined },
): Promise<UsageView> {
  env.authorize({});
  const to = date(input.to) ?? env.now;
  const from = date(input.from) ?? new Date(to.getTime() - DEFAULT_USAGE_DAYS * 86_400_000);
  if (from.getTime() > to.getTime()) throw new OperationError("invalid_request", "from is after to.");
  let setIds = allowlistOf(env.ctx);
  if (input.set !== undefined) setIds = [await visibleSetId(env, input.set)];
  const token = input.token === undefined ? null : await tokenFilter(env, input.token);
  const range: RunTotalsRange = { from, to, ...(setIds === undefined ? {} : { setIds }), ...(token === null ? {} : { actorTokenIds: token.ids }) };
  const rows = await repos.runs.totalsBySet(env.tx, range);
  const days = await repos.runs.totalsByDay(env.tx, range);
  const routes = await repos.runs.wouldActByRoute(env.tx, range);
  const totals = { ...ZERO };
  const sets: UsageView["sets"] = [];
  for (const row of rows) {
    const set = await repos.questionSets.get(env.tx, row.setId);
    const wouldActRoutes = routes
      .filter((r) => r.setId === row.setId)
      .map(({ route, runs }) => ({ route, runs }))
      .sort((a, b) => b.runs - a.runs || String(a.route).localeCompare(String(b.route)));
    sets.push({ ...row, slug: set?.slug ?? row.setId, wouldActRoutes });
    for (const k of Object.keys(ZERO) as (keyof typeof ZERO)[]) totals[k] += row[k];
  }
  return { from: iso(from), to: iso(to), token: token?.name ?? null, sets, totals, days };
}
