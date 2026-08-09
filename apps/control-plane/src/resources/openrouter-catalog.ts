/**
 * OpenRouter model-catalog lookup. Two consumers, one fetch:
 * - allowlist-add validation (keyed acceptance papercut: an OpenRouter-invalid
 *   model id — e.g. the gateway slug `zai/glm-5.2` instead of OpenRouter's
 *   `z-ai/glm-5.2` — used to sail through allowlisting and publish, and only
 *   fail at RUN time with a provider error);
 * - model CAPABILITIES (`GET /workspaces/:id/model-capabilities`): the
 *   per-model `reasoning.supported_efforts` set that populates the effort
 *   selectors, plus the context window.
 *
 * Uses the public, keyless `GET /api/v1/models` endpoint. STRICTLY
 * advisory/fail-open: any network problem, non-200, or unparseable body
 * yields `null` ("catalog unavailable"), and callers proceed unchecked — the
 * platform must keep working offline/air-gapped. The catalog is cached so
 * bursts of allowlist edits (or a settings screen load) cost one fetch.
 *
 * The upstream body is PARSED, never trusted: it is third-party JSON that
 * feeds a user-facing selector and, through the efforts, the wire shape of
 * every turn. Unknown effort strings, non-positive context windows, and a
 * `default_effort` outside the supported set are dropped rather than
 * propagated.
 */
import { z } from "zod";
import { reasoningEffortSchema, type ReasoningEffort } from "@invisible-string/shared";

export const OPENROUTER_MODELS_URL = "https://openrouter.ai/api/v1/models";

/** What the catalog knows about one model. */
export interface OpenRouterModelInfo {
  readonly id: string;
  /** Absent when upstream omits it or reports a non-positive/garbage value. */
  readonly contextWindowTokens?: number;
  /**
   * The model's advertised efforts, in UPSTREAM order (descending today —
   * clients sort for display). Empty means "the catalog lists this model but
   * advertises no reasoning support", which is NOT the same as unknown: an
   * absent map entry is unknown.
   */
  readonly supportedEfforts: readonly ReasoningEffort[];
  /** Upstream's own default, kept only when it is inside supportedEfforts. */
  readonly defaultEffort?: ReasoningEffort;
}

/** `() => catalog | null`; null = catalog unavailable → caller fails OPEN. */
export type OpenRouterCatalog = () => Promise<ReadonlyMap<
  string,
  OpenRouterModelInfo
> | null>;

/**
 * One upstream model row. Every field but `id` is `.catch(undefined)`: a row
 * with a malformed context window or effort list is still a perfectly good
 * EXISTENCE record for the allowlist check, so degrade the metadata rather
 * than dropping the model.
 */
const modelEntrySchema = z.object({
  id: z.string().min(1),
  context_length: z.number().int().positive().optional().catch(undefined),
  reasoning: z
    .object({
      supported_efforts: z.array(z.string()).optional().catch(undefined),
      default_effort: z.string().optional().catch(undefined),
    })
    .optional()
    .catch(undefined),
});

/** Rows are validated INDIVIDUALLY — one bad row must not void the catalog. */
const catalogResponseSchema = z.object({ data: z.array(z.unknown()) });

function toModelInfo(raw: unknown): OpenRouterModelInfo | null {
  const parsed = modelEntrySchema.safeParse(raw);
  if (!parsed.success) return null;
  const entry = parsed.data;

  const supportedEfforts: ReasoningEffort[] = [];
  for (const candidate of entry.reasoning?.supported_efforts ?? []) {
    const effort = reasoningEffortSchema.safeParse(candidate);
    // `provider-default` is the PLATFORM's own value ("send no reasoning
    // field"); no provider advertises it, so seeing it upstream means the
    // string collided by accident — drop it rather than offer it as a
    // model capability.
    if (!effort.success || effort.data === "provider-default") continue;
    if (!supportedEfforts.includes(effort.data)) supportedEfforts.push(effort.data);
  }

  const defaultCandidate = reasoningEffortSchema.safeParse(
    entry.reasoning?.default_effort,
  );
  const defaultEffort =
    defaultCandidate.success && supportedEfforts.includes(defaultCandidate.data)
      ? defaultCandidate.data
      : undefined;

  return {
    id: entry.id,
    ...(entry.context_length !== undefined
      ? { contextWindowTokens: entry.context_length }
      : {}),
    supportedEfforts,
    ...(defaultEffort !== undefined ? { defaultEffort } : {}),
  };
}

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
): OpenRouterCatalog {
  const doFetch = options.fetchImpl ?? fetch;
  const cacheTtlMs = options.cacheTtlMs ?? 600_000;
  const requestTimeoutMs = options.requestTimeoutMs ?? 5_000;
  const now = options.now ?? Date.now;

  type Catalog = ReadonlyMap<string, OpenRouterModelInfo>;
  let cached: { catalog: Catalog; expiresAt: number } | null = null;
  let inFlight: Promise<Catalog | null> | null = null;

  async function fetchCatalog(): Promise<Catalog | null> {
    try {
      const res = await doFetch(OPENROUTER_MODELS_URL, {
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(requestTimeoutMs),
      });
      if (!res.ok) return null;
      const body = catalogResponseSchema.safeParse(await res.json());
      if (!body.success) return null;
      const catalog = new Map<string, OpenRouterModelInfo>();
      for (const row of body.data.data) {
        const info = toModelInfo(row);
        if (info !== null) catalog.set(info.id, info);
      }
      // An empty catalog is indistinguishable from a broken response — treat
      // it as unavailable rather than rejecting every model id.
      if (catalog.size === 0) return null;
      cached = { catalog, expiresAt: now() + cacheTtlMs };
      return catalog;
    } catch {
      return null; // fail OPEN — advisory check only
    }
  }

  return async () => {
    if (cached !== null && cached.expiresAt > now()) return cached.catalog;
    if (inFlight === null) {
      inFlight = fetchCatalog().finally(() => {
        inFlight = null;
      });
    }
    return inFlight;
  };
}

/**
 * Catalog row for `modelId`, or undefined when the catalog does not list it.
 * Variant suffixes (`:free`, `:extended`, `:nitro`, …) are usually listed as
 * their own catalog entries, but when the exact variant is absent the BASE id
 * is used instead — fail-safe towards allowing (and towards reporting the
 * base model's capabilities, which a variant shares).
 */
export function catalogModelInfo(
  catalog: ReadonlyMap<string, OpenRouterModelInfo>,
  modelId: string,
): OpenRouterModelInfo | undefined {
  const exact = catalog.get(modelId);
  if (exact !== undefined) return exact;
  const variantSeparator = modelId.indexOf(":");
  return variantSeparator > 0
    ? catalog.get(modelId.slice(0, variantSeparator))
    : undefined;
}

/** Is `modelId` known to the catalog? (Same variant rule as above.) */
export function catalogHasModel(
  catalog: ReadonlyMap<string, OpenRouterModelInfo>,
  modelId: string,
): boolean {
  return catalogModelInfo(catalog, modelId) !== undefined;
}
