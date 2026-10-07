// The org's agent tokens by name, for the "Made by" filter on the runs and savings pages. Read
// through agent_token.list like any other page read. Only names reach the page.
import "server-only";

import { consoleOperation } from "~/server/console-operation";
import type { AgentTokenView } from "~/server/operations/views";

/**
 * Options for a token filter: one per name, sorted. A rotated token keeps its name, and the
 * filter by name covers every token that has it. Empty when agent_token.list fails, so the page
 * still renders its own data.
 */
export async function loadTokenOptions(): Promise<{ value: string; label: string }[]> {
  const res = await consoleOperation("agent_token.list", { limit: "200" });
  if (res.status !== "ok") return [];
  const names = new Set((res.output as { data: AgentTokenView[] }).data.map((t) => t.name));
  return [...names].sort((a, b) => a.localeCompare(b)).map((name) => ({ value: name, label: name }));
}
