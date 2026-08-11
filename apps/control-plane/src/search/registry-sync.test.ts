/**
 * Registry→Meilisearch sync ETL tests — full-then-incremental paging against
 * an in-process stub registry, cursor advance only on full success, and
 * advisory-lock single-runner semantics. Gated on BOTH a real Postgres
 * (TEST_DATABASE_URL) and a live Meilisearch (MEILISEARCH_URL +
 * MEILISEARCH_MASTER_KEY); skips cleanly in the unit lane.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { eq } from "drizzle-orm";
import { schema } from "@invisible-string/db";

import { createDb, type DbHandle } from "../db";
import { createLogger } from "../log";
import { runMigrations } from "../migrate";
import { createMeiliClient, REGISTRY_INDEX, type MeiliClient } from "./meili";
import { registryDocId, type RegistryDocument } from "./registry-docs";
import { createRegistrySync } from "./registry-sync";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const MEILISEARCH_URL = process.env.MEILISEARCH_URL;
const MEILISEARCH_MASTER_KEY = process.env.MEILISEARCH_MASTER_KEY;
const gated = Boolean(TEST_DATABASE_URL && MEILISEARCH_URL && MEILISEARCH_MASTER_KEY);

if (!gated) {
  console.warn(
    "[registry-sync] TEST_DATABASE_URL/MEILISEARCH_URL/MEILISEARCH_MASTER_KEY not set — skipping registry sync tests",
  );
}

/** One upstream /v0.1/servers row, mirroring the real list shape. */
function upstreamEntry(
  over: Record<string, unknown>,
  meta: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    server: {
      name: "app.linear/linear",
      description: "Linear MCP",
      version: "1.0.1",
      remotes: [{ type: "streamable-http", url: "https://mcp.linear.app/mcp" }],
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

describe.skipIf(!gated)("registry sync ETL", () => {
  let handle: DbHandle;
  let meili: MeiliClient;
  let server: ReturnType<typeof Bun.serve>;
  let baseUrl: string;

  const logger = createLogger({ sink: () => {}, minLevel: "error" });

  /** Mutable stub behaviour, reset per test. */
  const stub = {
    /** Every /v0.1/servers request URL the stub saw. */
    requests: [] as URL[],
    /** Return 500 on the page-2 (cursor) request. */
    failPage2: false,
    /** Delay before answering page 1 (ms) — widens the concurrency window. */
    delayMs: 0,
  };

  const PAGE2_CURSOR = "cursor-page-2";

  /** Two-page fixture: verified + fork on page 1; stdio-only + deleted on page 2. */
  function pageBody(url: URL): { status: number; body: unknown } {
    const cursor = url.searchParams.get("cursor");
    if (cursor === null) {
      return {
        status: 200,
        body: {
          servers: [
            upstreamEntry({}),
            upstreamEntry({
              name: "io.github.someone/linear-fork",
              description: "A community fork",
              remotes: [
                { type: "streamable-http", url: "https://fork.example.com/mcp" },
              ],
            }),
          ],
          metadata: { nextCursor: PAGE2_CURSOR },
        },
      };
    }
    if (cursor === PAGE2_CURSOR) {
      if (stub.failPage2) return { status: 500, body: { error: "boom" } };
      return {
        status: 200,
        body: {
          servers: [
            // stdio-only: active + latest but zero remotes → must NOT be indexed.
            upstreamEntry({ name: "com.example/stdio-only", remotes: [] }),
            // deleted upstream → must leave (never enter) the index.
            upstreamEntry(
              { name: "com.example/deleted-server" },
              { status: "deleted" },
            ),
          ],
          metadata: {},
        },
      };
    }
    return { status: 404, body: { error: "unknown cursor" } };
  }

  function resetStub(): void {
    stub.requests = [];
    stub.failPage2 = false;
    stub.delayMs = 0;
  }

  async function indexedNames(): Promise<Set<string>> {
    const docs = await meili
      .index<RegistryDocument>(REGISTRY_INDEX)
      .getDocuments({ limit: 100 });
    return new Set(docs.results.map((d) => d.name));
  }

  async function syncStateRow() {
    const rows = await handle.db
      .select()
      .from(schema.registrySyncState)
      .where(eq(schema.registrySyncState.id, "official"));
    return rows[0] ?? null;
  }

  function sync(intervalMs = 60_000) {
    return createRegistrySync({
      db: handle.db,
      meili,
      registryBaseUrl: baseUrl,
      logger,
      intervalMs,
    });
  }

  beforeAll(async () => {
    await runMigrations(TEST_DATABASE_URL!);
    handle = createDb(TEST_DATABASE_URL!, { max: 5 });
    meili = createMeiliClient({
      url: MEILISEARCH_URL!,
      apiKey: MEILISEARCH_MASTER_KEY!,
    });
    // Disposable index + single-row cursor: reset both so this suite always
    // exercises the first-run (full resync) path — which also proves
    // resync-on-empty rebuilds the index from nothing.
    await meili.deleteIndexIfExists(REGISTRY_INDEX);
    await handle.db
      .delete(schema.registrySyncState)
      .where(eq(schema.registrySyncState.id, "official"));

    server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname !== "/v0.1/servers") {
          return Response.json({ error: "not found" }, { status: 404 });
        }
        stub.requests.push(url);
        if (stub.delayMs > 0) await Bun.sleep(stub.delayMs);
        const { status, body } = pageBody(url);
        return Response.json(body, { status });
      },
    });
    baseUrl = `http://localhost:${server.port}`;
  }, 60_000);

  afterAll(async () => {
    server?.stop(true);
    if (handle) {
      await handle.db
        .delete(schema.registrySyncState)
        .where(eq(schema.registrySyncState.id, "official"));
      await handle.close();
    }
  });

  test("first run: full sync pages to the end and indexes installable docs only", async () => {
    resetStub();
    const outcome = await sync().runOnce();
    expect(outcome).toMatchObject({ ran: true, pages: 2 });
    expect(outcome.upserted).toBe(2);

    const names = await indexedNames();
    expect(names).toEqual(
      new Set(["app.linear/linear", "io.github.someone/linear-fork"]),
    );
    // The deleted + stdio-only entries never entered the index.
    expect(names.has("com.example/deleted-server")).toBe(false);
    expect(names.has("com.example/stdio-only")).toBe(false);

    const state = await syncStateRow();
    expect(state?.lastUpdatedSince).not.toBeNull();
    expect(state?.lastSyncedAt).not.toBeNull();

    // The full first run sent no incremental params.
    expect(stub.requests.length).toBe(2);
    expect(stub.requests[0]!.searchParams.get("updated_since")).toBeNull();
    expect(stub.requests[0]!.searchParams.get("version")).toBe("latest");
  });

  test("second run: sends updated_since from the stored cursor (+ include_deleted)", async () => {
    resetStub();
    const before = await syncStateRow();
    expect(before?.lastUpdatedSince).not.toBeNull();

    const outcome = await sync().runOnce();
    expect(outcome.ran).toBe(true);

    const first = stub.requests[0]!;
    expect(first.searchParams.get("updated_since")).toBe(
      before!.lastUpdatedSince!.toISOString(),
    );
    expect(first.searchParams.get("include_deleted")).toBe("true");
  });

  test("a failing page aborts the run: cursor NOT advanced, index untouched", async () => {
    resetStub();
    stub.failPage2 = true;
    const before = await syncStateRow();

    expect(sync().runOnce()).rejects.toThrow();

    const after = await syncStateRow();
    expect(after?.lastUpdatedSince?.toISOString()).toBe(
      before!.lastUpdatedSince!.toISOString(),
    );
    // Docs indexed by the earlier successful run are still there.
    const names = await indexedNames();
    expect(names.has("app.linear/linear")).toBe(true);
    expect(names.has(registryDocId("app.linear/linear"))).toBe(false); // sanity: names, not ids
  });

  test("two concurrent runs: the advisory lock lets exactly one run", async () => {
    resetStub();
    stub.delayMs = 150; // hold the winner inside its run while the loser tries
    const s = sync();
    const [a, b] = await Promise.all([s.runOnce(), s.runOnce()]);
    expect([a.ran, b.ran].filter(Boolean)).toHaveLength(1);
  });
});
