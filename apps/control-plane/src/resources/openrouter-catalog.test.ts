import { describe, expect, test } from "bun:test";

import {
  catalogHasModel,
  createOpenRouterCatalog,
  OPENROUTER_MODELS_URL,
} from "./openrouter-catalog";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("createOpenRouterCatalog", () => {
  test("fetches the public models endpoint once and caches the ids", async () => {
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
});

describe("catalogHasModel", () => {
  const ids = new Set(["deepseek/deepseek-v4-flash", "openai/gpt-5.2:extended"]);

  test("exact ids and exact variant ids match", () => {
    expect(catalogHasModel(ids, "deepseek/deepseek-v4-flash")).toBeTrue();
    expect(catalogHasModel(ids, "openai/gpt-5.2:extended")).toBeTrue();
  });

  test("an unlisted variant of a listed base id is accepted (fail-safe towards allowing)", () => {
    expect(catalogHasModel(ids, "deepseek/deepseek-v4-flash:nitro")).toBeTrue();
  });

  test("unknown ids are rejected", () => {
    expect(catalogHasModel(ids, "zai/glm-5.2")).toBeFalse();
    expect(catalogHasModel(ids, "openai/gpt-5.2")).toBeFalse();
  });
});
