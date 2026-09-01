/**
 * PIPELINE ACCEPTANCE (workflow-pipelines redesign, plan §Verification) — the
 * CANONICAL pipeline end to end against the real control plane, with no agent
 * step and therefore no worker, no compiler, and no eve build anywhere:
 *
 *   every 20 min (schedule trigger, fired by the REAL schedule ticker)
 *     → tool `slack_search` against an in-process stub MCP server
 *       (guarded egress fetch with MCP_PROBE_ALLOW_PRIVATE=1 — the dev/e2e
 *       posture for private MCP targets)
 *     → filter (any new messages?)
 *     → for_each message:
 *         infer (workspace `quick` preset; the OpenRouter wire stubbed via
 *         OPENROUTER_BASE_URL, the titler harness pattern)
 *         → tool `linear_create` back on the stub
 *     → state cursor advance.
 *
 * Proofs, all off real DB/API state:
 *   1. publish syncs the schedule trigger; a forced-due `next_fire_at` is
 *      claimed by the ticker and dispatched as a sessionless
 *      `mode: 'pipeline'` run.
 *   2. the `run_steps` ledger holds one row per step INSTANCE (loop bodies
 *      keyed by `path` + `iteration`), with rendered inputs and capped
 *      outputs (`GET /runs/:id/steps?full=1`).
 *   3. the stub MCP server received the RENDERED args: the literal query,
 *      the missing-cursor "(not provided)" on run 1, and per-item
 *      `{title: <infer output>, permalink: <@item ref>}` — type-preserving
 *      `$ref` resolution and per-item scope isolation.
 *   4. per-item infer outputs persist (`{text, usage}` per iteration).
 *   5. the state cursor advances (`workflow_state` via the state API) and
 *      run 2 renders it back into the search args; the now-empty result
 *      makes the top-level filter fence the rest (`skipped` ledger rows,
 *      run still succeeds) — the cursor-dedupe semantics overlap:"skip"
 *      exists to protect.
 *   6. `pipeline.*` events land in run_events under the run's monotonic seq
 *      (started / step.started / step.completed / state.updated with KEYS
 *      only / completed), and the Runs-tab list API sees both runs.
 *
 * Gated on TEST_DATABASE_URL (the AGENTS.md DB-gated lane; compose's
 * postgres must be up). The suite provisions its OWN product database —
 * it boots a full app stack (Better Auth state, a live schedule ticker),
 * which must not leak into suites sharing the plain TEST database. The
 * workspace-seed publish kick is neutralized with the stub compiler + fake
 * build steps (runtime/integration.test.ts pattern), so nothing here ever
 * shells out to node/eve.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createHash, randomUUID } from "node:crypto";

import { and, eq, sql } from "drizzle-orm";
import { SQL } from "bun";
import { schema, seedWorkspace } from "@invisible-string/db";
import {
  newId,
  newStepId,
  generateMasterKeyBase64,
  type GetWorkflowStateResponse,
  type ListWorkflowRunsResponse,
  type PublishWorkflowResponse,
  type RunStepDetailDto,
  type WorkflowConfigInput,
} from "@invisible-string/shared";

import { createAppStack, type AppStack } from "../../apps/control-plane/src/index";
import { runMigrations } from "../../apps/control-plane/src/migrate";
import { AgentCompileError } from "../../apps/control-plane/src/build/compiler-contract";
import type { CompileAgentFn } from "../../apps/control-plane/src/build/compiler-contract";
import type { BuildSteps } from "../../apps/control-plane/src/build/steps";
import { createMemoryArtifactStore } from "../../apps/control-plane/src/artifacts";
import {
  createScheduleTicker,
  type ScheduleTicker,
} from "../../apps/control-plane/src/runtime/schedule-ticker";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const MASTER_KEY_B64 = generateMasterKeyBase64();

const GATE = Boolean(TEST_DATABASE_URL);
if (!GATE) {
  console.warn("[pipeline-acceptance] skipped: TEST_DATABASE_URL not set");
}

// ── own product database (full stack + live ticker must not share) ──────────

async function ensureFreshProductDatabase(): Promise<string> {
  const name = "pipea_product";
  const admin = new SQL(TEST_DATABASE_URL!, { max: 1 });
  try {
    await admin.unsafe(`drop database if exists "${name}" with (force)`);
    await admin.unsafe(`create database "${name}"`);
  } finally {
    await admin.close();
  }
  const url = new URL(TEST_DATABASE_URL!);
  url.pathname = `/${name}`;
  return url.toString();
}

async function freePort(): Promise<number> {
  const probe = Bun.serve({ port: 0, fetch: () => new Response("") });
  const port = probe.port!;
  probe.stop(true);
  return port;
}

// ── stub compiler + fake build steps (neutralize the seed publish kick) ─────

const stubCompile: CompileAgentFn = (request) => {
  if (request.definition.persona.trim() === "") {
    throw new AgentCompileError([
      { path: "persona", message: "persona must not be empty" },
    ]);
  }
  const hash = createHash("sha256")
    .update(JSON.stringify({ definition: request.definition, agent: request.agentSlug }))
    .digest("hex");
  return {
    files: new Map([["package.json", JSON.stringify({ name: "stub", private: true })]]),
    hash,
    compilerVersion: "stub-compiler-1",
    eveVersion: "0.31.3",
  };
};

const fakeSteps: BuildSteps = {
  async writeFiles() {},
  async install() {},
  async eveBuild() {},
  async provisionWorld() {},
  async packageArtifact(_dir, hash) {
    return new TextEncoder().encode(`fake-tarball-${hash}`);
  },
};

// ── in-process stub MCP server (hand-rolled streamable-HTTP JSON-RPC) ───────
//
// The Slack-search + Linear-create fixtures. `slack_search` answers two new
// messages until it sees a cursor in `after`, then an empty page — exactly
// the dedupe shape the canonical pipeline's state cursor exists for.

const LATEST_CURSOR = "1725100000.000200";
const MESSAGES = [
  {
    text: "first exec mention: budget review is slipping",
    permalink: "https://slack.example/archives/C1/p1",
    ts: "1725100000.000100",
  },
  {
    text: "second exec mention: hiring plan needs sign-off",
    permalink: "https://slack.example/archives/C1/p2",
    ts: LATEST_CURSOR,
  },
];

interface McpStub {
  url: string;
  searchCalls: Record<string, unknown>[];
  createCalls: Record<string, unknown>[];
  stop(): void;
}

function startStubMcp(): McpStub {
  const searchCalls: Record<string, unknown>[] = [];
  const createCalls: Record<string, unknown>[] = [];
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      const body = (await req.json().catch(() => ({}))) as {
        id?: number | string;
        method?: string;
        params?: { name?: string; arguments?: Record<string, unknown> };
      };
      let result: Record<string, unknown> = {};
      if (body.method === "initialize") {
        result = {
          protocolVersion: "2025-03-26",
          capabilities: { tools: {} },
          serverInfo: { name: "stub-canonical", version: "1.0.0" },
        };
      } else if (body.method === "tools/list") {
        result = {
          tools: [
            { name: "slack_search", description: "Search Slack messages", inputSchema: { type: "object" } },
            { name: "linear_create", description: "Create a Linear issue", inputSchema: { type: "object" } },
          ],
        };
      } else if (body.method === "tools/call") {
        const name = body.params?.name;
        const args = body.params?.arguments ?? {};
        if (name === "slack_search") {
          searchCalls.push(args);
          const cursor = typeof args["after"] === "string" ? args["after"] : "";
          const fresh = cursor !== LATEST_CURSOR;
          const page = fresh
            ? { count: MESSAGES.length, latest: LATEST_CURSOR, messages: MESSAGES }
            : { count: 0, latest: LATEST_CURSOR, messages: [] };
          result = {
            content: [{ type: "text", text: JSON.stringify(page) }],
            structuredContent: page,
          };
        } else if (name === "linear_create") {
          createCalls.push(args);
          const issue = { id: `LIN-${createCalls.length}`, url: "https://linear.example/i" };
          result = {
            content: [{ type: "text", text: JSON.stringify(issue) }],
            structuredContent: issue,
          };
        } else {
          return Response.json({
            jsonrpc: "2.0",
            id: body.id,
            error: { code: -32602, message: `unknown tool ${String(name)}` },
          });
        }
      }
      // Notifications (initialized) carry no id — ack without a body.
      if (body.id === undefined) return new Response(null, { status: 202 });
      return Response.json({ jsonrpc: "2.0", id: body.id, result });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}/mcp`,
    searchCalls,
    createCalls,
    stop: () => server.stop(true),
  };
}

// ── stub OpenRouter gateway (the titler/infer wire pattern) ─────────────────

interface GatewayStub {
  baseUrl: string;
  captured: { body: Record<string, unknown> }[];
  stop(): void;
}

function startStubGateway(script: string[]): GatewayStub {
  const captured: { body: Record<string, unknown> }[] = [];
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const body = (await req.json()) as Record<string, unknown>;
      captured.push({ body });
      const content = script[Math.min(captured.length - 1, script.length - 1)]!;
      return Response.json({
        id: "wire",
        object: "chat.completion",
        created: 0,
        model: "wire",
        choices: [
          { index: 0, finish_reason: "stop", message: { role: "assistant", content } },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
      });
    },
  });
  return {
    baseUrl: `http://127.0.0.1:${server.port}/v1`,
    captured,
    stop: () => server.stop(true),
  };
}

// ── polling ─────────────────────────────────────────────────────────────────

async function until<T>(
  fn: () => Promise<T | undefined | false>,
  what: string,
  timeoutMs = 30_000,
  intervalMs = 100,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await fn();
    if (value !== undefined && value !== false) return value as T;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(intervalMs);
  }
}

// ── the suite ───────────────────────────────────────────────────────────────

describe.skipIf(!GATE)("pipeline acceptance — the canonical schedule → tool → filter → for_each(infer → tool) → state pipeline", () => {
  const mcp = GATE ? startStubMcp() : null!;
  const gateway = GATE
    ? startStubGateway(["Budget review is slipping.", "Hiring plan needs sign-off."])
    : null!;

  let stack: AppStack;
  let db: AppStack["dbHandle"]["db"];
  let baseUrl: string;
  let ticker: ScheduleTicker;

  let cookie: string;
  let orgId: string;
  let connectionId: string;
  let workflowId: string;

  const searchStepId = newStepId();
  const gateStepId = newStepId();
  const loopStepId = newStepId();
  const summarizeStepId = newStepId();
  const createStepId = newStepId();
  const advanceStepId = newStepId();

  let firstRunId: string;
  let secondRunId: string;

  async function api(
    method: string,
    path: string,
    options: { body?: unknown } = {},
  ): Promise<Response> {
    return fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
        cookie,
      },
      ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
    });
  }

  /** Force the workflow's schedule trigger due and await its NEW pipeline run. */
  async function fireScheduleAndAwaitRun(previousRunIds: string[]): Promise<string> {
    const triggers = await db
      .select({ id: schema.triggers.id })
      .from(schema.triggers)
      .where(eq(schema.triggers.workflowId, workflowId));
    expect(triggers).toHaveLength(1);
    await db
      .update(schema.triggers)
      .set({ nextFireAt: new Date(Date.now() - 1_000) })
      .where(eq(schema.triggers.id, triggers[0]!.id));

    const runId = await until(
      async () => {
        const rows = await db
          .select({ id: schema.runs.id })
          .from(schema.runs)
          .where(
            and(
              eq(schema.runs.workflowId, workflowId),
              eq(schema.runs.mode, "pipeline"),
            ),
          );
        return rows.map((r) => r.id).find((id) => !previousRunIds.includes(id));
      },
      "schedule-fired pipeline run",
      30_000,
    );
    await until(
      async () => {
        const rows = await db
          .select({ status: schema.runs.status, error: schema.runs.error })
          .from(schema.runs)
          .where(eq(schema.runs.id, runId));
        if (rows[0]?.status === "failed") {
          throw new Error(`pipeline run failed: ${rows[0].error ?? "(no error)"}`);
        }
        return rows[0]?.status === "succeeded" || undefined;
      },
      "pipeline run to succeed",
      60_000,
    );
    return runId;
  }

  async function ledgerOf(runId: string): Promise<RunStepDetailDto[]> {
    const res = await api("GET", `/runs/${runId}/steps?full=1`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { steps: RunStepDetailDto[] };
    return body.steps;
  }

  /**
   * The workflow's persisted state, read the way the runner's own snapshot
   * reads it (`value::text` + one JSON.parse). Reading `workflow_state.value`
   * through drizzle's jsonb mapper double-parses BARE-SCALAR string values
   * (postgres-js already parsed the jsonb, drizzle re-parses any string), so
   * a cursor like "1725100000.000200" would come back as a NUMBER — the same
   * hazard `createDrizzleWorkflowStateStore` documents.
   */
  async function persistedState(): Promise<
    Map<string, { value: unknown; updatedByRunId: string | null }>
  > {
    const rows = await db
      .select({
        key: schema.workflowState.key,
        value: sql<string>`${schema.workflowState.value}::text`,
        updatedByRunId: schema.workflowState.updatedByRunId,
      })
      .from(schema.workflowState)
      .where(eq(schema.workflowState.workflowId, workflowId));
    return new Map(
      rows.map((row) => [
        row.key,
        { value: JSON.parse(row.value) as unknown, updatedByRunId: row.updatedByRunId },
      ]),
    );
  }

  async function eventTypesOf(runId: string): Promise<string[]> {
    const rows = await db
      .select({ seq: schema.runEvents.seq, event: schema.runEvents.event })
      .from(schema.runEvents)
      .where(eq(schema.runEvents.runId, runId))
      .orderBy(schema.runEvents.seq);
    return rows.map((row) => (row.event as { type: string }).type);
  }

  beforeAll(async () => {
    const productDatabaseUrl = await ensureFreshProductDatabase();
    await runMigrations(productDatabaseUrl);

    const controlPort = await freePort();
    baseUrl = `http://localhost:${controlPort}`;
    stack = createAppStack(
      {
        DATABASE_URL: productDatabaseUrl,
        BETTER_AUTH_SECRET: "pipea-better-auth-secret-01234567",
        BETTER_AUTH_URL: baseUrl,
        ENCRYPTION_MASTER_KEY: MASTER_KEY_B64,
        // Runtime config is required for the pipeline runner + ticker, but
        // nothing here builds or boots agents: world/object-store endpoints
        // are never dialed (fake build steps + memory artifacts).
        WORLD_DATABASE_URL: "postgres://unused:unused@localhost:5432/world",
        PLATFORM_JWT_SECRET: "pipea-platform-jwt-secret-0000000",
        WORKER_SHARED_SECRET: "pipea-worker-shared-secret-000000",
        S3_ENDPOINT: "http://localhost:9000",
        S3_ACCESS_KEY_ID: "unused",
        S3_SECRET_ACCESS_KEY: "unused-unused-unused",
        // infer steps ride the platform key against the stubbed wire — the
        // key value is arbitrary, the base URL points every call at the stub.
        OPENROUTER_API_KEY: "pipea-dummy-openrouter-key",
        OPENROUTER_BASE_URL: gateway.baseUrl,
        // Tool steps dial the loopback stub through the guarded egress fetch.
        MCP_PROBE_ALLOW_PRIVATE: "1",
        SCHEDULE_TICK_MS: "250",
        // Keep the suite's output to test results (warn+ still surfaces).
        LOG_LEVEL: "warn",
      },
      { compile: stubCompile, buildSteps: fakeSteps, artifacts: createMemoryArtifactStore() },
    );
    expect(stack.runtime).not.toBeNull();
    expect(stack.pipelines).not.toBeNull();
    db = stack.dbHandle.db;
    stack.app.listen(controlPort);

    // The ticker only auto-starts in the CLI entrypoint; an in-process stack
    // starts its own (phase-3 pattern).
    ticker = createScheduleTicker(stack.runtime!, {
      tickMs: stack.runtime!.runtime.scheduleTickMs,
    });
    ticker.start();

    // Workspace: user + org + seeds (model presets + allowlist for `quick`).
    const email = `pipea-${randomUUID()}@example.com`;
    const signUp = await fetch(`${baseUrl}/api/auth/sign-up/email`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email, password: "correct-horse-battery", name: "Pipeline Acceptance" }),
    });
    expect(signUp.status).toBe(200);
    cookie = signUp.headers
      .getSetCookie()
      .map((c) => c.split(";")[0]!)
      .join("; ");
    const authHeaders = new Headers({ cookie });
    const org = await stack.auth.api.createOrganization({
      body: { name: "Pipeline Acceptance ws", slug: `pipea-${randomUUID().slice(0, 8)}` },
      headers: authHeaders,
    });
    orgId = org!.id;
    await stack.auth.api.setActiveOrganization({
      body: { organizationId: orgId },
      headers: authHeaders,
    });
    await seedWorkspace(db, orgId); // idempotent (afterCreateOrganization already ran)

    // One workspace connection → the stub MCP server. authType "none" (the
    // stub takes no credentials); the cached tool list keeps the publish
    // validator's advisory tools check quiet.
    connectionId = newId("cn");
    await db.insert(schema.connections).values({
      id: connectionId,
      scope: "workspace",
      organizationId: orgId,
      name: "team-slack",
      source: "custom",
      url: mcp.url,
      transport: "streamable-http",
      authType: "none",
      enabled: true,
      toolsCache: [
        { name: "slack_search", description: "Search Slack messages", params: ["query", "after"] },
        { name: "linear_create", description: "Create a Linear issue", params: ["title", "permalink"] },
      ],
      toolsCachedAt: new Date(),
    });
  }, 60_000);

  afterAll(async () => {
    await ticker?.stop();
    await stack?.close();
    stack?.app.stop?.();
    mcp?.stop();
    gateway?.stop();
  }, 30_000);

  test("create + publish the canonical pipeline — instant, trigger row armed", async () => {
    const draft: WorkflowConfigInput = {
      version: 2,
      trigger: { type: "schedule", cron: "*/20 * * * *" },
      steps: [
        {
          id: searchStepId,
          slug: "search",
          kind: "tool",
          connectionId,
          tool: "slack_search",
          args: {
            // A bare string stays LITERAL; interpolation is opt-in via $tpl.
            query: "@team-exec in:#exec",
            after: { $tpl: "@state.cursor" },
          },
        },
        {
          id: gateStepId,
          slug: "gate",
          kind: "filter",
          where: { gt: [{ $ref: "steps.search.result.count" }, 0] },
        },
        {
          id: loopStepId,
          slug: "each_message",
          kind: "for_each",
          items: { $ref: "steps.search.result.messages" },
          maxItems: 10,
          onItemError: "halt",
          steps: [
            {
              id: summarizeStepId,
              slug: "summarize",
              kind: "infer",
              preset: "quick",
              prompt: {
                markdown: "Summarize this team update in one short line:\n\n@item.text",
              },
            },
            {
              id: createStepId,
              slug: "create_issue",
              kind: "tool",
              connectionId,
              tool: "linear_create",
              args: {
                title: { $ref: "steps.summarize.text" },
                permalink: { $ref: "item.permalink" },
              },
            },
          ],
        },
        {
          id: advanceStepId,
          slug: "advance",
          kind: "state",
          set: { cursor: { $ref: "steps.search.result.latest" } },
        },
      ],
    };

    const created = await api("POST", `/workspaces/${orgId}/workflows`, {
      body: { name: "Exec mentions → Linear", draft },
    });
    expect(created.status).toBe(201);
    const createdBody = (await created.json()) as { workflow: { id: string } };
    workflowId = createdBody.workflow.id;

    const published = await api("POST", `/workspaces/${orgId}/workflows/${workflowId}/publish`);
    expect(published.status).toBe(200);
    const body = (await published.json()) as PublishWorkflowResponse;
    expect(body.workflow.published).not.toBeNull();

    // Publish synced + armed the schedule trigger (strictly future — never a
    // backfill).
    const triggers = await db
      .select()
      .from(schema.triggers)
      .where(eq(schema.triggers.workflowId, workflowId));
    expect(triggers).toHaveLength(1);
    expect(triggers[0]).toMatchObject({ type: "schedule", cron: "*/20 * * * *", enabled: true });
    expect(triggers[0]!.nextFireAt).not.toBeNull();
    expect(triggers[0]!.nextFireAt!.getTime()).toBeGreaterThan(Date.now());
  });

  test(
    "run 1: ticker fires → ledger, rendered args at the stub, per-item infer outputs, cursor advance, pipeline.* events",
    async () => {
      firstRunId = await fireScheduleAndAwaitRun([]);

      // Sessionless parent run with schedule provenance.
      const runs = await db.select().from(schema.runs).where(eq(schema.runs.id, firstRunId));
      expect(runs[0]).toMatchObject({
        mode: "pipeline",
        agentSessionId: null,
        taskMessage: null,
        workflowId,
        organizationId: orgId,
      });
      const envelope = runs[0]!.triggerEvent as { triggerType?: string; data?: { scheduledFor?: unknown } };
      expect(envelope.triggerType).toBe("schedule");
      expect(typeof envelope.data?.scheduledFor).toBe("string");

      // ── the run_steps ledger, one row per step INSTANCE ──
      const steps = await ledgerOf(firstRunId);
      expect(steps.map((s) => s.path)).toEqual([
        searchStepId,
        gateStepId,
        loopStepId,
        `${loopStepId}/0/${summarizeStepId}`,
        `${loopStepId}/0/${createStepId}`,
        `${loopStepId}/1/${summarizeStepId}`,
        `${loopStepId}/1/${createStepId}`,
        advanceStepId,
      ]);
      expect(steps.every((s) => s.status === "succeeded")).toBeTrue();
      const byPath = new Map(steps.map((s) => [s.path, s]));

      // Rendered input snapshots: the literal query, the missing cursor as
      // "(not provided)" (markdown-surface semantics of $tpl).
      expect(byPath.get(searchStepId)!.input).toEqual({
        args: { query: "@team-exec in:#exec", after: "(not provided)" },
      });
      // …and the stub RECEIVED exactly those rendered args.
      expect(mcp.searchCalls).toHaveLength(1);
      expect(mcp.searchCalls[0]).toEqual({
        query: "@team-exec in:#exec",
        after: "(not provided)",
      });

      // The filter matched (2 new messages) and recorded its decision.
      expect(byPath.get(gateStepId)!.output).toEqual({ matched: true });

      // Loop instances: iteration-keyed rows, per-item INFER outputs
      // persisted with usage.
      expect(byPath.get(`${loopStepId}/0/${summarizeStepId}`)!.iteration).toBe(0);
      expect(byPath.get(`${loopStepId}/1/${summarizeStepId}`)!.iteration).toBe(1);
      expect(byPath.get(`${loopStepId}/0/${summarizeStepId}`)!.output).toEqual({
        text: "Budget review is slipping.",
        usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
      });
      expect(byPath.get(`${loopStepId}/1/${summarizeStepId}`)!.output).toEqual({
        text: "Hiring plan needs sign-off.",
        usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
      });
      // The stubbed wire saw each item's text rendered into the prompt.
      expect(gateway.captured).toHaveLength(2);
      expect(JSON.stringify(gateway.captured[0]!.body)).toContain("first exec mention");
      expect(JSON.stringify(gateway.captured[1]!.body)).toContain("second exec mention");

      // Per-item linear_create calls: title = the ITEM's infer output
      // ($ref type-preserving, scope isolated per item), permalink = @item.
      expect(mcp.createCalls).toEqual([
        {
          title: "Budget review is slipping.",
          permalink: "https://slack.example/archives/C1/p1",
        },
        {
          title: "Hiring plan needs sign-off.",
          permalink: "https://slack.example/archives/C1/p2",
        },
      ]);

      // The loop's aggregate output.
      expect(byPath.get(loopStepId)!.output).toMatchObject({
        total: 2,
        succeeded: 2,
        failed: 0,
        skipped: 0,
      });

      // ── the cursor advanced, as a STRING (type-preserving $ref → state) ──
      const state = await persistedState();
      expect(state.size).toBe(1);
      expect(state.get("cursor")).toEqual({
        value: LATEST_CURSOR,
        updatedByRunId: firstRunId,
      });
      // The operator state surface lists the key with its provenance.
      const stateRes = await api("GET", `/workspaces/${orgId}/workflows/${workflowId}/state`);
      expect(stateRes.status).toBe(200);
      const stateBody = (await stateRes.json()) as GetWorkflowStateResponse;
      expect(stateBody.entries).toHaveLength(1);
      expect(stateBody.entries[0]).toMatchObject({
        key: "cursor",
        updatedByRunId: firstRunId,
      });

      // ── pipeline.* events under the run's monotonic seq ──
      const types = await eventTypesOf(firstRunId);
      expect(types[0]).toBe("pipeline.started");
      expect(types.at(-1)).toBe("pipeline.completed");
      expect(types.filter((t) => t === "pipeline.step.started")).toHaveLength(8);
      expect(types.filter((t) => t === "pipeline.step.completed")).toHaveLength(8);
      expect(types).toContain("pipeline.state.updated");
      // state.updated names KEYS only — values never enter the event stream.
      const rows = await db
        .select({ event: schema.runEvents.event })
        .from(schema.runEvents)
        .where(eq(schema.runEvents.runId, firstRunId));
      const stateEvent = rows
        .map((r) => r.event as { type: string; data?: Record<string, unknown> })
        .find((e) => e.type === "pipeline.state.updated");
      expect(stateEvent!.data).toEqual({
        stepId: advanceStepId,
        path: advanceStepId,
        keys: ["cursor"],
      });
    },
    120_000,
  );

  test(
    "run 2: the advanced cursor renders into the search args; the empty page fences the rest (skipped, run succeeds)",
    async () => {
      secondRunId = await fireScheduleAndAwaitRun([firstRunId]);

      // The second search carried the persisted cursor — dedupe achieved.
      expect(mcp.searchCalls).toHaveLength(2);
      expect(mcp.searchCalls[1]).toEqual({
        query: "@team-exec in:#exec",
        after: LATEST_CURSOR,
      });
      // No new items → no new model calls, no new issues, cursor unchanged.
      expect(gateway.captured).toHaveLength(2);
      expect(mcp.createCalls).toHaveLength(2);
      const state = await persistedState();
      expect(state.get("cursor")?.value).toBe(LATEST_CURSOR);

      // A false top-level filter fences the remaining steps as visible
      // `skipped` ledger rows — and the run still SUCCEEDS.
      const steps = await ledgerOf(secondRunId);
      const byPath = new Map(steps.map((s) => [s.path, s.status]));
      expect(byPath.get(searchStepId)).toBe("succeeded");
      expect(byPath.get(gateStepId)).toBe("succeeded");
      expect(byPath.get(loopStepId)).toBe("skipped");
      expect(byPath.get(advanceStepId)).toBe("skipped");
      expect(steps).toHaveLength(4); // no loop-body instances exist

      const types = await eventTypesOf(secondRunId);
      expect(types.at(-1)).toBe("pipeline.completed");

      // Both runs surface on the workflow's Runs-tab list, newest first.
      const listRes = await api("GET", `/workspaces/${orgId}/workflows/${workflowId}/runs`);
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as ListWorkflowRunsResponse;
      expect(list.runs.map((r) => r.id)).toEqual([secondRunId, firstRunId]);
      expect(list.runs.every((r) => r.mode === "pipeline" && r.status === "succeeded")).toBeTrue();
    },
    120_000,
  );
});
