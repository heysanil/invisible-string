/**
 * `tool` step executor. Two halves, mirroring the session-titler suite:
 *
 * - the PURE pieces run ungated: structural pre-flight against a cached
 *   schema, the malformed-input guards (both hit before any DB read);
 * - the executor itself needs a real `connections` row, so it is DB-gated
 *   (skips cleanly without TEST_DATABASE_URL) and dials the probe suite's
 *   in-process MCP fixture through the real guarded egress fetch
 *   (`allowPrivate: true` — exactly how dev/e2e run MCP traffic).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import type { AddressInfo, Socket } from "node:net";
import { randomUUID } from "node:crypto";

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { eq } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@invisible-string/db";
import { newStepId, type PipelineStep, type ToolStep } from "@invisible-string/shared";

import { createDb, type Db, type DbHandle } from "../../db";
import { createLogger } from "../../log";
import { runMigrations } from "../../migrate";
import { createGuardedFetch } from "../../net/guarded-fetch";
import type { StepExecuteContext } from "../types";
import { executeToolStep, preflightToolArgs } from "./tool";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const guardedFetch = createGuardedFetch({ allowPrivate: true });
const logger = createLogger({ sink: () => {}, minLevel: "error" });

// ── pure: pre-flight (ungated) ───────────────────────────────────────────────

describe("preflightToolArgs", () => {
  const cached = {
    type: "object",
    required: ["note"],
    properties: {
      note: { type: "string" },
      count: { type: "integer" },
      tags: { type: "array" },
      meta: { type: "object" },
      loose: {}, // no type keyword — no opinion
    },
  };

  test("passes matching args, including untyped and extra ones", () => {
    expect(
      preflightToolArgs(cached, {
        note: "hi",
        count: 3,
        tags: [],
        meta: {},
        loose: Symbol("anything") as unknown,
        extra: "servers may accept more than the cache knows",
      }),
    ).toEqual([]);
  });

  test("flags a missing required argument", () => {
    expect(preflightToolArgs(cached, {})).toEqual([
      'missing required argument "note"',
    ]);
  });

  test("flags primitive type mismatches, one problem per argument", () => {
    const problems = preflightToolArgs(cached, {
      note: 42,
      count: 1.5,
      tags: "not-an-array",
      meta: null,
    });
    expect(problems).toEqual([
      'argument "note" must be a string (got number)',
      'argument "count" must be an integer (got number)',
      'argument "tags" must be an array (got string)',
      'argument "meta" must be an object (got null)',
    ]);
  });
});

// ── shared fixture helpers (the probe suite's pattern) ───────────────────────

/** A large-but-parseable JSON payload for the output_too_large case. */
const HUGE_JSON = JSON.stringify({ blob: "x".repeat(300_000) });

function buildFixtureMcpServer(): McpServer {
  const server = new McpServer({ name: "tool-step-fixture", version: "1.0.0" });
  server.registerTool(
    "save_note",
    { description: "Save a short note.", inputSchema: { note: z.string() } },
    async ({ note }) => ({
      content: [{ type: "text", text: `note saved: ${note}` }],
    }),
  );
  server.registerTool(
    "lookup",
    {
      description: "Structured answer.",
      inputSchema: { q: z.string() },
      outputSchema: { answer: z.string() },
    },
    async ({ q }) => ({
      content: [{ type: "text", text: `answer for ${q}` }],
      structuredContent: { answer: `answer for ${q}` },
    }),
  );
  server.registerTool(
    "json_reply",
    { description: "Single text part carrying JSON.", inputSchema: {} },
    async () => ({
      content: [{ type: "text", text: '{"items":[1,2,3]}' }],
    }),
  );
  server.registerTool(
    "huge_reply",
    { description: "Oversized structured payload.", inputSchema: {} },
    async () => ({ content: [{ type: "text", text: HUGE_JSON }] }),
  );
  server.registerTool(
    "always_fails",
    { description: "Tool-level error.", inputSchema: {} },
    async () => ({
      content: [{ type: "text", text: "downstream exploded" }],
      isError: true,
    }),
  );
  return server;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length > 0 ? JSON.parse(raw) : undefined;
}

interface Fixture {
  url: string;
  close(): Promise<void>;
}

async function serveFixture(): Promise<Fixture> {
  const server = createServer((req, res) => {
    void (async () => {
      const mcp = buildFixtureMcpServer();
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // stateless
      });
      res.on("close", () => {
        void transport.close();
        void mcp.close();
      });
      await mcp.connect(transport);
      let body: unknown;
      try {
        body = req.method === "POST" ? await readJsonBody(req) : undefined;
      } catch {
        body = undefined;
      }
      await transport.handleRequest(req, res, body);
    })();
  });
  const sockets = new Set<Socket>();
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  await new Promise<void>((resolve) =>
    server.listen(0, "127.0.0.1", () => resolve()),
  );
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

