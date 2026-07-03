/**
 * MCP registry search (control-plane proxy over
 * registry.modelcontextprotocol.io — the browser never talks to the
 * registry directly).
 *
 * Debounce the input BEFORE handing `q` to this hook; the hook keeps the
 * previous page's results on screen while the next query loads so the
 * browser panel never flashes empty mid-typing.
 */
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { registrySearchResponseSchema } from "@invisible-string/shared";

import { api } from "../api-client";
import { queryKeys } from "./keys";

export function fetchRegistrySearch(q: string, signal?: AbortSignal) {
  return api.get("/mcp-registry/search", registrySearchResponseSchema, {
    query: { q },
    signal,
  });
}

export function useRegistrySearch(q: string) {
  const trimmed = q.trim();
  return useQuery({
    queryKey: queryKeys.registry.search(trimmed),
    queryFn: ({ signal }) => fetchRegistrySearch(trimmed, signal),
    select: (data) => data.servers,
    enabled: trimmed.length > 0,
    placeholderData: keepPreviousData,
    // Registry content changes slowly; don't refetch per keystroke revisit.
    staleTime: 5 * 60_000,
  });
}
