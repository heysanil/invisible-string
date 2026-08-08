/**
 * Phase-0 spike — KEYLESS-MOCKED end-to-end acceptance.
 *
 * Runs `eve start` with eve's documented mock-model mode
 * (EVE_MOCK_AUTHORED_MODELS=1). Everything except the LLM call is REAL: route
 * auth, the Postgres workflow world, run callbacks through the reverse proxy,
 * tool execution, HITL approval parking, and the docker() sandbox. This lets
 * the Phase-0 durability gate — park on approval, SIGKILL `eve start`,
 * restart, resume via inputResponses — run without any provider API key.
 *
 * The keyed suite (keyed.test.ts) repeats these flows against a real model.
 * Gated on TEST_DATABASE_URL like every DB-dependent suite.
 *
 * eve 0.31 PROTOCOL (migrated from the 0.19 continuation-token API):
 *   create     POST /eve/v1/session                    -> 202 {ok, sessionId, status:"accepted"}
 *   follow-up  POST /eve/v1/session/:sessionId         -> 202; body is `message` XOR `inputResponses`
 *   cancel     POST /eve/v1/session/:sessionId/cancel  -> 202 accepted | 200 no_active_turn
 *   clear      POST /eve/v1/session/:sessionId/clear   -> 202 accepted | 200 no_active_session
 *   compact    POST /eve/v1/session/:sessionId/compact -> 202 accepted | 200 no_active_session
 *   reset      POST /eve/v1/session/:sessionId/reset   -> ALWAYS 200; {previousSessionId, status:"reset"} | {status:"no_active_session"}
 *   stream     GET  /eve/v1/session/:sessionId/stream  -> NDJSON, version 21
 * Unknown or terminal ids answer 409 {ok:false, code:"session_not_active"}.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  ARTIFACTS_DIR,
  DB_GATE_AVAILABLE,
  DB_GATE_SKIP_REASON,
  EVE_EVENT_ID_PATTERN,
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

if (!DB_GATE_AVAILABLE) {
  console.warn(`[spike] skipping mocked suite: ${DB_GATE_SKIP_REASON}`);
}

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

function sandboxImageAvailable(): boolean {
  try {
    const proc = Bun.spawnSync(
      ["docker", "image", "inspect", "ghcr.io/vercel/eve:latest"],
      { stderr: "ignore", stdout: "ignore" },
    );
    return proc.exitCode === 0;
  } catch {
    return false; // docker CLI missing entirely
  }
}

/**
 * Sandbox-test gate: acceptance bullet 4 must never pass vacuously. When the
 * 645MB ghcr.io/vercel/eve:latest image is absent the test is SKIPPED with a
 * visible reason (collection-time skipIf, not a silent in-body return) — and
 * CI/integration runs can set SPIKE_REQUIRE_SANDBOX=1 to FAIL instead of
 * skipping (the harness/CI setup is then responsible for pulling the image).
 */
const SANDBOX_REQUIRED = process.env.SPIKE_REQUIRE_SANDBOX === "1";
const SANDBOX_IMAGE_AVAILABLE = DB_GATE_AVAILABLE && sandboxImageAvailable();
const SANDBOX_SKIP = !SANDBOX_IMAGE_AVAILABLE && !SANDBOX_REQUIRED;
if (DB_GATE_AVAILABLE && SANDBOX_SKIP) {
  console.warn(
    "[spike] SKIPPING sandbox test: ghcr.io/vercel/eve:latest not pulled — `docker pull ghcr.io/vercel/eve:latest` (or set SPIKE_REQUIRE_SANDBOX=1 to fail instead)",
  );
}

