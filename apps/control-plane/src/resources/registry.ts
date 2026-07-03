/**
 * MCP registry proxy client (registry.modelcontextprotocol.io).
 *
 * SSRF STANCE: this client fetches ONE fixed, hardcoded host and nothing else.
 * The only caller-controlled inputs are a search string (URL-query-encoded)
 * and a registry server NAME (path-segment-encoded) — never a URL. The control
 * plane never fetches a user-supplied URL server-side; custom-URL connections
 * are created from data the client sends, not fetched here. This keeps the
 * registry proxy from being turned into a server-side request forgery gadget.
 *
 * The upstream list/detail JSON is trimmed to {@link RegistryServerSummary}
 * (api.ts) — the UI never sees fields we don't render. Results are cached in
 * memory for 60s; upstream failures surface as a typed 502.
 */
import {
  registryServerSummarySchema,
  type RegistrySearchResponse,
  type RegistryServerSummary,
} from "@invisible-string/shared";

import { errors } from "../runtime/errors";

/** The ONLY host this module ever contacts (SSRF containment). */
export const REGISTRY_HOST = "https://registry.modelcontextprotocol.io";
const SEARCH_PATH = "/v0.1/servers";
const CACHE_TTL_MS = 60_000;
const REQUEST_TIMEOUT_MS = 10_000;

export interface RegistryClient {
  /** Active + latest servers matching the free-text query (trimmed DTOs). */
  search(query: string): Promise<RegistryServerSummary[]>;
  /** One server's latest (or pinned) detail, or null when not found. */
  getServer(name: string, version?: string): Promise<RegistryServerSummary | null>;
}

// ── upstream JSON → trimmed DTO ───────────────────────────────────────────────

type Json = Record<string, unknown>;

function asObject(value: unknown): Json | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Json)
    : null;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The registry official `_meta` extension (status + isLatest live here). */
function officialMeta(entry: Json): Json | null {
  const meta = asObject(entry._meta);
  if (!meta) return null;
  return asObject(meta["io.modelcontextprotocol.registry/official"]);
}

/** A list entry may be `{ server, _meta }` or a flat server object. */
function serverAndMeta(entry: Json): { server: Json; meta: Json | null } {
  const nested = asObject(entry.server);
  if (nested) return { server: nested, meta: officialMeta(entry) };
  return { server: entry, meta: officialMeta(entry) };
}

/** Keep only active + latest servers (defensive when `_meta` is absent). */
function isActiveLatest(meta: Json | null): boolean {
  if (!meta) return true; // no meta → trust the version=latest query
  const status = meta.status;
  const isLatest = meta.isLatest;
  const activeOk = status === undefined || status === "active";
  const latestOk = isLatest === undefined || isLatest === true;
  return activeOk && latestOk;
}

function mapEnvVars(raw: unknown): unknown[] {
  return asArray(raw)
    .map((item) => {
      const obj = asObject(item);
      if (!obj || typeof obj.name !== "string") return null;
      return {
        name: obj.name,
        description: typeof obj.description === "string" ? obj.description : undefined,
        isRequired: obj.isRequired === true,
        isSecret: obj.isSecret === true,
        format: typeof obj.format === "string" ? obj.format : undefined,
        default: typeof obj.default === "string" ? obj.default : undefined,
      };
    })
    .filter((v) => v !== null);
}

function isHttpUrl(value: unknown): value is string {
  return typeof value === "string" && /^https?:\/\//i.test(value);
}

function mapRemotes(raw: unknown): unknown[] {
  return asArray(raw)
    .map((item) => {
      const obj = asObject(item);
      // Drop remotes with a missing/malformed url so one bad entry can't fail
      // the whole server row's schema parse (registry data is user-published).
      if (!obj || typeof obj.type !== "string" || !isHttpUrl(obj.url)) {
        return null;
      }
      return {
        type: obj.type,
        url: obj.url,
        headers: mapEnvVars(obj.headers),
      };
    })
    .filter((v) => v !== null);
}

function mapPackagesEnv(raw: unknown): unknown[] {
  const seen = new Set<string>();
  const out: unknown[] = [];
  for (const pkg of asArray(raw)) {
    const obj = asObject(pkg);
    if (!obj) continue;
    for (const env of mapEnvVars(obj.environmentVariables)) {
      const name = (env as { name: string }).name;
      if (seen.has(name)) continue;
      seen.add(name);
      out.push(env);
    }
  }
  return out;
}

