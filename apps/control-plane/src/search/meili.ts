/**
 * Meilisearch client + registry index bootstrap.
 *
 * The `mcp_registry` index is a DISPOSABLE search mirror of the official MCP
 * registry (connectors redesign spec §5): the control-plane sync ETL
 * repopulates it in full, so it is never backed up — an empty index simply
 * resyncs. Meilisearch being unconfigured or unreachable degrades registry
 * search only; nothing here may ever be fatal to boot.
 */
import { Meilisearch } from "meilisearch";
import type { Settings } from "meilisearch";

/** The one index this platform owns: mirrored MCP registry entries. */
export const REGISTRY_INDEX = "mcp_registry";

/** Re-exported so consumers depend on this module, not the npm package. */
export type MeiliClient = Meilisearch;

/**
 * Index settings. `verified:desc` as the LAST ranking rule makes curated
 * (catalog-verified) entries win ties after full relevancy ordering; the
 * `verified` filterable attribute backs explicit filters.
 */
const REGISTRY_INDEX_SETTINGS: Settings = {
  searchableAttributes: ["title", "name", "description"],
  filterableAttributes: ["verified"],
  rankingRules: [
    "words",
    "typo",
    "proximity",
    "attribute",
    "sort",
    "exactness",
    "verified:desc",
  ],
};

export function createMeiliClient(cfg: {
  url: string;
  apiKey: string;
}): MeiliClient {
  return new Meilisearch({ host: cfg.url, apiKey: cfg.apiKey });
}

/**
 * Create the registry index (primaryKey `id`) and apply its settings.
 * Idempotent: an `index_already_exists` task failure is expected on every
 * boot after the first; settings application is a plain overwrite.
 */
export async function ensureRegistryIndex(client: MeiliClient): Promise<void> {
  const created = await client
    .createIndex(REGISTRY_INDEX, { primaryKey: "id" })
    .waitTask();
  if (
    created.status !== "succeeded" &&
    created.error?.code !== "index_already_exists"
  ) {
    throw new Error(
      `meilisearch createIndex(${REGISTRY_INDEX}) ${created.status}: ${created.error?.message ?? "unknown error"}`,
    );
  }
  const settings = await client
    .index(REGISTRY_INDEX)
    .updateSettings(REGISTRY_INDEX_SETTINGS)
    .waitTask();
  if (settings.status !== "succeeded") {
    throw new Error(
      `meilisearch updateSettings(${REGISTRY_INDEX}) ${settings.status}: ${settings.error?.message ?? "unknown error"}`,
    );
  }
}
