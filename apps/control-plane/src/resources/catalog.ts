/** Catalog-as-code (spec §4): validated at module load — a broken catalog
 * fails the control plane at boot, not at first install. */
import rawCatalog from "@invisible-string/shared/connector-catalog.json" with { type: "json" };
import {
  parseConnectorCatalog,
  type ConnectorCatalogEntry,
} from "@invisible-string/shared";

const entries = parseConnectorCatalog(rawCatalog);
const bySlug = new Map(entries.map((e) => [e.slug, e]));

export function loadConnectorCatalog(): Map<string, ConnectorCatalogEntry> {
  return bySlug;
}
