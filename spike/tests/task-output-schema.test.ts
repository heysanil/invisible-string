/**
 * Workflow-pipelines spike (Amendment A3) — does eve 0.31.3's session CREATE
 * accept `outputSchema` alongside `mode: "task"`, and does a session created
 * that way emit a `result.completed` terminal-result event?
 *
 * The agent step's design (plan: workflow-pipelines, Amendment A3) always
 * extracts + locally validates structured output from the child run's
 * terminal events; whether it ALSO sends `outputSchema` on session create is
 * decided here. Until now `outputSchema` was comment-attested only
 * (packages/shared/src/eve-session-api.ts:203) and `result.completed` was
 * docs-derived (eve docs/guides/client/output-schema.mdx).
 *
 * Static source-read (dist/src/public/channels/eve.js, pinned 0.31.3),
 * verified live below:
 * - `parseCreateBody` parses `mode` and `outputSchema` as first-class fields
 *   (alongside message/clientContext/callback/capabilities) — outputSchema is
 *   NOT an ignored unknown key: a non-object value is a 400 of its own.
 * - The harness (dist/src/harness/tool-loop.js) enforces the schema by
 *   injecting a `final_output` tool; a task turn whose model never calls it
 *   fails the step with OUTPUT_SCHEMA_NOT_FULFILLED, and a call that does
 *   emits `result.completed {result, sequence, stepIndex, turnId}`.
 * - `emitTurnEpilogue` ends a `task` turn with `session.completed` (a
 *   `conversation` turn settles `session.waiting`) — a task session is
 *   one-shot and its id is dead afterwards.
 *
 * Mock-model choreography (EVE_MOCK_AUTHORED_MODELS=1): when the advertised
 * tool set contains `final_output`, the mock calls it with a
 * schema-satisfying sample (`createFinalOutputResult` →
 * `createJsonSchemaSample`), so the full outputSchema path — injection,
 * model call, validation, `result.completed` — runs for real with only the
 * LLM emulated. The prompt deliberately avoids every mock directive shape
 * ("Call the X tool", "call tools in parallel:", "delegate to a subagent:")
 * and the spike agent's skill vocabulary, so the final_output branch is the
 * first one that matches.
 *
 * Gated SPIKE_EVE_BUILD=1 (real `eve build`, Node 24, warm npm cache) on top
 * of the usual TEST_DATABASE_URL gate.
 */
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  ARTIFACTS_DIR,
  DB_GATE_AVAILABLE,
  DB_GATE_SKIP_REASON,
  PROXY_URL,
  bootstrapWorld,
  ensurePostgres,
  ensureProxy,
  eveBuild,
  mintPlatformJwt,
  readNdjson,
  startEve,
  stopProxy,
  type EveProcess,
  type NdjsonEvent,
} from "./harness.ts";

const BUILD_GATE_AVAILABLE = process.env.SPIKE_EVE_BUILD === "1";
const GATE = DB_GATE_AVAILABLE && BUILD_GATE_AVAILABLE;
if (!GATE) {
  console.warn(
    `[spike] skipping task-output-schema suite: ${
      DB_GATE_AVAILABLE ? "requires SPIKE_EVE_BUILD=1 (slow: real eve build)" : DB_GATE_SKIP_REASON
    }`,
  );
}

/**
 * The exact restricted-subset shape the pipeline's agent step will send:
 * plain object, primitive properties, required list, no $ref/oneOf.
 */
const OUTPUT_SCHEMA = {
  type: "object",
  properties: {
    title: { type: "string" },
    count: { type: "integer" },
  },
  required: ["title", "count"],
  additionalProperties: false,
} as const;

const TERMINAL = (event: NdjsonEvent): boolean =>
  event.type === "session.waiting" ||
  event.type === "session.completed" ||
  event.type === "session.failed";

