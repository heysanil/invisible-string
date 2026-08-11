/**
 * Meilisearch-backed community registry search (connectors redesign spec §5).
 *
 * `GET /mcp-registry/search` queries the disposable `mcp_registry` mirror
 * instead of the upstream substring API: typo tolerance, `verified:desc`
 * tie-breaking, and installable-only results all come from the index the
 * sync ETL maintains (search/registry-sync.ts). No Meilisearch client —
 * unconfigured or unreachable — degrades to a typed 503 `search_unavailable`;
 * the curated catalog and custom-URL lanes never depend on this module.
 */
import {
  registrySearchResultSchema,
  type RegistrySearchResponse,
  type RegistrySearchResult,
} from "@invisible-string/shared";

import { errors } from "../runtime/errors";
import { REGISTRY_INDEX, type MeiliClient } from "./meili";
import type { RegistryDocument } from "./registry-docs";

/** Result-page defaults + bounds (route query params clamp into these). */
export const SEARCH_DEFAULT_LIMIT = 20;
export const SEARCH_MAX_LIMIT = 50;

export interface SearchRegistryOptions {
  limit?: number;
  offset?: number;
}

function clampLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) return SEARCH_DEFAULT_LIMIT;
  return Math.min(SEARCH_MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

function clampOffset(offset: number | undefined): number {
  if (offset === undefined || !Number.isFinite(offset)) return 0;
  return Math.max(0, Math.floor(offset));
}

/** Trim one indexed document to the wire DTO (drops the meili id). */
function toResult(doc: RegistryDocument): RegistrySearchResult | null {
  const parsed = registrySearchResultSchema.safeParse({
    name: doc.name,
    title: doc.title,
    description: doc.description,
    verified: doc.verified,
    remotes: doc.remotes,
  });
  // A malformed document (hand-edited index, older mapper) is dropped rather
  // than failing the whole page — the index is disposable, not trusted.
  return parsed.success ? parsed.data : null;
}

/**
 * Query the registry mirror. Throws {@link errors.searchUnavailable} (503)
 * when no client is configured or the query fails — the route surfaces that
 * body verbatim and the SPA degrades to catalog-only.
 */
export async function searchRegistry(
  meili: MeiliClient | null,
  q: string,
  opts: SearchRegistryOptions = {},
): Promise<RegistrySearchResponse> {
  if (!meili) throw errors.searchUnavailable();
  const limit = clampLimit(opts.limit);
  const offset = clampOffset(opts.offset);
  let response;
  try {
    response = await meili
      .index<RegistryDocument>(REGISTRY_INDEX)
      .search(q, { limit, offset });
  } catch {
    // Unreachable/misbootstrapped Meilisearch — same degradation as "not
    // configured"; the sync ETL logs the underlying failure separately.
    throw errors.searchUnavailable();
  }
  const results = response.hits
    .map((hit) => toResult(hit))
    .filter((r): r is RegistrySearchResult => r !== null);
  return {
    results,
    total: response.estimatedTotalHits ?? results.length,
  };
}
