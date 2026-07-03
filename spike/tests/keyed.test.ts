/**
 * Phase-0 spike — KEYED acceptance (real model turns via OpenRouter).
 *
 * Skipped cleanly without OPENROUTER_API_KEY ("requires OPENROUTER_API_KEY").
 * Also gated on TEST_DATABASE_URL like every DB-dependent suite.
 *
 * Proves, through the reverse proxy:
 *   1. A full turn completes (session -> events -> assistant message).
 *   2. The NDJSON stream resumes with ?startIndex= after a disconnect.
 *   3. The approval-gated tool parks the session (input.requested,
 *      session.waiting); `eve start` is SIGKILLed; a fresh process resumes the
 *      parked run from Postgres via inputResponses and completes it. This is
 *      the durability bet.
 *   4. A follow-up via continuation token shares session memory.
 *   5. The docker() sandbox executes bash and writes a /workspace file.
 */
import { join } from "node:path";
import { writeFileSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  ARTIFACTS_DIR,
  DB_GATE_AVAILABLE,
  DB_GATE_SKIP_REASON,
  KEY_GATE_AVAILABLE,
  KEY_GATE_SKIP_REASON,
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

const RUN = DB_GATE_AVAILABLE && KEY_GATE_AVAILABLE;
if (!KEY_GATE_AVAILABLE) {
  console.warn(`[spike] skipping keyed suite: ${KEY_GATE_SKIP_REASON}`);
} else if (!DB_GATE_AVAILABLE) {
  console.warn(`[spike] skipping keyed suite: ${DB_GATE_SKIP_REASON}`);
}

interface SessionRef {
  sessionId: string;
  continuationToken: string;
}

async function postJson(
  path: string,
  body: unknown,
  token: string,
): Promise<{ status: number; json: Record<string, unknown> }> {
  const res = await fetch(`${PROXY_URL}${path}`, {
    body: JSON.stringify(body),
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    method: "POST",
  });
  const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  return { json, status: res.status };
}

function tokenOf(json: Record<string, unknown>, previous: string): string {
  return typeof json.continuationToken === "string" && json.continuationToken.length > 0
    ? json.continuationToken
    : previous;
}

function finalAssistantText(events: NdjsonEvent[]): string {
  const completed = events.filter((e) => e.type === "message.completed");
  const last = completed.at(-1) as
    | { data?: { message?: string | null } }
    | undefined;
  return last?.data?.message ?? "";
}

const TERMINAL = (event: NdjsonEvent): boolean =>
  event.type === "session.waiting" ||
  event.type === "session.completed" ||
  event.type === "session.failed";

describe.skipIf(!RUN)("spike keyed acceptance (requires OPENROUTER_API_KEY)", () => {
  let eve: EveProcess | null = null;
  let jwt = "";

  async function streamUntilTerminal(
    sessionId: string,
    options: { startIndex?: number; timeoutMs?: number } = {},
  ): Promise<NdjsonEvent[]> {
    const suffix = options.startIndex === undefined ? "" : `?startIndex=${options.startIndex}`;
    return readNdjson(`${PROXY_URL}/eve/v1/session/${sessionId}/stream${suffix}`, {
      headers: { authorization: `Bearer ${jwt}` },
      timeoutMs: options.timeoutMs ?? 180_000,
      until: TERMINAL,
    });
  }

  beforeAll(async () => {
    await ensurePostgres();
    await bootstrapWorld();
    await eveBuild();
    eve = await startEve();
    ensureProxy();
    jwt = await mintPlatformJwt();
  }, 600_000);

  afterAll(async () => {
    await eve?.stop();
    stopProxy();
  }, 30_000);

  test(
    "full turn completes through the proxy",
    async () => {
      const { json, status } = await postJson(
        "/eve/v1/session",
        { message: "Reply with exactly one word: pong" },
        jwt,
      );
      expect(status).toBeLessThan(300);
      const sessionId = json.sessionId as string;
      const events = await streamUntilTerminal(sessionId);
      const types = events.map((e) => e.type);
      expect(types).toContain("turn.started");
      expect(types).toContain("message.completed");
      expect(types.at(-1)).toMatch(/^session\.(waiting|completed)$/);
      expect(finalAssistantText(events).toLowerCase()).toContain("pong");

      writeFileSync(
        join(ARTIFACTS_DIR, "keyed-observed-events.ndjson"),
        events.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
    },
    240_000,
  );

  test(
    "NDJSON stream resumes with ?startIndex= after disconnect",
    async () => {
      const { json } = await postJson(
        "/eve/v1/session",
        { message: "Reply with exactly one word: resume" },
        jwt,
      );
      const sessionId = json.sessionId as string;

      // First (interrupted) read: take only the first 3 events, then drop.
      const head = await readNdjson(`${PROXY_URL}/eve/v1/session/${sessionId}/stream`, {
        headers: { authorization: `Bearer ${jwt}` },
        maxEvents: 3,
        timeoutMs: 120_000,
      });
      expect(head.length).toBe(3);

      // Reconnect skipping the events already consumed.
      const tail = await streamUntilTerminal(sessionId, { startIndex: head.length });
      expect(tail.length).toBeGreaterThan(0);
      // The resumed stream must not replay the consumed head events: exactly
      // one session.started across head + tail, and it lives in the head.
      expect(head.map((e) => e.type)).toContain("session.started");
      expect(tail.map((e) => e.type)).not.toContain("session.started");
    },
    240_000,
  );

  test(
    "approval-gated tool parks; kill `eve start`; restart resumes via inputResponses (durability bet)",
    async () => {
      const { json } = await postJson(
        "/eve/v1/session",
        {
          message:
            "Use the record_note tool to record the note 'durability-proof'. Do not ask anything, just call the tool.",
        },
        jwt,
      );
      const sessionId = json.sessionId as string;
      let continuationToken = tokenOf(json, "");

      // Park: input.requested carrying the approval request, then session.waiting.
      const parked = await readNdjson(`${PROXY_URL}/eve/v1/session/${sessionId}/stream`, {
        headers: { authorization: `Bearer ${jwt}` },
        timeoutMs: 180_000,
        until: (event, all) =>
          event.type === "session.waiting" &&
          all.some((e) => e.type === "input.requested"),
      });
      const inputRequested = parked.find((e) => e.type === "input.requested") as
        | { data?: { requests?: { requestId: string }[] } }
        | undefined;
      expect(inputRequested).toBeDefined();
      const requestId = inputRequested?.data?.requests?.[0]?.requestId;
      expect(typeof requestId).toBe("string");

      writeFileSync(
        join(ARTIFACTS_DIR, "keyed-parked-events.ndjson"),
        parked.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );

      // KILL the runtime while the session is parked...
      const oldServerPid = await eve!.serverPid();
      await eve!.killHard();
      // ...and bring up a brand-new process. All state must come from Postgres.
      eve = await startEve();
      expect(await eve.serverPid()).not.toBe(oldServerPid);

      const resume = await postJson(
        `/eve/v1/session/${sessionId}`,
        {
          continuationToken,
          inputResponses: [{ optionId: "approve", requestId }],
        },
        jwt,
      );
      expect(resume.status).toBeLessThan(300);
      continuationToken = tokenOf(resume.json, continuationToken);

      const resumed = await streamUntilTerminal(sessionId, {
        startIndex: parked.length,
      });
      const types = resumed.map((e) => e.type);
      expect(types).toContain("action.result");
      const actionResult = resumed.find((e) => e.type === "action.result") as
        | { data?: { status?: string } }
        | undefined;
      expect(actionResult?.data?.status).toBe("completed");
      expect(types.at(-1)).toMatch(/^session\.(waiting|completed)$/);
    },
    360_000,
  );

  test(
    "follow-up via continuation token shares session memory",
    async () => {
      const first = await postJson(
        "/eve/v1/session",
        { message: "Remember the codeword: ottoman. Reply OK." },
        jwt,
      );
      const sessionId = first.json.sessionId as string;
      let continuationToken = tokenOf(first.json, "");
      const firstEvents = await streamUntilTerminal(sessionId);
      expect(firstEvents.map((e) => e.type).at(-1)).toBe("session.waiting");

      const second = await postJson(
        `/eve/v1/session/${sessionId}`,
        {
          continuationToken,
          message: "What is the codeword? Reply with just the word.",
        },
        jwt,
      );
      expect(second.status).toBeLessThan(300);
      const followUp = await streamUntilTerminal(sessionId, {
        startIndex: firstEvents.length,
      });
      expect(finalAssistantText(followUp).toLowerCase()).toContain("ottoman");
    },
    300_000,
  );

  test(
    "live MCP tool call: model calls a deepwiki tool through the connection",
    async () => {
      const { json } = await postJson(
        "/eve/v1/session",
        {
          message:
            "Using the deepwiki connection, ask what the vercel/next.js repository is about (use ask_question or read_wiki_structure). Then answer in one short sentence.",
        },
        jwt,
      );
      const sessionId = json.sessionId as string;
      const events = await streamUntilTerminal(sessionId, { timeoutMs: 300_000 });
      const types = events.map((e) => e.type);
      expect(types).toContain("actions.requested");
      expect(types).toContain("action.result");
      // eve names MCP tools <connection>__<tool> (path-derived identity).
      const mcpResult = events.find((e) => {
        if (e.type !== "action.result") return false;
        const toolName = (e as { data?: { result?: { toolName?: string } } })
          .data?.result?.toolName;
        return typeof toolName === "string" && toolName.startsWith("deepwiki__");
      }) as { data?: { status?: string } } | undefined;
      expect(mcpResult).toBeDefined();
      expect(mcpResult?.data?.status).toBe("completed");

      writeFileSync(
        join(ARTIFACTS_DIR, "keyed-mcp-events.ndjson"),
        events.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
    },
    360_000,
  );

  test(
    "docker() sandbox: bash writes a /workspace file (mounted socket)",
    async () => {
      const { json } = await postJson(
        "/eve/v1/session",
        {
          message:
            "Using the bash tool, run: echo spike-sandbox-ok > /workspace/proof.txt && cat /workspace/proof.txt — then reply with the file contents only.",
        },
        jwt,
      );
      const sessionId = json.sessionId as string;
      const events = await streamUntilTerminal(sessionId, { timeoutMs: 300_000 });
      const types = events.map((e) => e.type);
      expect(types).toContain("action.result");
      expect(finalAssistantText(events)).toContain("spike-sandbox-ok");
    },
    360_000,
  );
});
