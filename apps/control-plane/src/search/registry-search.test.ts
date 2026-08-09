/**
 * Meilisearch-backed community search tests.
 *
 * The gated suite (MEILISEARCH_URL + MEILISEARCH_MASTER_KEY) seeds the
 * disposable `mcp_registry` index through Task 8's mapper — the exact
 * documents the sync ETL would write — and asserts ranking (`verified:desc`
 * tie-break), typo tolerance (the reason Meilisearch exists), and
 * limit/offset pagination. The ungated suite pins the typed degradation:
 * no client ⇒ 503 `search_unavailable`, never a crash.
 */
import { beforeAll, describe, expect, test } from "bun:test";

import { RuntimeApiError } from "../runtime/errors";
import {
  createMeiliClient,
  ensureRegistryIndex,
  REGISTRY_INDEX,
  type MeiliClient,
} from "./meili";
import { syncEntryToAction, type RegistryDocument } from "./registry-docs";
import { searchRegistry } from "./registry-search";

const MEILISEARCH_URL = process.env.MEILISEARCH_URL;
const MEILISEARCH_MASTER_KEY = process.env.MEILISEARCH_MASTER_KEY;
const gated = Boolean(MEILISEARCH_URL && MEILISEARCH_MASTER_KEY);

if (!gated) {
  console.warn(
    "[registry-search] MEILISEARCH_URL/MEILISEARCH_MASTER_KEY not set — skipping meili-backed search tests",
  );
}

describe("searchRegistry degradation (no client configured)", () => {
  test("null client throws a typed 503 search_unavailable", async () => {
    const err = await searchRegistry(null, "linear", {}).catch((e) => e);
    expect(err).toBeInstanceOf(RuntimeApiError);
    const apiError = err as RuntimeApiError;
    expect(apiError.status).toBe(503);
    expect(apiError.code).toBe("search_unavailable");
    // The exact wire body the route answers with (the SPA keys off the code).
    expect(apiError.toBody().error.code).toBe("search_unavailable");
  });
});

/** One upstream /v0.1/servers row, mirroring the real list shape. */
function upstreamEntry(
  over: Record<string, unknown>,
  meta: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    server: {
      name: "app.linear/linear",
      title: "Linear",
      description: "Linear issue tracking MCP",
      version: "1.0.1",
      remotes: [
        {
          type: "streamable-http",
          url: "https://mcp.linear.app/mcp",
          headers: [{ name: "Authorization", isRequired: true, isSecret: true }],
        },
      ],
      ...over,
    },
    _meta: {
      "io.modelcontextprotocol.registry/official": {
        status: "active",
        isLatest: true,
        ...meta,
      },
    },
  };
}

/** Run an entry through the sync mapper and demand an upsert doc. */
function docOf(entry: Record<string, unknown>): RegistryDocument {
  const action = syncEntryToAction(entry);
  if (action.kind !== "upsert") {
    throw new Error(`fixture entry did not map to an upsert (${action.kind})`);
  }
  return action.doc;
}

describe.skipIf(!gated)("searchRegistry against a live index", () => {
  let meili: MeiliClient;

  beforeAll(async () => {
    meili = createMeiliClient({
      url: MEILISEARCH_URL!,
      apiKey: MEILISEARCH_MASTER_KEY!,
    });
    // Disposable index: reset so this suite owns exactly its three docs.
    await meili.deleteIndexIfExists(REGISTRY_INDEX);
    await ensureRegistryIndex(meili);
    const docs = [
      // Identical searchable text on the two "Linear" docs makes every
      // relevancy rule tie — verified:desc (the LAST ranking rule) must
      // decide the order, which is exactly what this suite pins.
      docOf(upstreamEntry({})),
      docOf(
        upstreamEntry({
          name: "io.github.someone/linear-fork",
          title: "Linear",
          description: "Linear issue tracking MCP",
          remotes: [
            { type: "streamable-http", url: "https://fork.example.com/mcp" },
          ],
        }),
      ),
      docOf(
        upstreamEntry({
          name: "com.sentry/sentry",
          title: "Sentry",
          description: "Error monitoring",
          remotes: [{ type: "streamable-http", url: "https://mcp.sentry.dev/mcp" }],
        }),
      ),
    ];
    const task = await meili
      .index(REGISTRY_INDEX)
      .addDocuments(docs)
      .waitTask({ timeout: 30_000 });
    expect(task.status).toBe("succeeded");
  }, 60_000);

  test("matches both linear docs, verified first, and excludes sentry", async () => {
    const { results, total } = await searchRegistry(meili, "linear", {});
    const names = results.map((r) => r.name);
    expect(names).toContain("app.linear/linear");
    expect(names).toContain("io.github.someone/linear-fork");
    expect(names).not.toContain("com.sentry/sentry");
    expect(total).toBe(2);

    // verified:desc breaks the full-relevancy tie in favor of the
    // domain-verified publisher.
    expect(results[0]!.name).toBe("app.linear/linear");
    expect(results[0]!.verified).toBe(true);
    expect(results[1]!.verified).toBe(false);

    // DTO shape: trimmed to the community-search contract — the meili
    // document id never reaches the wire.
    expect(results[0]).toEqual({
      name: "app.linear/linear",
      title: "Linear",
      description: "Linear issue tracking MCP",
      verified: true,
      remotes: [
        {
          type: "streamable-http",
          url: "https://mcp.linear.app/mcp",
          headers: [{ name: "Authorization", isRequired: true, isSecret: true }],
        },
      ],
    });
  });

  test("typo query still finds the linear docs (typo tolerance)", async () => {
    const { results } = await searchRegistry(meili, "linaer", {});
    const names = results.map((r) => r.name);
    expect(names).toContain("app.linear/linear");
    expect(names).toContain("io.github.someone/linear-fork");
  });

  test("limit/offset paginate", async () => {
    const page1 = await searchRegistry(meili, "linear", { limit: 1 });
    expect(page1.results).toHaveLength(1);
    expect(page1.total).toBeGreaterThanOrEqual(2);

    const page2 = await searchRegistry(meili, "linear", { limit: 1, offset: 1 });
    expect(page2.results).toHaveLength(1);
    expect(page2.results[0]!.name).not.toBe(page1.results[0]!.name);
  });

  test("out-of-range paging inputs are clamped, not errors", async () => {
    // limit clamps into [1, 50]; offset floors at 0.
    const clamped = await searchRegistry(meili, "linear", {
      limit: 10_000,
      offset: -5,
    });
    expect(clamped.results.length).toBeGreaterThanOrEqual(2);
  });
});
