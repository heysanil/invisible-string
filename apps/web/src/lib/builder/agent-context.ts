/**
 * The SELECTED agent's PUBLISHED context (what `@connection`/`@skill`
 * autocomplete + local checks resolve against in the workflow builder). This
 * mirrors the server: the workflow validator and dispatch resolve references
 * against the agent's CURRENT PUBLISHED version, never its draft — resolving
 * against the draft here would make the builder lie whenever draft and
 * published context diverge (offer refs that 422 at publish, or warn on refs
 * dispatch resolves fine).
 */
import { useQuery } from "@tanstack/react-query";
import type { AgentContext } from "@invisible-string/shared";
import { parseAgentDefinition } from "@invisible-string/shared";

import { fetchAgent } from "../queries/agents";
import { queryKeys } from "../queries/keys";

const EMPTY_CONTEXT: AgentContext = { mcpConnectionIds: [], skillIds: [] };

/**
 * Null while no agent is selected or its detail is still loading; otherwise
 * the published version's context. Unpublished agent (or a shape-invalid
 * stored definition) resolves to the EMPTY context — it has no
 * dispatch-resolvable context, and the publish gate blocks on unpublished
 * agents anyway.
 */
export function useSelectedAgentContext(
  workspaceId: string,
  agentId: string | null,
): AgentContext | null {
  const query = useQuery({
    queryKey: queryKeys.agents.detail(workspaceId, agentId ?? "unselected"),
    queryFn: ({ signal }) => fetchAgent(workspaceId, agentId!, signal),
    enabled: agentId !== null,
    staleTime: 30_000,
    select: (data) =>
      parseAgentDefinition(data.agent.publishedDefinition)?.context ??
      EMPTY_CONTEXT,
  });
  return agentId === null ? null : (query.data ?? null);
}