describe.skipIf(!GATE)("spike task mode + outputSchema (result.completed)", () => {
  let eve: EveProcess | null = null;
  let jwt = "";

  async function postJson(
    path: string,
    body: unknown,
  ): Promise<{ status: number; json: Record<string, unknown> }> {
    const res = await fetch(`${PROXY_URL}${path}`, {
      body: JSON.stringify(body),
      headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
      method: "POST",
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { json, status: res.status };
  }

  async function streamToTerminal(sessionId: string): Promise<NdjsonEvent[]> {
    return readNdjson(`${PROXY_URL}/eve/v1/session/${sessionId}/stream?startIndex=0`, {
      headers: { authorization: `Bearer ${jwt}` },
      timeoutMs: 120_000,
      until: TERMINAL,
    });
  }

  beforeAll(async () => {
    await ensurePostgres();
    await bootstrapWorld();
    await eveBuild();
    eve = await startEve({ mockModels: true });
    ensureProxy();
    jwt = await mintPlatformJwt();
  }, 600_000);

  afterAll(async () => {
    await eve?.stop();
    stopProxy();
  }, 30_000);

  test(
    "create accepts mode:'task' + outputSchema and the turn emits result.completed",
    async () => {
      // The A3 question, half one: no 400 on either key.
      const { json, status } = await postJson("/eve/v1/session", {
        message: "Produce the structured summary for the pipeline spike.",
        mode: "task",
        outputSchema: OUTPUT_SCHEMA,
      });
      expect(status).toBe(202);
      expect(json.status).toBe("accepted");
      const sessionId = json.sessionId as string;
      expect(sessionId.length).toBeGreaterThan(0);

      const events = await streamToTerminal(sessionId);
      writeFileSync(
        join(ARTIFACTS_DIR, "task-output-schema-events.ndjson"),
        events.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
      console.log("[spike:task] schema turn types:", JSON.stringify(events.map((e) => e.type)));

      // ===== Empirical capture (observed on eve 0.31.3, pinned) =====
      // The schema is enforced through an injected `final_output` tool the
      // model must call, but the call is consumed INTERNALLY: no
      // actions.requested / action.result pair ever reaches the stream — the
      // only trace of the tool call is the step.completed's
      // finishReason:"tool-calls", and the finalized payload is emitted as
      // `result.completed` between step.completed and turn.completed. Task
      // mode terminates the session: the terminal event is
      // session.completed (data-less), never session.waiting.
      expect(events.map((e) => e.type)).toEqual([
        "session.started",
        "turn.started",
        "message.received",
        "step.started",
        "step.completed",
        "result.completed",
        "turn.completed",
        "session.completed",
      ]);
      const step = events.find((e) => e.type === "step.completed") as {
        data?: { finishReason?: string };
      };
      expect(step.data?.finishReason).toBe("tool-calls");

      // The A3 question, half two: a structured-result terminal event exists
      // and its payload satisfies the requested schema.
      const result = events.find((e) => e.type === "result.completed") as {
        data?: { result?: Record<string, unknown>; stepIndex?: number; turnId?: string };
      };
      console.log("[spike:task] result.completed payload:", JSON.stringify(result.data));
      expect(typeof result.data?.result?.title).toBe("string");
      expect(Number.isInteger(result.data?.result?.count)).toBe(true);
      expect(Object.keys(result.data?.result ?? {}).sort()).toEqual(["count", "title"]);
      expect(result.data?.turnId).toBe("turn_0");

      // ===== Empirical capture (observed on eve 0.31.3, pinned) =====
      // TRAP — a follow-up send to the COMPLETED task session is NOT the 409
      // `session_not_active` finding 23 documents for terminal ids: it
      // answers 202 `accepted` with the SAME session id, and then NOTHING
      // happens — no turn.started, no error, no event of any kind (mocked
      // turns otherwise settle in ~200 ms; 15 s of silence is conclusive).
      // The message is accepted-and-dropped, so a 202 on this route never
      // proves a turn will run. The agent step must treat `session.completed`
      // on the stream as the end of the child session and never rely on the
      // send route to say so.
      const followUp = await postJson(`/eve/v1/session/${sessionId}`, {
        message: "Reply with exactly: task-follow-up",
      });
      expect(followUp.status).toBe(202);
      expect(followUp.json.sessionId).toBe(sessionId);
      const tail = await readNdjson(
        `${PROXY_URL}/eve/v1/session/${sessionId}/stream?startIndex=${events.length}`,
        { headers: { authorization: `Bearer ${jwt}` }, timeoutMs: 15_000, until: TERMINAL },
      );
      expect(tail).toEqual([]);
    },
    240_000,
  );

  test(
    "control: mode:'task' WITHOUT outputSchema completes with no result.completed",
    async () => {
      const { json, status } = await postJson("/eve/v1/session", {
        message: "Reply with exactly: pipeline-task-plain",
        mode: "task",
      });
      expect(status).toBe(202);
      const events = await streamToTerminal(json.sessionId as string);
      console.log("[spike:task] plain turn types:", JSON.stringify(events.map((e) => e.type)));

      // ===== Empirical capture (observed on eve 0.31.3, pinned) =====
      // `result.completed` is SCHEMA-driven, not task-driven: a schemaless
      // task turn is a normal text turn that ends session.completed.
      expect(events.some((e) => e.type === "result.completed")).toBe(false);
      expect(events.map((e) => e.type).at(-1)).toBe("session.completed");
      const message = events.find((e) => e.type === "message.completed") as {
        data?: { message?: string };
      };
      expect(message.data?.message).toBe("pipeline-task-plain");
    },
    240_000,
  );

  test(
    "outputSchema is a PARSED field, not an ignored unknown key: a non-object value is a 400",
    async () => {
      // Distinguishes "accepted" from "silently dropped": the create route
      // validates the field's shape, so a malformed value is rejected before
      // any session exists.
      const { json, status } = await postJson("/eve/v1/session", {
        message: "Produce the structured summary for the pipeline spike.",
        mode: "task",
        outputSchema: "not-an-object",
      });
      expect(status).toBe(400);
      expect(json.ok).toBe(false);
      expect(String(json.error)).toContain("outputSchema");
    },
    60_000,
  );
});