function mapIcons(raw: unknown): unknown[] | undefined {
  const icons = asArray(raw)
    .map((item) => {
      const obj = asObject(item);
      if (!obj || !isHttpUrl(obj.src)) return null;
      return {
        src: obj.src,
        mimeType: typeof obj.mimeType === "string" ? obj.mimeType : undefined,
        sizes: typeof obj.sizes === "string" ? obj.sizes : undefined,
        theme:
          obj.theme === "light" || obj.theme === "dark" ? obj.theme : undefined,
      };
    })
    .filter((v) => v !== null);
  return icons.length > 0 ? icons : undefined;
}

/** Trim one upstream entry to the DTO; null when it fails validation/filter. */
export function mapRegistryEntry(entry: Json): RegistryServerSummary | null {
  const { server, meta } = serverAndMeta(entry);
  if (!isActiveLatest(meta)) return null;
  const candidate = {
    name: server.name,
    title: typeof server.title === "string" ? server.title : undefined,
    description: typeof server.description === "string" ? server.description : "",
    version: typeof server.version === "string" ? server.version : undefined,
    remotes: mapRemotes(server.remotes),
    envVarDeclarations: mapPackagesEnv(server.packages),
    icons: mapIcons(server.icons),
  };
  // httpUrlSchema on remote/icon urls throws on bad urls — drop rather than
  // 500 the whole search on one malformed upstream row.
  const parsed = registryServerSummarySchema.safeParse(candidate);
  return parsed.success ? parsed.data : null;
}

// ── HTTP client ───────────────────────────────────────────────────────────────

interface CacheEntry {
  expires: number;
  servers: RegistryServerSummary[];
}

export interface CreateRegistryClientOptions {
  fetchImpl?: typeof fetch;
  ttlMs?: number;
  now?: () => number;
  /**
   * Override the registry host (MCP_REGISTRY_BASE_URL). LOCAL DEV/CI ONLY — an
   * operator-controlled test seam that points the proxy at a local stub (same
   * shape as OPENROUTER_BASE_URL). Never set in production: the SSRF
   * containment above assumes the single hardcoded host.
   */
  baseUrl?: string;
}

export function createRegistryClient(
  options: CreateRegistryClientOptions = {},
): RegistryClient {
  const doFetch = options.fetchImpl ?? fetch;
  const ttlMs = options.ttlMs ?? CACHE_TTL_MS;
  const now = options.now ?? Date.now;
  const host = (options.baseUrl?.trim() || REGISTRY_HOST).replace(/\/+$/, "");
  const cache = new Map<string, CacheEntry>();

  async function getJson(url: string): Promise<Json> {
    let res: Response;
    try {
      res = await doFetch(url, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw errors.registryUnavailable(
        error instanceof Error ? error.message : String(error),
      );
    }
    if (!res.ok) {
      throw errors.registryUnavailable(`upstream responded ${res.status}`);
    }
    const json = (await res.json().catch(() => null)) as unknown;
    const obj = asObject(json);
    if (!obj) throw errors.registryUnavailable("upstream returned a non-object body");
    return obj;
  }

  return {
    async search(query) {
      const key = query.trim().toLowerCase();
      const cached = cache.get(key);
      if (cached && cached.expires > now()) return cached.servers;

      const url = `${host}${SEARCH_PATH}?search=${encodeURIComponent(query)}&version=latest`;
      const body = await getJson(url);
      const servers = asArray(body.servers)
        .map((entry) => {
          const obj = asObject(entry);
          return obj ? mapRegistryEntry(obj) : null;
        })
        .filter((s): s is RegistryServerSummary => s !== null);
      cache.set(key, { expires: now() + ttlMs, servers });
      return servers;
    },

    async getServer(name, version = "latest") {
      // Path-segment-encode BOTH the reverse-DNS name and version; still the
      // fixed host, never a user URL.
      const url = `${host}${SEARCH_PATH}/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}`;
      let body: Json;
      try {
        body = await getJson(url);
      } catch (error) {
        // A 404 upstream surfaces as registry_unavailable via getJson; treat a
        // "responded 404" as not-found for a cleaner caller experience.
        if (
          error instanceof Error &&
          error.message.includes("responded 404")
        ) {
          return null;
        }
        throw error;
      }
      return mapRegistryEntry(body);
    },
  };
}

export function toRegistrySearchResponse(
  servers: RegistryServerSummary[],
): RegistrySearchResponse {
  return { servers };
}
