/**
 * Community MCP registry search (control-plane Meilisearch mirror — the
 * browser never talks to the registry or Meilisearch directly).
 *
 * Debounce the input BEFORE handing `q` to this hook; the hook keeps the
 * previous page's results on screen while the next query loads so the
 * browser panel never flashes empty mid-typing.
 *
 * TRANSITIONAL (connectors plan 1, Task 11 removes this): the wire shape is
 * `{results, total}` but the current registry browser still renders
 * RegistryServerSummary cards, so results are adapted to that shape here.
 * The add-connection dialog rebuild consumes RegistrySearchResult directly
 * and surfaces the 503 `search_unavailable` degraded state.
 */
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import {
  registrySearchResponseSchema,
  type RegistrySearchResult,
  type RegistryServerSummary,
} from "@invisible-string/shared";

import { api } from "../api-client";
import { queryKeys } from "./keys";

export function fetchRegistrySearch(q: string, signal?: AbortSignal) {
  return api.get("/mcp-registry/search", registrySearchResponseSchema, {
    query: { q },
    signal,
  });
}

/** Community-search hit → the summary shape the legacy browser renders. */
function toSummary(result: RegistrySearchResult): RegistryServerSummary {
  return {
    name: result.name,
    title: result.title,
    description: result.description,
    // The mirror indexes latest versions only; the exact version string is
    // not part of the search DTO.
    version: "latest",
    remotes: result.remotes,
    // Remote header declarations drive the install form's secret prompts;
    // package-level env vars are not part of the search DTO.
    envVarDeclarations: [],
  };
}

export function useRegistrySearch(q: string) {
  const trimmed = q.trim();
  return useQuery({
    queryKey: queryKeys.registry.search(trimmed),
    queryFn: ({ signal }) => fetchRegistrySearch(trimmed, signal),
    select: (data) => data.results.map(toSummary),
    enabled: trimmed.length > 0,
    placeholderData: keepPreviousData,
    // Registry content changes slowly; don't refetch per keystroke revisit.
    staleTime: 5 * 60_000,
  });
}