function toolStep(overrides: Partial<ToolStep> = {}): ToolStep {
  return {
    id: newStepId(),
    slug: "call",
    kind: "tool",
    connectionId: "",
    tool: "save_note",
    args: {},
    sideEffect: "at_least_once",
    ...overrides,
  };
}

function contextFor(
  db: Db,
  orgId: string,
  step: PipelineStep,
  input: unknown,
): StepExecuteContext {
  return {
    deps: {
      db,
      logger,
      masterKey: undefined,
      fetchImpl: guardedFetch,
      // The re-probe resolves credentials through the broker (an oauth row's
      // token lives behind `getAccessToken`), so the fixture wires one even
      // though every row here carries static auth.
      oauthTokens: {
        db,
        masterKey: undefined,
        publicAppUrl: "http://localhost:3000",
        fetchImpl: guardedFetch,
        logger,
      },
    },
    orgId,
    run: { id: `run-${randomUUID()}`, workflowId: `wf-${randomUUID()}` },
    step,
    input,
    scope: { trigger: {}, steps: {}, state: {}, now: new Date().toISOString() },
    signal: new AbortController().signal,
    attempt: 1,
    path: step.id,
  };
}

// ── ungated: guards that fire before any DB read ─────────────────────────────

describe("executeToolStep guards", () => {
  const poisonedDb = null as unknown as Db;

  test("a non-tool step fails internal", async () => {
    const step: PipelineStep = {
      id: newStepId(),
      slug: "gate",
      kind: "filter",
      where: { truthy: true },
    };
    const outcome = await executeToolStep(
      contextFor(poisonedDb, "org", step, { args: {} }),
    );
    expect(outcome).toMatchObject({
      status: "failed",
      errorClass: "internal",
      retryable: false,
    });
  });

  test("malformed rendered input fails internal", async () => {
    const outcome = await executeToolStep(
      contextFor(poisonedDb, "org", toolStep(), "not-an-args-record"),
    );
    expect(outcome).toMatchObject({
      status: "failed",
      errorClass: "internal",
      retryable: false,
    });
  });
});

// ── DB-gated: the executor against a live row + fixture ──────────────────────

if (!TEST_DATABASE_URL) {
  console.warn(
    "[pipeline-tool] TEST_DATABASE_URL not set — skipping tool-step executor tests",
  );
}