describe.skipIf(!DB_GATE_AVAILABLE)("spike keyless-mocked e2e (EVE_MOCK_AUTHORED_MODELS=1)", () => {
  let eve: EveProcess | null = null;
  let jwt = "";

  async function postJson(
    path: string,
    body?: unknown,
  ): Promise<{ status: number; json: Record<string, unknown>; headers: Headers }> {
    const res = await fetch(`${PROXY_URL}${path}`, {
      // The four control routes take an OPTIONAL body; `undefined` sends a
      // zero-byte POST, which is exactly what a Stop button would issue.
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
      method: "POST",
    });
    const json = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    return { headers: res.headers, json, status: res.status };
  }

  /**
   * Create a session and return its id. Every 0.31 create is asserted the
   * same way — 202, `{ok, sessionId, status:"accepted"}`, no continuation
   * token — so a protocol regression fails at the first call of any test
   * rather than as a confusing downstream 400.
   */
  async function createSession(message: string): Promise<string> {
    const { headers, json, status } = await postJson("/eve/v1/session", { message });
    expect(status).toBe(202);
    expect(json.ok).toBe(true);
    expect(json.status).toBe("accepted");
    expect(json.continuationToken).toBeUndefined();
    const sessionId = json.sessionId as string;
    expect(typeof sessionId).toBe("string");
    expect(headers.get("x-eve-session-id")).toBe(sessionId);
    return sessionId;
  }

  /** Follow-up `send` — 0.31's message form, mutually exclusive with respond. */
  async function sendFollowUp(sessionId: string, message: string) {
    return postJson(`/eve/v1/session/${sessionId}`, { message });
  }

  /** Follow-up `respond` — 0.31's HITL form. Never carries a message. */
  async function respond(
    sessionId: string,
    inputResponses: { requestId: string; optionId?: string; text?: string }[],
  ) {
    return postJson(`/eve/v1/session/${sessionId}`, { inputResponses });
  }

  async function streamUntilTerminal(
    sessionId: string,
    options: { startIndex?: number; timeoutMs?: number } = {},
  ): Promise<NdjsonEvent[]> {
    const suffix = options.startIndex === undefined ? "" : `?startIndex=${options.startIndex}`;
    return readNdjson(`${PROXY_URL}/eve/v1/session/${sessionId}/stream${suffix}`, {
      headers: { authorization: `Bearer ${jwt}` },
      timeoutMs: options.timeoutMs ?? 90_000,
      until: TERMINAL,
    });
  }

  beforeAll(async () => {
    await ensurePostgres();
    await bootstrapWorld();
    await eveBuild();
    resetMarkerDir();
    eve = await startEve({ mockModels: true });
    ensureProxy();
    jwt = await mintPlatformJwt();
  }, 600_000);

  afterAll(async () => {
    await eve?.stop();
    stopProxy();
  }, 30_000);

  test(
    "full turn completes through the proxy (workflow callbacks on /.well-known/workflow/)",
    async () => {
      const sessionId = await createSession("Reply with exactly: pong");
      const events = await streamUntilTerminal(sessionId);
      const types = events.map((e) => e.type);
      expect(types).toContain("turn.started");
      expect(types).toContain("step.completed");
      expect(types).toContain("turn.completed");
      expect(types.at(-1)).toBe("session.waiting");
      expect(finalAssistantText(events)).toBe("pong");

      writeFileSync(
        join(ARTIFACTS_DIR, "mocked-turn-events.ndjson"),
        events.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
    },
    120_000,
  );

  test(
    "NDJSON stream resumes with ?startIndex= after disconnect",
    async () => {
      const sessionId = await createSession("Reply with exactly: resume-me");

      const head = await readNdjson(`${PROXY_URL}/eve/v1/session/${sessionId}/stream`, {
        headers: { authorization: `Bearer ${jwt}` },
        maxEvents: 3,
        timeoutMs: 60_000,
      });
      expect(head.length).toBe(3);
      expect(head.map((e) => e.type)).toContain("session.started");

      const tail = await streamUntilTerminal(sessionId, { startIndex: head.length });
      expect(tail.length).toBeGreaterThan(0);
      expect(tail.map((e) => e.type)).not.toContain("session.started");
      expect(tail.map((e) => e.type).at(-1)).toBe("session.waiting");
    },
    120_000,
  );

  test(
    "custom channel: 0.31 from(address).send() starts a session THROUGH the proxy; resolveSession snapshots its owner",
    async () => {
      // Route-prefix convention (locked): custom channel routes mount at the
      // RAW authored path, so trigger channels are authored under
      // /eve/v1/platform/<trigger> — already forwarded by the worker proxy.
      // This exercises the dispatcher → proxy → channel path end-to-end.
      //
      // 0.31 removed the bare `send` from RouteHandlerArgs; the channel now
      // uses `from(address).send(...)`. Channel-local continuation ADDRESSES
      // survive — it is the eve channel's HTTP protocol that went
      // ID-addressed, not the channel authoring API — so this test also pins
      // that distinction, which is easy to over-correct.
      const address = `spike-${crypto.randomUUID()}`;

      // Before any send, the address is unowned: only send() may create.
      const beforeRes = await fetch(
        `${PROXY_URL}/eve/v1/platform/dispatch/${address}`,
        { headers: { authorization: `Bearer ${jwt}` } },
      );
      expect(beforeRes.status).toBe(200);
      expect(((await beforeRes.json()) as { sessionId: string | null }).sessionId).toBeNull();

      const res = await fetch(`${PROXY_URL}/eve/v1/platform/dispatch`, {
        body: JSON.stringify({ address, message: "Reply with exactly: dispatched" }),
        headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
        method: "POST",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; address: string; sessionId: string };
      expect(body.ok).toBe(true);
      expect(body.address).toBe(address);
      expect(typeof body.sessionId).toBe("string");

      const unauth = await fetch(`${PROXY_URL}/eve/v1/platform/dispatch`, {
        body: JSON.stringify({ message: "nope" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(unauth.status).toBe(401);

      const events = await streamUntilTerminal(body.sessionId);
      expect(finalAssistantText(events)).toBe("dispatched");

      // resolveSession(address) now snapshots the SAME durable session — the
      // 0.31 replacement for "hand the caller back a continuation token".
      const afterRes = await fetch(
        `${PROXY_URL}/eve/v1/platform/dispatch/${address}`,
        { headers: { authorization: `Bearer ${jwt}` } },
      );
      expect(((await afterRes.json()) as { sessionId: string | null }).sessionId).toBe(
        body.sessionId,
      );
    },
    180_000,
  );

  test(
    "DURABILITY GATE: approval parks (input.requested, session.waiting) -> SIGKILL eve -> restart -> inputResponses resumes and completes",
    async () => {
      const notesLog = join(markerDir(), "notes.log");
      const sessionId = await createSession(
        "Call the record_note tool with note: 'durability-proof'.",
      );

      // 1. Park: approval request surfaces, session parks durably.
      const parked = await readNdjson(`${PROXY_URL}/eve/v1/session/${sessionId}/stream`, {
        headers: { authorization: `Bearer ${jwt}` },
        timeoutMs: 90_000,
        until: (event, all) =>
          event.type === "session.waiting" && all.some((e) => e.type === "input.requested"),
      });
      const inputRequested = parked.find((e) => e.type === "input.requested") as
        | {
            data?: {
              requests?: {
                requestId: string;
                kind?: string;
                action?: { toolName?: string };
              }[];
            };
          }
        | undefined;
      const request = inputRequested?.data?.requests?.[0];
      expect(request).toBeDefined();
      expect(request?.action?.toolName).toBe("record_note");
      // 0.28 added a REQUIRED `kind` discriminator so a client can route a
      // tool approval, a free-text question and the session-limit Approve/Stop
      // prompt explicitly instead of inferring from the tool name.
      expect(request?.kind).toBe("tool-approval");
      expect(parked.map((e) => e.type).at(-1)).toBe("session.waiting");
      expect(existsSync(notesLog)).toBe(false); // gated tool must NOT have run

      writeFileSync(
        join(ARTIFACTS_DIR, "mocked-parked-events.ndjson"),
        parked.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );

      // 2. Kill the runtime hard while parked; all state must live in Postgres.
      const oldServerPid = await eve!.serverPid();
      expect(oldServerPid).not.toBeNull();
      await eve!.killHard();

      // 3. Fresh process, same world. Prove it IS a different process.
      eve = await startEve({ mockModels: true });
      const newServerPid = await eve.serverPid();
      expect(newServerPid).not.toBeNull();
      expect(newServerPid).not.toBe(oldServerPid);

      // 4. Approve through the new process. 0.31's `respond` form addresses
      //    the session by ID in the PATH and carries inputResponses ALONE —
      //    the old `{continuationToken, inputResponses}` body would now 400.
      const resume = await respond(sessionId, [
        { optionId: "approve", requestId: request!.requestId },
      ]);
      expect(resume.status).toBe(202);
      expect(resume.json.status).toBe("accepted");
      expect(resume.json.sessionId).toBe(sessionId);

      const resumed = await streamUntilTerminal(sessionId, {
        startIndex: parked.length,
        timeoutMs: 120_000,
      });
      const types = resumed.map((e) => e.type);
      expect(types).toContain("action.result");
      const actionResult = resumed.find((e) => e.type === "action.result") as
        | { data?: { status?: string } }
        | undefined;
      expect(actionResult?.data?.status).toBe("completed");
      expect(types.at(-1)).toBe("session.waiting");

      // 5. The side effect really happened, in the NEW process.
      expect(existsSync(notesLog)).toBe(true);
      expect(readFileSync(notesLog, "utf8")).toContain("durability-proof");

      writeFileSync(
        join(ARTIFACTS_DIR, "mocked-resumed-events.ndjson"),
        resumed.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
    },
    300_000,
  );

  test(
    "ID-addressed follow-up continues the same durable session",
    async () => {
      const sessionId = await createSession("Reply with exactly: first-turn");
      const firstEvents = await streamUntilTerminal(sessionId);
      expect(finalAssistantText(firstEvents)).toBe("first-turn");

      const second = await sendFollowUp(sessionId, "Reply with exactly: second-turn");
      expect(second.status).toBe(202);
      expect(second.json.sessionId).toBe(sessionId);
      expect(second.json.status).toBe("accepted");
      const followUp = await streamUntilTerminal(sessionId, {
        startIndex: firstEvents.length,
      });
      const types = followUp.map((e) => e.type);
      // Same durable session, a second turn — not a new session.
      expect(types).not.toContain("session.started");
      expect(types).toContain("turn.started");
      expect(finalAssistantText(followUp)).toBe("second-turn");
    },
    180_000,
  );

  test(
    "follow-up body guards: message XOR inputResponses, and an unknown id answers 409 session_not_active",
    async () => {
      const sessionId = await createSession("Reply with exactly: guarded");
      await streamUntilTerminal(sessionId);

      // 0.31 made send and respond mutually exclusive on the wire.
      const both = await postJson(`/eve/v1/session/${sessionId}`, {
        inputResponses: [{ optionId: "approve", requestId: "req-nope" }],
        message: "hello",
      });
      expect(both.status).toBe(400);
      expect(String(both.json.error)).toContain("mutually exclusive");

      const neither = await postJson(`/eve/v1/session/${sessionId}`, {});
      expect(neither.status).toBe(400);

      // `inputResponses` is create-only-forbidden in the other direction too.
      const onCreate = await postJson("/eve/v1/session", {
        inputResponses: [{ optionId: "approve", requestId: "req-nope" }],
      });
      expect(onCreate.status).toBe(400);
      expect(String(onCreate.json.error)).toContain("only accepted for an existing session");

      // The one stable machine-readable error code in the whole session
      // surface. Every OTHER 4xx carries `error` but no `code`.
      const unknown = await sendFollowUp("ses_does_not_exist", "hello");
      expect(unknown.status).toBe(409);
      expect(unknown.json.ok).toBe(false);
      expect(unknown.json.code).toBe("session_not_active");
    },
    120_000,
  );

  test(
    "every stream event carries a stable evt_ ULID meta.id (identical across a rewind)",
    async () => {
      // 0.28 added `meta.id`, stamped ONCE before the durable write, so a
      // reconnect / rewind / replay yields the SAME ids. That stability is
      // what lets a consumer dedupe on identity instead of index arithmetic.
      // NOTE the id is NOT a safe cursor: ULIDs are time-ordered but not
      // totally ordered across steps, so `startIndex` stays authoritative.
      const sessionId = await createSession("Reply with exactly: stamped");
      const live = await streamUntilTerminal(sessionId);
      expect(live.length).toBeGreaterThan(3);

      const ids = live.map((e) => (e.meta as { id?: string } | undefined)?.id);
      for (const id of ids) expect(String(id)).toMatch(EVE_EVENT_ID_PATTERN);
      expect(new Set(ids).size).toBe(ids.length); // unique within the session

      // Rewind the very same durable stream from the start.
      const replayed = await streamUntilTerminal(sessionId, { startIndex: 0 });
      expect(replayed.map((e) => (e.meta as { id?: string } | undefined)?.id)).toEqual(ids);
      expect(replayed.map((e) => e.type)).toEqual(live.map((e) => e.type));

      writeFileSync(
        join(ARTIFACTS_DIR, "mocked-event-ids.ndjson"),
        live.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
    },
    180_000,
  );

  test(
    "control routes: cancel / clear / compact / reset (status codes, stream effects, and the retired id)",
    async () => {
      const sessionId = await createSession("Reply with exactly: controlled");
      const settled = await streamUntilTerminal(sessionId);
      expect(settled.map((e) => e.type).at(-1)).toBe("session.waiting");
      let cursor = settled.length;

      // CANCEL on a live session that is merely IDLE still answers 202
      // `accepted`. This is NOT what the status name suggests: `cancel` is a
      // command queued into the durable session inbox, so `accepted` means
      // "the inbox took it", not "a turn was stopped". Empirically confirmed
      // here and in eve's dist — `inactiveCommandResult()` renders the SAME
      // inactive-hook condition as `session_not_active` (send),
      // `no_active_turn` (cancel) and `no_active_session` (clear/compact/
      // reset). So `no_active_turn` means "no live session", never "no turn
      // was running". Nothing may infer turn liveness from this response.
      // The body is a zero-byte POST, which the route must accept.
      const cancel = await postJson(`/eve/v1/session/${sessionId}/cancel`);
      expect(cancel.status).toBe(202);
      expect(cancel.json).toEqual({ ok: true, sessionId, status: "accepted" });

      // COMPACT: summarizes model context without adding a synthetic user
      // message. A SUCCESS emits compaction.requested -> compaction.completed
      // -> session.waiting; a FAILED summarization still returns to
      // session.waiting with history intact and simply omits
      // compaction.completed, so `requested` is the assertable invariant.
      //
      // ORDER MATTERS: compact runs BEFORE clear here because compacting an
      // already-cleared session emits NO compaction.* events at all — just
      // session.waiting (observed on 0.31.3). Nothing to summarize, nothing
      // requested. A caller waiting on compaction.requested to confirm the
      // command landed would hang forever on an empty context; the 202 is the
      // only reliable acknowledgement.
      const compact = await postJson(`/eve/v1/session/${sessionId}/compact`);
      expect(compact.status).toBe(202);
      expect(compact.json).toEqual({ ok: true, sessionId, status: "accepted" });
      const compacted = await streamUntilTerminal(sessionId, { startIndex: cursor });
      expect(compacted.map((e) => e.type)).toContain("compaction.requested");
      expect(compacted.map((e) => e.type).at(-1)).toBe("session.waiting");
      cursor += compacted.length;

      // CLEAR: drops model history in place, keeps the session id, its
      // durable state and its address ownership. Emits context.cleared then
      // session.waiting.
      const clear = await postJson(`/eve/v1/session/${sessionId}/clear`);
      expect(clear.status).toBe(202);
      expect(clear.json).toEqual({ ok: true, sessionId, status: "accepted" });
      const cleared = await streamUntilTerminal(sessionId, { startIndex: cursor });
      expect(cleared.map((e) => e.type)).toContain("context.cleared");
      expect(cleared.map((e) => e.type).at(-1)).toBe("session.waiting");
      cursor += cleared.length;

      // The session is still usable after compact + clear.
      const stillAlive = await sendFollowUp(sessionId, "Reply with exactly: alive");
      expect(stillAlive.status).toBe(202);
      await streamUntilTerminal(sessionId, { startIndex: cursor });

      // RESET is the odd one out: it NEVER returns 202 — both outcomes are
      // HTTP 200 — and its success field is `previousSessionId`, not
      // `sessionId`. Code that asserts 202 or reads `sessionId` breaks on
      // reset alone, and only at runtime.
      const reset = await postJson(`/eve/v1/session/${sessionId}/reset`, {
        reason: "spike control-route coverage",
      });
      expect(reset.status).toBe(200);
      expect(reset.json).toEqual({
        ok: true,
        previousSessionId: sessionId,
        status: "reset",
      });

      // The retired id can NEVER accept another message. This is the
      // permanent flavour of 409 session_not_active — the one a caller must
      // not retry.
      const afterReset = await sendFollowUp(sessionId, "anyone home?");
      expect(afterReset.status).toBe(409);
      expect(afterReset.json.code).toBe("session_not_active");

      // Control routes on a retired id degrade benignly rather than 409 —
      // and THIS is the only condition that produces `no_active_turn` /
      // `no_active_session`. All three inactive statuses are one condition
      // (a dead session inbox) wearing three names.
      const resetAgain = await postJson(`/eve/v1/session/${sessionId}/reset`);
      expect(resetAgain.status).toBe(200);
      expect(resetAgain.json).toEqual({ ok: true, status: "no_active_session" });
      const clearRetired = await postJson(`/eve/v1/session/${sessionId}/clear`);
      expect(clearRetired.status).toBe(200);
      expect(clearRetired.json).toEqual({ ok: true, status: "no_active_session" });
      const compactRetired = await postJson(`/eve/v1/session/${sessionId}/compact`);
      expect(compactRetired.status).toBe(200);
      expect(compactRetired.json).toEqual({ ok: true, status: "no_active_session" });
      const cancelRetired = await postJson(`/eve/v1/session/${sessionId}/cancel`);
      expect(cancelRetired.status).toBe(200);
      expect(cancelRetired.json).toEqual({ ok: true, status: "no_active_turn" });
    },
    240_000,
  );

  test(
    "cancelling an IN-FLIGHT turn emits turn.cancelled -> session.waiting, and is NOT a failure",
    async () => {
      // eve is explicit that cancellation is a user decision, never an error:
      // the turn ends WITHOUT turn.failed/session.failed, is followed by
      // session.waiting, and the session accepts the next message normally.
      // Anything mapping this onto a failed run would be wrong.
      //
      // Two empirical facts shape this test:
      //   1. Cancel targets ONLY the turn active when the command LANDS. It
      //      does not arm a pending cancellation for a turn that has not
      //      begun — cancelling before turn.started let the whole turn run to
      //      completion with no turn.cancelled at all.
      //   2. Cancellation is COOPERATIVE, applied at the next durable step
      //      boundary. An in-flight tool call still runs to completion and
      //      still emits its action.result; the turn ends after that step,
      //      not mid-tool. So a Stop press cannot un-do a side effect that
      //      was already in progress.
      // Every other mocked flow settles in ~200 ms, so an in-flight turn is
      // unraceable; the un-gated slow_task tool holds one open across a step
      // boundary long enough to cancel it deterministically.
      const sessionId = await createSession(
        "Call the slow_task tool with seconds: 5.",
      );

      // Wait until the turn is genuinely running before cancelling.
      const started = await readNdjson(`${PROXY_URL}/eve/v1/session/${sessionId}/stream`, {
        headers: { authorization: `Bearer ${jwt}` },
        timeoutMs: 60_000,
        until: (event) => event.type === "actions.requested",
      });
      expect(started.map((e) => e.type)).toContain("turn.started");
      expect(started.map((e) => e.type)).toContain("actions.requested");

      const cancel = await postJson(`/eve/v1/session/${sessionId}/cancel`);
      expect(cancel.status).toBe(202);
      expect(cancel.json).toEqual({ ok: true, sessionId, status: "accepted" });

      const events = await streamUntilTerminal(sessionId, { timeoutMs: 120_000 });
      const types = events.map((e) => e.type);
      expect(types).toContain("turn.cancelled");
      expect(types).not.toContain("turn.failed");
      expect(types).not.toContain("session.failed");
      expect(types.at(-1)).toBe("session.waiting");
      // Fact 2 above: the tool that was mid-flight still settled.
      expect(types).toContain("action.result");
      // turn.cancelled is emitted INSTEAD of turn.completed, and the pair
      // (turn.cancelled -> session.waiting) is the terminal sequence.
      expect(types).not.toContain("turn.completed");
      expect(types.slice(-2)).toEqual(["turn.cancelled", "session.waiting"]);
      // turn.cancelled carries the turn it stopped.
      const cancelled = events.find((e) => e.type === "turn.cancelled") as
        | { data?: { turnId?: string } }
        | undefined;
      expect(typeof cancelled?.data?.turnId).toBe("string");

      // The session survives cancellation and takes the next message.
      const next = await sendFollowUp(sessionId, "Reply with exactly: after-cancel");
      expect(next.status).toBe(202);

      writeFileSync(
        join(ARTIFACTS_DIR, "mocked-cancelled-events.ndjson"),
        events.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
    },
    240_000,
  );

  test.skipIf(SANDBOX_SKIP)(
    "docker() sandbox executes bash, writes /workspace/proof.txt, and the file persists across turns in-session",
    async () => {
      // SPIKE_REQUIRE_SANDBOX=1: fail loudly instead of running against a
      // missing image (docker errors would otherwise surface confusingly).
      if (!SANDBOX_IMAGE_AVAILABLE) {
        throw new Error(
          "ghcr.io/vercel/eve:latest is not pulled but SPIKE_REQUIRE_SANDBOX=1 — pull the image in CI setup",
        );
      }

      // Turn 1: write the file inside the sandbox.
      const sessionId = await createSession(
        "Use the bash tool to run `echo spike-sandbox-ok > /workspace/proof.txt && cat /workspace/proof.txt`.",
      );
      const events = await streamUntilTerminal(sessionId, { timeoutMs: 240_000 });
      const types = events.map((e) => e.type);
      expect(types).toContain("actions.requested");
      expect(types).toContain("action.result");
      const bashResult = events.find(
        (e) =>
          e.type === "action.result" &&
          (e as { data?: { result?: { toolName?: string } } }).data?.result?.toolName === "bash",
      ) as { data?: { status?: string; result?: { output?: unknown } } } | undefined;
      expect(bashResult).toBeDefined();
      expect(bashResult?.data?.status).toBe("completed");
      expect(JSON.stringify(bashResult?.data?.result?.output ?? "")).toContain(
        "spike-sandbox-ok",
      );

      writeFileSync(
        join(ARTIFACTS_DIR, "mocked-sandbox-events.ndjson"),
        events.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );

      // Turn 2 (acceptance bullet 4, second clause): a FOLLOW-UP turn in the
      // same session reads the file written in the prior turn — sandbox
      // lifetime is sticky for the session, not per-turn.
      const second = await sendFollowUp(
        sessionId,
        "Use the bash tool to run `cat /workspace/proof.txt`.",
      );
      expect(second.status).toBe(202);
      const followUp = await streamUntilTerminal(sessionId, {
        startIndex: events.length,
        timeoutMs: 240_000,
      });
      const followUpTypes = followUp.map((e) => e.type);
      expect(followUpTypes).not.toContain("session.started"); // same session
      const secondBash = followUp.find(
        (e) =>
          e.type === "action.result" &&
          (e as { data?: { result?: { toolName?: string } } }).data?.result?.toolName === "bash",
      ) as { data?: { status?: string; result?: { output?: unknown } } } | undefined;
      expect(secondBash).toBeDefined();
      expect(secondBash?.data?.status).toBe("completed");
      expect(JSON.stringify(secondBash?.data?.result?.output ?? "")).toContain(
        "spike-sandbox-ok",
      );

      writeFileSync(
        join(ARTIFACTS_DIR, "mocked-sandbox-second-turn-events.ndjson"),
        followUp.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
    },
    600_000,
  );
});
