/**
 * OpenRouter model-catalog lookup for allowlist-add validation (keyed
 * acceptance papercut: an OpenRouter-invalid model id — e.g. the gateway
 * slug `zai/glm-5.2` instead of OpenRouter's `z-ai/glm-5.2` — used to sail
 * through allowlisting and publish, and only fail at RUN time with a
 * provider error).
 *
 * Uses the public, keyless `GET /api/v1/models` endpoint. STRICTLY
 * advisory/fail-open: any network problem, non-200, or unparseable body
 * yields `null` ("catalog unavailable"), and the caller allowlists the id
 * unchecked — the platform must keep working offline/air-gapped. The catalog
 * is cached so bursts of allowlist edits cost one fetch.
 */

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

/** `() => ids | null`; null = catalog unavailable → caller fails OPEN. */
export type OpenRouterModelIds = () => Promise<ReadonlySet<string> | null>;

export interface CreateOpenRouterCatalogOptions {
  fetchImpl?: typeof fetch;
  /** Catalog cache lifetime (default 10 minutes). */
  cacheTtlMs?: number;
  /** Per-fetch timeout (default 5s — an allowlist add must stay snappy). */
  requestTimeoutMs?: number;
  now?: () => number;
}

export function createOpenRouterCatalog(
  options: CreateOpenRouterCatalogOptions = {},
): OpenRouterModelIds {
  const doFetch = options.fetchImpl ?? fetch;
  const cacheTtlMs = options.cacheTtlMs ?? 600_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
  const now = options.now ?? Date.now;

  let cached: { ids: ReadonlySet<string>; expiresAt: number } | null = null;
  let inFlight: Promise<ReadonlySet<string> | null> | null = null;

  async function fetchCatalog(): Promise<ReadonlySet<string> | null> {
    try {
      const res = await doFetch(OPENROUTER_MODELS_URL, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { data?: { id?: unknown }[] };
      if (!Array.isArray(body.data)) return null;
      const ids = new Set<string>();
      for (const model of body.data) {
        if (typeof model?.id === "string") ids.add(model.id);
      }
      // An empty catalog is indistinguishable from a broken response — treat
      // it as unavailable rather than rejecting every model id.
      if (ids.size === 0) return null;
      cached = { ids, expiresAt: now() + cacheTtlMs };
      return ids;
    } catch {
      return null; // fail OPEN — advisory check only
    }
  }

  return async () => {
    if (cached !== null && cached.expiresAt > now()) return cached.ids;
    if (inFlight === null) {
      inFlight = fetchCatalog().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };
}

/**
 * Is `modelId` known to the catalog? Variant suffixes (`:free`, `:extended`,
 * `:nitro`, …) are usually listed as their own catalog entries, but when the
 * exact variant is absent the BASE id being present is accepted too —
 * fail-safe towards allowing.
 */
export function catalogHasModel(
  ids: ReadonlySet<string>,
  modelId: string,
): boolean {
  if (ids.has(modelId)) return true;
  const variantSeparator = modelId.indexOf(":");
  return variantSeparator > 0 && ids.has(modelId.slice(0, variantSeparator));
}