describe.skipIf(!TEST_DATABASE_URL)("executeToolStep", () => {
  let handle: DbHandle;
  let fixture: Fixture;
  let orgId: string;
  let otherOrgId: string;
  let connectionId: string;

  async function insertConnection(
    overrides: Partial<typeof schema.connections.$inferInsert> = {},
  ): Promise<string> {
    const id = `cn_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    await handle.db.insert(schema.connections).values({
      id,
      scope: "workspace",
      organizationId: orgId,
      name: `Notes ${id}`,
      source: "custom",
      url: fixture.url,
      transport: "streamable-http",
      authType: "none",
      enabled: true,
      ...overrides,
    });
    return id;
  }

  beforeAll(async () => {
    await runMigrations(TEST_DATABASE_URL!);
    handle = createDb(TEST_DATABASE_URL!, { max: 2 });
    fixture = await serveFixture();
    orgId = `org-ptool-${randomUUID()}`;
    otherOrgId = `org-ptool-b-${randomUUID()}`;
    for (const id of [orgId, otherOrgId]) {
      await handle.db.insert(schema.organization).values({
        id,
        name: `Tool Step Org ${id}`,
        slug: id,
        createdAt: new Date(),
      });
    }
    connectionId = await insertConnection();
  }, 30_000);

  afterAll(async () => {
    await handle?.db
      .delete(schema.organization)
      .where(eq(schema.organization.id, orgId));
    await handle?.db
      .delete(schema.organization)
      .where(eq(schema.organization.id, otherOrgId));
    await fixture?.close();
    await handle?.close();
  }, 15_000);

  test("happy path: text reply → { result: null, text, isError: false }", async () => {
    const step = toolStep({ connectionId });
    const outcome = await executeToolStep(
      contextFor(handle.db, orgId, step, { args: { note: "hello" } }),
    );
    expect(outcome).toEqual({
      status: "succeeded",
      output: { result: null, text: "note saved: hello", isError: false },
    });
  });

  test("structuredContent wins as the result", async () => {
    const step = toolStep({ connectionId, tool: "lookup" });
    const outcome = await executeToolStep(
      contextFor(handle.db, orgId, step, { args: { q: "life" } }),
    );
    expect(outcome).toMatchObject({
      status: "succeeded",
      output: {
        result: { answer: "answer for life" },
        text: "answer for life",
      },
    });
  });

  test("a single text part that parses as JSON becomes the result", async () => {
    const step = toolStep({ connectionId, tool: "json_reply" });
    const outcome = await executeToolStep(
      contextFor(handle.db, orgId, step, { args: {} }),
    );
    expect(outcome).toMatchObject({
      status: "succeeded",
      output: { result: { items: [1, 2, 3] } },
    });
  });

  test("an oversized structured result fails output_too_large", async () => {
    const step = toolStep({ connectionId, tool: "huge_reply" });
    const outcome = await executeToolStep(
      contextFor(handle.db, orgId, step, { args: {} }),
    );
    expect(outcome).toMatchObject({
      status: "failed",
      errorClass: "output_too_large",
      retryable: false,
    });
  });

  test("isError → tool_error, never retryable", async () => {
    const step = toolStep({ connectionId, tool: "always_fails" });
    const outcome = await executeToolStep(
      contextFor(handle.db, orgId, step, { args: {} }),
    );
    expect(outcome).toMatchObject({
      status: "failed",
      errorClass: "tool_error",
      retryable: false,
    });
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.error).toContain("downstream exploded");
  });

  test("unknown tool → config_error, and a fire-and-forget re-probe refreshes the cache", async () => {
    const id = await insertConnection(); // dedicated row: the re-probe writes it
    const step = toolStep({ connectionId: id, tool: "nope" });
    const outcome = await executeToolStep(
      contextFor(handle.db, orgId, step, { args: {} }),
    );
    expect(outcome).toMatchObject({
      status: "failed",
      errorClass: "config_error",
      retryable: false,
    });

    // The re-probe is fire-and-forget — poll for its persisted outcome.
    const deadline = Date.now() + 5_000;
    let row: typeof schema.connections.$inferSelect | undefined;
    while (Date.now() < deadline) {
      const rows = await handle.db
        .select()
        .from(schema.connections)
        .where(eq(schema.connections.id, id));
      row = rows[0];
      if (row?.toolsCachedAt) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(row?.health).toBe("ok");
    expect(row?.toolsCache?.map((tool) => tool.name)).toContain("save_note");
  }, 15_000);

  test("cached inputSchema pre-flights args → invalid_args without dialing", async () => {
    const id = await insertConnection({
      // A cache row the pipeline probe wrote: schema present.
      toolsCache: [
        {
          name: "save_note",
          description: "Save a short note.",
          params: ["note"],
          inputSchema: {
            type: "object",
            required: ["note"],
            properties: { note: { type: "string" } },
          },
        } as never,
      ],
      toolsCachedAt: new Date(),
      // A dead URL proves the pre-flight rejected BEFORE dialing.
      url: "http://127.0.0.1:9/mcp",
    });
    const step = toolStep({ connectionId: id });
    const outcome = await executeToolStep(
      contextFor(handle.db, orgId, step, { args: { note: 42 } }),
    );
    expect(outcome).toMatchObject({
      status: "failed",
      errorClass: "invalid_args",
      retryable: false,
    });
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.error).toContain('"note"');
  });

  test("a pre-pipeline cache row (no inputSchema) is a miss — the call proceeds", async () => {
    const id = await insertConnection({
      toolsCache: [
        { name: "save_note", description: "Save a short note.", params: ["note"] },
      ],
      toolsCachedAt: new Date(),
    });
    const step = toolStep({ connectionId: id });
    const outcome = await executeToolStep(
      contextFor(handle.db, orgId, step, { args: { note: "old cache" } }),
    );
    expect(outcome).toMatchObject({
      status: "succeeded",
      output: { text: "note saved: old cache" },
    });
  });

  test("a connection in another workspace is not found — config_error", async () => {
    const outcome = await executeToolStep(
      contextFor(handle.db, otherOrgId, toolStep({ connectionId }), {
        args: { note: "x" },
      }),
    );
    expect(outcome).toMatchObject({
      status: "failed",
      errorClass: "config_error",
      retryable: false,
    });
  });

  test("a disabled connection fails config_error", async () => {
    const id = await insertConnection({ enabled: false });
    const outcome = await executeToolStep(
      contextFor(handle.db, orgId, toolStep({ connectionId: id }), {
        args: { note: "x" },
      }),
    );
    expect(outcome).toMatchObject({
      status: "failed",
      errorClass: "config_error",
      retryable: false,
    });
  });

  test("tool filters bind pipeline steps too", async () => {
    const allowlisted = await insertConnection({ toolAllow: ["lookup"] });
    const blocked = await insertConnection({ toolBlock: ["save_note"] });
    for (const id of [allowlisted, blocked]) {
      const outcome = await executeToolStep(
        contextFor(handle.db, orgId, toolStep({ connectionId: id }), {
          args: { note: "x" },
        }),
      );
      expect(outcome).toMatchObject({
        status: "failed",
        errorClass: "config_error",
        retryable: false,
      });
    }
  });

  test("an oauth connection without a wired broker fails oauth_not_connected", async () => {
    const id = await insertConnection({ authType: "oauth" });
    const outcome = await executeToolStep(
      contextFor(handle.db, orgId, toolStep({ connectionId: id }), {
        args: { note: "x" },
      }),
    );
    expect(outcome).toMatchObject({
      status: "failed",
      errorClass: "oauth_not_connected",
      retryable: false,
    });
  });
});
