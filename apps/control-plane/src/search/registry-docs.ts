/**
 * Registry entry → Meilisearch document mapping (connectors redesign spec §5).
 *
 * Pure functions consumed by the registry→Meilisearch sync ETL: every
 * upstream `/v0.1/servers` row runs through {@link syncEntryToAction}, and
 * the returned action is applied to the disposable `mcp_registry` index.
 *
 * Rules:
 * - non-latest versions never touch the index (`skip` — the doc is keyed by
 *   name, and the latest version's row owns it);
 * - deleted/inactive servers leave the index (`delete`);
 * - active + latest rows with zero valid remotes also leave it (`delete`) —
 *   a server that lost its remotes is no longer installable;
 * - everything else `upsert`s the {@link mapRegistryEntry}-trimmed document.
 */
import { mapRegistryEntry, serverAndMeta } from "../resources/registry";

export interface RegistryDocument {
  /** UNPADDED base64url of the server name (Meilisearch-safe primary key). */
  id: string;
  /** Reverse-DNS registry name, e.g. "app.linear/linear". */
  name: string;
  title?: string;
  description: string;
  websiteUrl?: string;
  remotes: Array<{ type: string; url: string; headers: unknown[] }>;
  /** Namespace is NOT io.github.* — a domain-verified publisher. */
  verified: boolean;
  updatedAt?: string;
}

export type SyncAction =
  | { kind: "upsert"; doc: RegistryDocument }
  | { kind: "delete"; id: string }
  | { kind: "skip" };

/**
 * Meilisearch document ids allow only `[a-zA-Z0-9_-]`; unpadded base64url of
 * the registry name fits exactly (Node/Bun's `base64url` emits no padding).
 */
export function registryDocId(name: string): string {
  return Buffer.from(name, "utf8").toString("base64url");
}

/** Decide what one upstream registry row does to the search index. */
export function syncEntryToAction(entry: Record<string, unknown>): SyncAction {
  const { server, meta } = serverAndMeta(entry);
  const name = typeof server.name === "string" ? server.name : "";
  if (!name) return { kind: "skip" }; // nameless row — nothing to key on

  // Non-latest versions are historical rows; only `latest` owns the doc, so
  // this must be decided BEFORE status (a deleted old version must not evict
  // the still-active latest one).
  if (meta && meta.isLatest !== undefined && meta.isLatest !== true) {
    return { kind: "skip" };
  }

  // Deleted/deprecated/inactive → the server leaves the index.
  if (meta && meta.status !== undefined && meta.status !== "active") {
    return { kind: "delete", id: registryDocId(name) };
  }

  // Active + latest from here on: a null trim means the row failed schema
  // validation — junk never entered the index, so there is nothing to delete.
  const summary = mapRegistryEntry(entry);
  if (!summary) return { kind: "skip" };

  // A server that lost all its valid remotes is no longer installable.
  if (summary.remotes.length === 0) {
    return { kind: "delete", id: registryDocId(summary.name) };
  }

  const websiteUrl = server.websiteUrl;
  const updatedAt = meta?.updatedAt;
  return {
    kind: "upsert",
    doc: {
      id: registryDocId(summary.name),
      name: summary.name,
      title: summary.title,
      description: summary.description,
      websiteUrl:
        typeof websiteUrl === "string" && /^https?:\/\//i.test(websiteUrl)
          ? websiteUrl
          : undefined,
      remotes: summary.remotes.map((r) => ({
        type: r.type,
        url: r.url,
        headers: r.headers ?? [],
      })),
      verified: !summary.name.startsWith("io.github."),
      updatedAt: typeof updatedAt === "string" ? updatedAt : undefined,
    },
  };
}
