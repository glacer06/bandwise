// Handler for agent_token.list (management-api.md, Identity, tokens and admin). It reads the org's
// agent tokens in the caller's tenant transaction and returns display fields only: never the hash
// or the prefix.

import { repos } from "@bandwise/db";

import type { OperationEnv } from "../operations/define";
import type { AgentTokenView } from "../operations/views";
import { iso, isoOrNull } from "./common";
import { cursorOf } from "./sets";

type TokenRow = Awaited<ReturnType<typeof repos.agentTokens.list>>["data"][number];

export function agentTokenView(t: TokenRow): AgentTokenView {
  return {
    id: t.id,
    name: t.name,
    client: t.client,
    userId: t.userId,
    roleCeiling: t.roleCeiling,
    scopes: [...t.scopes],
    expiresAt: iso(t.expiresAt),
    revokedAt: isoOrNull(t.revokedAt),
    lastUsedAt: isoOrNull(t.lastUsedAt),
    createdAt: iso(t.createdAt),
  };
}

export async function listAgentTokens(env: OperationEnv, input: { limit: number; cursor?: string | undefined }) {
  env.authorize({});
  const page = await repos.agentTokens.list(env.tx, { limit: input.limit, cursor: cursorOf(input.cursor, "uuid") });
  return { data: page.data.map(agentTokenView), nextCursor: page.nextCursor };
}
