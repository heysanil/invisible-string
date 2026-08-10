/**
 * Phase-3 connectors spike — what does eve ACTUALLY emit when a connected
 * MCP server starts rejecting requests mid-session, and when a connection's
 * `auth.getToken` throws?
 *
 * Plan-3 Task 9 (mid-run authorization latch) branches on this capture: the
 * platform's broker-delivered connections are getToken-only (non-interactive)
 * `defineMcpClientConnection` auth — the exact shape codegen emits — so the
 * question is whether a mid-run 401 surfaces as `authorization.required` or
 * as a plain failed tool call.
 *
 * Harness: the shared spike agent (built once per process) carries the
 * `authprobe` connection (agent/connections/authprobe.ts) pointed via
 * SPIKE_AUTH_MCP_URL at a local stub MCP server built on the official SDK's
 * StreamableHTTPServerTransport (stateless, per-request — the e2e stub-mcp
 * idiom; a hand-rolled JSON responder does not survive eve's real client
 * handshake). The stub serves initialize/tools/list normally and flips to
 * 401-with-WWW-Authenticate for tools/call after the first completed call.
 *
 * Mock-model choreography (EVE_MOCK_AUTHORED_MODELS=1): connection tools are
 * NOT advertised directly on eve 0.31 — the model must first discover them
 * via the framework's `connection_search` dynamic tool; discovered tools are
 * re-advertised every later step of the SAME session (extracted from the
 * durable message history), so each scenario is its own turn:
 *
 *   turn 1  connection_search (scoped to authprobe)   -> discovery
 *   turn 2  authprobe__save_note                      -> tools/call, 200
 *   turn 3  authprobe__save_note                      -> tools/call, 401
 *   turn 4  authprobe__save_note (marker file set)    -> getToken THROWS
 *
 * Observed (finding 30): eve builds a FRESH MCP client per turn — every turn
 * that touches the connection re-runs getToken and replays
 * initialize/notifications/initialized/tools/list before tools/call, so the
 * stub's method-scoped flip ("tools/call after the first completed call")
 * rejects exactly turn 3's call while its handshake still succeeds.
 *
 * Gated SPIKE_EVE_BUILD=1 (real `eve build`, Node 24, warm npm cache) on top
 * of the usual TEST_DATABASE_URL gate.
 */
import { writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { Server } from "../../apps/control-plane/node_modules/@modelcontextprotocol/sdk/dist/esm/server/index.js";
import { StreamableHTTPServerTransport } from "../../apps/control-plane/node_modules/@modelcontextprotocol/sdk/dist/esm/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "../../apps/control-plane/node_modules/@modelcontextprotocol/sdk/dist/esm/types.js";

import {
  ARTIFACTS_DIR,
  DB_GATE_AVAILABLE,
  DB_GATE_SKIP_REASON,
  PROXY_URL,
  bootstrapWorld,
  ensurePostgres,
  ensureProxy,
  eveBuild,
  markerDir,
  mintPlatformJwt,
  readNdjson,
  resetMarkerDir,
  startEve,
  stopProxy,
  type EveProcess,
  type NdjsonEvent,
} from "./harness.ts";

const BUILD_GATE_AVAILABLE = process.env.SPIKE_EVE_BUILD === "1";
const GATE = DB_GATE_AVAILABLE && BUILD_GATE_AVAILABLE;
if (!GATE) {
  console.warn(
    `[spike] skipping authorization-events suite: ${
      DB_GATE_AVAILABLE ? "requires SPIKE_EVE_BUILD=1 (slow: real eve build)" : DB_GATE_SKIP_REASON
    }`,
  );
}

/**
 * Local stub MCP server port (spike block: proxy 4100, agent 4101). The
 * authprobe connection's DEFAULT url is this address because a connection
 * `url` is resolved at `eve build` time and baked into the compiled manifest
 * — runtime env cannot repoint it (finding 30). Exporting the env var here
 * only matters when THIS file is the one that triggers the shared build; both
 * paths land on the same address.
 */
const AUTH_STUB_PORT = 4102;
const AUTH_STUB_URL = `http://127.0.0.1:${AUTH_STUB_PORT}/mcp`;
process.env.SPIKE_AUTH_MCP_URL = AUTH_STUB_URL;

const TERMINAL = (event: NdjsonEvent): boolean =>
  event.type === "session.waiting" ||
  event.type === "session.completed" ||
  event.type === "session.failed";

function finalAssistantText(events: NdjsonEvent[]): string {
  const last = events.filter((e) => e.type === "message.completed").at(-1) as
    | { data?: { message?: string | null } }
    | undefined;
  return last?.data?.message ?? "";
}

function actionResults(
  events: NdjsonEvent[],
): { toolName?: string; status?: string; output?: unknown; error?: unknown }[] {
  return events
    .filter((e) => e.type === "action.result")
    .map((e) => {
      const data = (e as { data?: { status?: string; result?: Record<string, unknown> } }).data;
      return {
        toolName: data?.result?.toolName as string | undefined,
        status: data?.status,
        output: data?.result?.output,
        error: data?.result?.error,
      };
    });
}

// ---------------------------------------------------------------------------
// Stub MCP server (official SDK, stateless transport per request)
// ---------------------------------------------------------------------------

interface StubRequest {
  httpMethod: string;
  rpcMethod?: string;
  authorization?: string;
}

const stubRequests: StubRequest[] = [];
const stubCallLog: { name: string; args: unknown }[] = [];
let stubToolCallAttempts = 0;

function buildStubServer(): InstanceType<typeof Server> {
  const server = new Server(
    { name: "spike-auth-stub", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [
      {
        name: "save_note",
        description: "Save a short note to the spike notebook.",
        inputSchema: {
          type: "object" as const,
          properties: { note: { type: "string", description: "The note text to save." } },
          required: ["note"],
        },
      },
    ],
  }));
  server.setRequestHandler(CallToolRequestSchema, async (req) => {
    stubCallLog.push({ name: req.params.name, args: req.params.arguments });
    return {
      content: [{ type: "text" as const, text: `note saved: ${JSON.stringify(req.params.arguments)}` }],
    };
  });
  return server;
}

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const raw = Buffer.concat(chunks).toString("utf8");
  return raw.length > 0 ? JSON.parse(raw) : undefined;
}

