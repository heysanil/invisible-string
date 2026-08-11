/**
 * Community MCP registry search (control-plane Meilisearch mirror — the
 * browser never talks to the registry or Meilisearch directly). The wire
 * shape is `{results, total}`; every result is installable by construction
 * (only active + latest + remote-bearing servers enter the index).
 *
 * Debounce the input BEFORE handing `q` to this hook; the hook keeps the
 * previous page's results on screen while the next query loads so the
 * results panel never flashes empty mid-typing.
 *
 * Degradation is a DISTINCT state, not a generic error: when Meilisearch is
 * unconfigured or unreachable the route answers a typed 503
 * `search_unavailable` — surfaced via {@link isSearchUnavailable} so the
 * add-connection dialog can keep the curated catalog fully usable and only
 * the community lane degrades (spec §5). That code is deliberately never
 * retried; retrying cannot fix an unconfigured index.
 */
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { registrySearchResponseSchema } from "@invisible-string/shared";

import { api, isApiErrorCode } from "../api-client";
import { queryKeys } from "./keys";

/** Typed 503 from `GET /mcp-registry/search` (control-plane errors.ts). */
export const SEARCH_UNAVAILABLE_ERROR_CODE = "search_unavailable";

/** Community search is degraded — catalog and custom lanes are unaffected. */
export function isSearchUnavailable(error: unknown): boolean {
  return isApiErrorCode(error, SEARCH_UNAVAILABLE_ERROR_CODE);
}

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
    select: (data) => data.results,
    enabled: trimmed.length > 0,
    placeholderData: keepPreviousData,
    // Registry content changes slowly; don't refetch per keystroke revisit.
    staleTime: 5 * 60_000,
    // Degradation surfaces immediately; transient failures get one retry.
    retry: (failureCount, error) =>
      !isSearchUnavailable(error) && failureCount < 1,
  });
}
