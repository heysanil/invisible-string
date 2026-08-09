import { describe, expect, test } from "bun:test";

import {
  catalogHasModel,
  catalogModelInfo,
  createOpenRouterCatalog,
  OPENROUTER_MODELS_URL,
  type OpenRouterModelInfo,
} from "./openrouter-catalog";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

/** Catalog map from bare ids (capabilities irrelevant to the lookup tests). */
function catalogOf(...ids: string[]): ReadonlyMap<string, OpenRouterModelInfo> {
  return new Map(ids.map((id) => [id, { id, supportedEfforts: [] }]));
}

describe("createOpenRouterCatalog", () => {
  test("fetches the public models endpoint once and caches the catalog", async () => {
    let fetches = 0;
    const catalog = createOpenRouterCatalog({
      fetchImpl: (async (url: string | URL | Request) => {
        fetches += 1;
        expect(String(url)).toBe(OPENROUTER_MODELS_URL);
        return jsonResponse({
          data: [{ id: "deepseek/deepseek-v4-flash" }, { id: "z-ai/glm-5.2" }],
        });
      }) as unknown as typeof fetch,
    });
    const first = await catalog();
    const second = await catalog();
    expect(fetches).toBe(1);
    expect(first).not.toBeNull();
    expect(first!.has("z-ai/glm-5.2")).toBeTrue();
    expect(second).toBe(first!);
  });

  test("refetches after the cache TTL lapses", async () => {
    let clock = 0;
    let calls = 0;
    const catalog = createOpenRouterCatalog({
      cacheTtlMs: 1_000,
      now: () => clock,
      fetchImpl: (async () => {
        calls += 1;
        return jsonResponse({ data: [{ id: "vendor/model" }] });
      }) as unknown as typeof fetch,
    });
    await catalog();
    clock = 500;
    await catalog();
    expect(calls).toBe(1);
    clock = 1_500;
    await catalog();
    expect(calls).toBe(2);
  });

  test("fails OPEN (null) on network error, non-200, and malformed/empty bodies — never rejects", async () => {
    const cases: (() => Promise<Response>)[] = [
      async () => {
        throw new DOMException("timeout", "TimeoutError");
      },
      async () => new Response("upstream sad", { status: 503 }),
      async () => new Response("not json", { status: 200 }),
      async () => jsonResponse({ nope: true }),
      async () => jsonResponse({ data: "not an array" }),
      async () => jsonResponse({ data: [] }),
    ];
    for (const impl of cases) {
      const catalog = createOpenRouterCatalog({ fetchImpl: impl as unknown as typeof fetch });
      expect(await catalog()).toBeNull();
    }
  });

  test("a failed fetch is not cached — the next call retries", async () => {
    let calls = 0;
    const catalog = createOpenRouterCatalog({
      fetchImpl: (async () => {
        calls += 1;
        if (calls === 1) throw new Error("offline");
        return jsonResponse({ data: [{ id: "vendor/model" }] });
      }) as unknown as typeof fetch,
    });
    expect(await catalog()).toBeNull();
    const retried = await catalog();
    expect(retried).not.toBeNull();
    expect(retried!.has("vendor/model")).toBeTrue();
  });

  test("parses capabilities: context window, supported efforts, default effort", async () => {
    const catalog = createOpenRouterCatalog({
      fetchImpl: (async () =>
        jsonResponse({
          data: [
            {
              id: "moonshotai/kimi-k3",
              context_length: 1_048_576,
              // Upstream order is DESCENDING; it is preserved here (clients sort).
              reasoning: {
                supported_efforts: ["max", "high", "low"],
                default_effort: "high",
              },
            },
            { id: "vendor/no-reasoning", context_length: 128_000 },
          ],
        })) as unknown as typeof fetch,
    });
    const models = await catalog();
    expect(models).not.toBeNull();
    expect(models!.get("moonshotai/kimi-k3")).toEqual({
      id: "moonshotai/kimi-k3",
      contextWindowTokens: 1_048_576,
      supportedEfforts: ["max", "high", "low"],
      defaultEffort: "high",
    });
    // A listed model with no reasoning block advertises NO efforts — which is
    // still knowledge, distinct from an absent entry (unknown).
    expect(models!.get("vendor/no-reasoning")).toEqual({
      id: "vendor/no-reasoning",
      contextWindowTokens: 128_000,
      supportedEfforts: [],
    });
  });

  test("hostile/degenerate metadata is dropped, never propagated", async () => {
    const catalog = createOpenRouterCatalog({
      fetchImpl: (async () =>
        jsonResponse({
          data: [
            // Bad rows must not void the whole catalog…
            { nope: "no id" },
            { id: 42 },
            {
              id: "vendor/messy",
              context_length: -1, // non-positive → dropped
              reasoning: {
                supported_efforts: ["high", "high", "ludicrous", "provider-default"],
                default_effort: "max", // not in the supported set → dropped
              },
            },
            {
              id: "vendor/garbage-context",
              context_length: "1000000",
              reasoning: { supported_efforts: "high" },
            },
          ],
        })) as unknown as typeof fetch,
    });
    const models = await catalog();
    expect(models).not.toBeNull();
    expect(models!.size).toBe(2);
    // De-duplicated, unknown levels filtered, and `provider-default` (the
    // PLATFORM's "send no reasoning field" value) never offered as a model
    // capability.
    expect(models!.get("vendor/messy")).toEqual({
      id: "vendor/messy",
      supportedEfforts: ["high"],
    });
    // Metadata degrades to absent; the model itself stays allowlistable.
    expect(models!.get("vendor/garbage-context")).toEqual({
      id: "vendor/garbage-context",
      supportedEfforts: [],
    });
  });
});

describe("catalogHasModel / catalogModelInfo", () => {
  const catalog = catalogOf("deepseek/deepseek-v4-flash", "openai/gpt-5.2:extended");

  test("exact ids and exact variant ids match", () => {
    expect(catalogHasModel(catalog, "deepseek/deepseek-v4-flash")).toBeTrue();
    expect(catalogHasModel(catalog, "openai/gpt-5.2:extended")).toBeTrue();
  });

  test("an unlisted variant of a listed base id is accepted (fail-safe towards allowing)", () => {
    expect(catalogHasModel(catalog, "deepseek/deepseek-v4-flash:nitro")).toBeTrue();
  });

  test("unknown ids are rejected", () => {
    expect(catalogHasModel(catalog, "zai/glm-5.2")).toBeFalse();
    expect(catalogHasModel(catalog, "openai/gpt-5.2")).toBeFalse();
  });

  test("`~`-prefixed -latest alias ids are ordinary catalog keys", () => {
    const aliases = catalogOf("~deepseek/deepseek-v4-flash-latest");
    expect(catalogHasModel(aliases, "~deepseek/deepseek-v4-flash-latest")).toBeTrue();
    expect(catalogHasModel(aliases, "deepseek/deepseek-v4-flash-latest")).toBeFalse();
  });

  test("a variant inherits the BASE model's capabilities", () => {
    const withEfforts = new Map<string, OpenRouterModelInfo>([
      [
        "vendor/model",
        { id: "vendor/model", supportedEfforts: ["max", "low"], defaultEffort: "low" },
      ],
    ]);
    expect(catalogModelInfo(withEfforts, "vendor/model:nitro")?.supportedEfforts).toEqual([
      "max",
      "low",
    ]);
    expect(catalogModelInfo(withEfforts, "other/model")).toBeUndefined();
  });
});