function startStub(): ReturnType<typeof createServer> {
  const httpServer = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    let body: unknown;
    try {
      body = req.method === "POST" ? await readJsonBody(req) : undefined;
    } catch {
      body = undefined;
    }
    const rpcMethod =
      body !== null && typeof body === "object" && "method" in (body as object)
        ? (body as { method?: string }).method
        : undefined;
    stubRequests.push({
      httpMethod: req.method ?? "?",
      rpcMethod,
      authorization: req.headers.authorization,
    });

    // The flip: initialize/tools/list always work; tools/call works ONCE,
    // then every later attempt is 401 + WWW-Authenticate (the server started
    // rejecting the previously-good bearer mid-session).
    if (rpcMethod === "tools/call") {
      stubToolCallAttempts += 1;
      if (stubCallLog.length >= 1) {
        res.statusCode = 401;
        res.setHeader(
          "WWW-Authenticate",
          `Bearer resource_metadata="http://127.0.0.1:${AUTH_STUB_PORT}/.well-known/oauth-protected-resource/mcp", error="invalid_token"`,
        );
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ error: "invalid_token" }));
        return;
      }
    }

    const server = buildStubServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });
    res.on("close", () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
  httpServer.listen(AUTH_STUB_PORT, "127.0.0.1");
  return httpServer;
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe.skipIf(!GATE)("spike authorization events (mid-run MCP auth rejection)", () => {
  let eve: EveProcess | null = null;
  let stub: ReturnType<typeof createServer> | null = null;
  let jwt = "";
  let sessionId = "";
  let cursor = 0;

  async function postJson(
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${PROXY_URL}${path}`, {
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
      method: "POST",
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { json, status: res.status };
  }

  /** Send one message and stream the resulting turn to its terminal event. */
  async function driveTurn(message: string, timeoutMs = 120_000): Promise<NdjsonEvent[]> {
    const { json, status } =
      sessionId === ""
        ? await postJson("/eve/v1/session", { message })
        : await postJson(`/eve/v1/session/${sessionId}`, { message });
    expect(status).toBe(202);
    expect(json.status).toBe("accepted");
    if (sessionId === "") sessionId = json.sessionId as string;
    const events = await readNdjson(`${PROXY_URL}/eve/v1/session/${sessionId}/stream?startIndex=${cursor}`, {
      headers: { authorization: `Bearer ${jwt}` },
      timeoutMs,
      until: TERMINAL,
    });
    cursor += events.length;
    return events;
  }

  beforeAll(async () => {
    await ensurePostgres();
    await bootstrapWorld();
    await eveBuild();
    resetMarkerDir();
    stub = startStub();
    eve = await startEve({ mockModels: true });
    ensureProxy();
    jwt = await mintPlatformJwt();
  }, 600_000);

  afterAll(async () => {
    await eve?.stop();
    stopProxy();
    stub?.close();
  }, 30_000);

  test(
    "SCENARIO 1 — mid-run 401: server flips to 401 for tools/call after the first call",
    async () => {
      // Turn 1: discovery. connection_search is the only route to a
      // connection tool on 0.31 — its result (persisted in the durable
      // message history) is what re-advertises authprobe__save_note on every
      // later step of this session.
      const discovery = await driveTurn(
        'Call the connection_search tool with connection "authprobe" and keywords "save note".',
      );
      const discoveryResults = actionResults(discovery);
      expect(discoveryResults.some((r) => r.toolName === "connection_search" && r.status === "completed")).toBe(true);
      expect(discovery.map((e) => e.type).at(-1)).toBe("session.waiting");

      // Turn 2: the call the server still accepts. Proves the bearer from
      // getToken reached the wire and the connection genuinely works.
      const okTurn = await driveTurn(
        'Call the authprobe__save_note tool with note "auth-spike-first".',
      );
      const okResults = actionResults(okTurn);
      expect(
        okResults.some((r) => r.toolName === "authprobe__save_note" && r.status === "completed"),
      ).toBe(true);
      expect(stubCallLog).toEqual([{ name: "save_note", args: { note: "auth-spike-first" } }]);
      expect(
        stubRequests.some((r) => r.rpcMethod === "tools/call" && r.authorization === "Bearer spike-static-token"),
      ).toBe(true);

      // Turn 3: the server now 401s tools/call. Capture everything.
      const rejectedTurn = await driveTurn(
        'Call the authprobe__save_note tool with note "auth-spike-second".',
        180_000,
      );
      writeFileSync(
        join(ARTIFACTS_DIR, "authorization-401-events.ndjson"),
        rejectedTurn.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      console.log(
        "[spike:auth] 401 turn types:",
        JSON.stringify(rejectedTurn.map((e) => e.type)),
      );
      console.log(
        "[spike:auth] 401 turn action.results:",
        JSON.stringify(actionResults(rejectedTurn)),
      );
      console.log("[spike:auth] 401 turn final text:", finalAssistantText(rejectedTurn));

      // The stub really saw (and rejected) a second attempt; the tool never ran.
      expect(stubToolCallAttempts).toBeGreaterThanOrEqual(2);
      expect(stubCallLog.length).toBe(1);

      // ===== Empirical capture (observed on eve 0.31.3, pinned) =====
      // The mid-run 401 is a FAILED TOOL CALL, nothing more: no
      // authorization.required (eve only emits it when a tool result is an
      // AuthorizationSignal, which requires an INTERACTIVE strategy —
      // getToken-only auth can never produce one), no park, no
      // turn/step/session failure, no internal retry. The turn runs to
      // completion and settles session.waiting.
      expect(rejectedTurn.map((e) => e.type)).toEqual([
        "turn.started",
        "message.received",
        "step.started",
        "actions.requested",
        "action.result",
        "step.completed",
        "step.started",
        "message.appended",
        "message.completed",
        "step.completed",
        "turn.completed",
        "session.waiting",
      ]);
      const failed = rejectedTurn.find((e) => e.type === "action.result") as {
        data?: {
          status?: string;
          error?: { code?: string; message?: string };
          result?: { toolName?: string; output?: unknown; isError?: boolean };
        };
      };
      expect(failed.data?.status).toBe("failed");
      expect(failed.data?.result?.toolName).toBe("authprobe__save_note");
      expect(failed.data?.result?.isError).toBe(true);
      // Generic failure code — there is NO distinct auth error code on the
      // wire; the ONLY auth signal is the message text of eve's
      // ConnectionAuthorizationRequiredError wrapper.
      expect(failed.data?.error?.code).toBe("ACTION_RESULT_FAILED");
      expect(failed.data?.result?.output).toBe(
        'Connection "authprobe" requires authorization (the server rejected the token).',
      );
    },
    420_000,
  );

  test(
    "SCENARIO 2 — auth.getToken THROWS a plain Error on the next call of the same session",
    async () => {
      // eve resolves the bearer afresh for every turn's client (and the 401
      // additionally evicted the token cache and closed the previous client),
      // so the next turn's tools/call re-runs getToken. Flip it to throw-mode
      // via the marker file (read lazily per call inside the connection
      // definition).
      writeFileSync(join(markerDir(), "authprobe-token-throw"), "1");

      const attemptsBefore = stubRequests.length;
      const throwTurn = await driveTurn(
        'Call the authprobe__save_note tool with note "auth-spike-third".',
        180_000,
      );
      writeFileSync(
        join(ARTIFACTS_DIR, "authorization-gettoken-throw-events.ndjson"),
        throwTurn.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      console.log(
        "[spike:auth] getToken-throw turn types:",
        JSON.stringify(throwTurn.map((e) => e.type)),
      );
      console.log(
        "[spike:auth] getToken-throw turn action.results:",
        JSON.stringify(actionResults(throwTurn)),
      );
      console.log("[spike:auth] getToken-throw final text:", finalAssistantText(throwTurn));

      // The failure happened at token mint: nothing new reached the stub.
      expect(stubRequests.length).toBe(attemptsBefore);

      // ===== Empirical capture (observed on eve 0.31.3, pinned) =====
      // Identical event shape to the mid-run 401 — a failed tool call ending
      // in session.waiting. The ONLY difference is the message text: the
      // plain Error's message propagates verbatim (no "requires
      // authorization" wrapper), so the two failure modes are
      // distinguishable ONLY by message text, and only fragilely.
      expect(throwTurn.map((e) => e.type)).toEqual([
        "turn.started",
        "message.received",
        "step.started",
        "actions.requested",
        "action.result",
        "step.completed",
        "step.started",
        "message.appended",
        "message.completed",
        "step.completed",
        "turn.completed",
        "session.waiting",
      ]);
      const failed = throwTurn.find((e) => e.type === "action.result") as {
        data?: {
          status?: string;
          error?: { code?: string; message?: string };
          result?: { toolName?: string; output?: unknown; isError?: boolean };
        };
      };
      expect(failed.data?.status).toBe("failed");
      expect(failed.data?.result?.toolName).toBe("authprobe__save_note");
      expect(failed.data?.result?.isError).toBe(true);
      expect(failed.data?.error?.code).toBe("ACTION_RESULT_FAILED");
      expect(String(failed.data?.result?.output)).toContain(
        "spike-authprobe-token-mint-failed",
      );
    },
    300_000,
  );
});
