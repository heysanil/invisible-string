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
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
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
      const { json, status } = await postJson("/eve/v1/session", {
        message: "Reply with exactly: pong",
      });
      expect(status).toBeLessThan(300);
      const events = await streamUntilTerminal(json.sessionId as string);
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
      const { json } = await postJson("/eve/v1/session", {
        message: "Reply with exactly: resume-me",
      });
      const sessionId = json.sessionId as string;

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
    "custom channel POST /eve/v1/platform/dispatch (JWT) starts a session via send() THROUGH the proxy",
    async () => {
      // Route-prefix convention (locked): custom channel routes mount at the
      // RAW authored path, so trigger channels are authored under
      // /eve/v1/platform/<trigger> — already forwarded by the worker proxy.
      // This exercises the dispatcher → proxy → channel path end-to-end.
      const res = await fetch(`${PROXY_URL}/eve/v1/platform/dispatch`, {
        body: JSON.stringify({ message: "Reply with exactly: dispatched" }),
        headers: { authorization: `Bearer ${jwt}`, "content-type": "application/json" },
        method: "POST",
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; sessionId: string };
      expect(body.ok).toBe(true);
      expect(typeof body.sessionId).toBe("string");

      const unauth = await fetch(`${PROXY_URL}/eve/v1/platform/dispatch`, {
        body: JSON.stringify({ message: "nope" }),
        headers: { "content-type": "application/json" },
        method: "POST",
      });
      expect(unauth.status).toBe(401);

      const events = await streamUntilTerminal(body.sessionId);
      expect(finalAssistantText(events)).toBe("dispatched");
    },
    120_000,
  );

  test(
    "DURABILITY GATE: approval parks (input.requested, session.waiting) -> SIGKILL eve -> restart -> inputResponses resumes and completes",
    async () => {
      const notesLog = join(markerDir(), "notes.log");
      const { json } = await postJson("/eve/v1/session", {
        message: "Call the record_note tool with note: 'durability-proof'.",
      });
      const sessionId = json.sessionId as string;
      const continuationToken = json.continuationToken as string;

      // 1. Park: approval request surfaces, session parks durably.
      const parked = await readNdjson(`${PROXY_URL}/eve/v1/session/${sessionId}/stream`, {
        headers: { authorization: `Bearer ${jwt}` },
        timeoutMs: 90_000,
        until: (event, all) =>
          event.type === "session.waiting" && all.some((e) => e.type === "input.requested"),
      });
      const inputRequested = parked.find((e) => e.type === "input.requested") as
        | { data?: { requests?: { requestId: string; action?: { toolName?: string } }[] } }
        | undefined;
      const request = inputRequested?.data?.requests?.[0];
      expect(request).toBeDefined();
      expect(request?.action?.toolName).toBe("record_note");
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

      // 4. Approve through the new process.
      const resume = await postJson(`/eve/v1/session/${sessionId}`, {
        continuationToken,
        inputResponses: [{ optionId: "approve", requestId: request!.requestId }],
      });
      expect(resume.status).toBeLessThan(300);

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
    "follow-up via continuation token continues the same durable session",
    async () => {
      const first = await postJson("/eve/v1/session", {
        message: "Reply with exactly: first-turn",
      });
      const sessionId = first.json.sessionId as string;
      const continuationToken = first.json.continuationToken as string;
      const firstEvents = await streamUntilTerminal(sessionId);
      expect(finalAssistantText(firstEvents)).toBe("first-turn");

      const second = await postJson(`/eve/v1/session/${sessionId}`, {
        continuationToken,
        message: "Reply with exactly: second-turn",
      });
      expect(second.status).toBeLessThan(300);
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
      const { json } = await postJson("/eve/v1/session", {
        message:
          "Use the bash tool to run `echo spike-sandbox-ok > /workspace/proof.txt && cat /workspace/proof.txt`.",
      });
      const sessionId = json.sessionId as string;
      const continuationToken = json.continuationToken as string;
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
      const second = await postJson(`/eve/v1/session/${sessionId}`, {
        continuationToken,
        message: "Use the bash tool to run `cat /workspace/proof.txt`.",
      });
      expect(second.status).toBeLessThan(300);
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
