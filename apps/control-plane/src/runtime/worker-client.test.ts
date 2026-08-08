/**
 * Worker-client ensure-agent retry semantics (regression for the keyed
 * acceptance finding: a COLD first agent boot can outlast the request
 * timeout, and without a retry the very first session on a fresh version
 * 502s and its run is marked failed).
 */
import { describe, expect, test } from "bun:test";

import { DISPATCH_TOKEN_HEADER } from "@invisible-string/shared";

import {
  createWorkerClient,
  ENSURE_AGENT_MAX_ATTEMPTS,
  isEveSessionNotActiveError,
  type EveSessionNotActiveError,
} from "./worker-client";

const ENSURE_REQUEST = {
  artifactUrl: "https://artifacts.example.com/a.tar.gz",
  env: { CONTENT_HASH: "h1" },
  workerId: "worker-1",
};

function timeoutError(): Error {
  return new DOMException("The operation timed out.", "TimeoutError");
}

describe("ensureAgent cold-boot retry", () => {
  test("retries once on a client timeout and succeeds (worker ensure is single-flight, so the retry joins the in-flight boot)", async () => {
    const calls: string[] = [];
    const client = createWorkerClient({
      workerSharedSecret: "secret",
      fetchImpl: (async (url: string | URL | Request) => {
        calls.push(String(url));
        if (calls.length === 1) throw timeoutError();
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    await client.ensureAgent("https://worker.example.com", "hash1", ENSURE_REQUEST);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toBe("https://worker.example.com/internal/agents/ensure");
  });

  test("mints a FRESH dispatch token per attempt (tokens are single-use — the worker's jti replay guard refuses a re-sent one)", async () => {
    let minted = 0;
    const tokens: (string | null)[] = [];
    const client = createWorkerClient({
      workerSharedSecret: "secret",
      mintDispatchToken: () => `token-${++minted}`,
      fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
        const headers = new Headers(init?.headers);
        tokens.push(headers.get(DISPATCH_TOKEN_HEADER));
        if (tokens.length === 1) throw timeoutError();
        return new Response("{}", { status: 200 });
      }) as unknown as typeof fetch,
    });
    await client.ensureAgent("https://worker.example.com", "hash1", ENSURE_REQUEST);
    expect(tokens).toEqual(["token-1", "token-2"]);
  });

  test("does NOT retry HTTP failures (deterministic errors propagate on the first attempt)", async () => {
    let calls = 0;
    const client = createWorkerClient({
      workerSharedSecret: "secret",
      fetchImpl: (async () => {
        calls += 1;
        return new Response("boot failed", { status: 500 });
      }) as unknown as typeof fetch,
    });
    await expect(
      client.ensureAgent("https://worker.example.com", "hash1", ENSURE_REQUEST),
    ).rejects.toThrow(/ensure-agent failed: 500/);
    expect(calls).toBe(1);
  });

  test("gives up after the attempt budget when every attempt times out", async () => {
    let calls = 0;
    const client = createWorkerClient({
      workerSharedSecret: "secret",
      fetchImpl: (async () => {
        calls += 1;
        throw timeoutError();
      }) as unknown as typeof fetch,
    });
    await expect(
      client.ensureAgent("https://worker.example.com", "hash1", ENSURE_REQUEST),
    ).rejects.toThrow(/timed out/);
    expect(calls).toBe(ENSURE_AGENT_MAX_ATTEMPTS);
  });
});

// ── eve session API v2 (0.31) ───────────────────────────────────────────────

interface Recorded {
  url: string;
  method: string;
  body: unknown;
}

function recordingClient(
  respond: (req: Recorded) => Response,
): { client: ReturnType<typeof createWorkerClient>; calls: Recorded[] } {
  const calls: Recorded[] = [];
  const client = createWorkerClient({
    workerSharedSecret: "s".repeat(32),
    allowInsecureWorkerTransport: true,
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const call: Recorded = {
        url: String(input),
        method: init?.method ?? "GET",
        body:
          typeof init?.body === "string"
            ? (JSON.parse(init.body) as unknown)
            : undefined,
      };
      calls.push(call);
      return respond(call);
    }) as unknown as typeof fetch,
  });
  return { client, calls };
}

const WORKER = "http://worker.test";
const HASH = "h".repeat(64);
const JWT = "jwt-token";

describe("createEveSession (0.31)", () => {
  test("accepts the 202 body with no continuation token and sends ONLY {message}", async () => {
    const { client, calls } = recordingClient(() =>
      Response.json({ ok: true, sessionId: "wrun_1", status: "accepted" }, { status: 202 }),
    );
    const created = await client.createEveSession(WORKER, HASH, JWT, "hello");
    expect(created).toEqual({ sessionId: "wrun_1" });
    // A `continuationToken` key — at ANY value, since eve's guard is
    // `key in body` — is a hard 400 on every session route.
    expect(calls[0]!.body).toEqual({ message: "hello" });
    expect(calls[0]!.url).toBe(`${WORKER}/agents/${HASH}/eve/v1/session`);
  });

  test("falls back to the x-eve-session-id header when the body omits the id", async () => {
    const { client } = recordingClient(
      () =>
        new Response(JSON.stringify({ ok: true, status: "accepted" }), {
          status: 202,
          headers: { "content-type": "application/json", "x-eve-session-id": "wrun_hdr" },
        }),
    );
    expect(await client.createEveSession(WORKER, HASH, JWT, "hi")).toEqual({
      sessionId: "wrun_hdr",
    });
  });
});

describe("continueEveSession (0.31)", () => {
  test("addresses the session by id and sends the bare send form", async () => {
    const { client, calls } = recordingClient(() =>
      Response.json({ ok: true, sessionId: "wrun_1", status: "accepted" }, { status: 202 }),
    );
    await client.continueEveSession(WORKER, HASH, JWT, "wrun_1", { message: "next" });
    expect(calls[0]!.url).toBe(`${WORKER}/agents/${HASH}/eve/v1/session/wrun_1`);
    expect(calls[0]!.body).toEqual({ message: "next" });
  });

  test("sends the respond form for HITL answers (mutually exclusive with message)", async () => {
    const { client, calls } = recordingClient(() =>
      Response.json({ ok: true, sessionId: "wrun_1", status: "accepted" }, { status: 202 }),
    );
    await client.continueEveSession(WORKER, HASH, JWT, "wrun_1", {
      inputResponses: [{ requestId: "r1", optionId: "approve" }],
    });
    expect(calls[0]!.body).toEqual({
      inputResponses: [{ requestId: "r1", optionId: "approve" }],
    });
  });

  test("lifts eve's 409 into a typed, PERMANENT session_not_active error", async () => {
    // Without this the 409 collapses into a bare Error → 502
    // worker_dispatch_failed, and nothing downstream can tell a terminal
    // session from a dead worker, so no recovery is possible.
    const { client } = recordingClient(() =>
      Response.json(
        { ok: false, code: "session_not_active", error: "The session is no longer active." },
        { status: 409 },
      ),
    );
    const error = await client
      .continueEveSession(WORKER, HASH, JWT, "wrun_dead", { message: "hi" })
      .then(() => null)
      .catch((err: unknown) => err);
    expect(isEveSessionNotActiveError(error)).toBeTrue();
    expect((error as EveSessionNotActiveError).eveSessionId).toBe("wrun_dead");
  });

  test("a 409 WITHOUT eve's code is NOT session_not_active (stream-open 409s are retryable)", async () => {
    const { client } = recordingClient(() =>
      Response.json({ ok: false, error: "nope" }, { status: 409 }),
    );
    const error = await client
      .continueEveSession(WORKER, HASH, JWT, "wrun_1", { message: "hi" })
      .then(() => null)
      .catch((err: unknown) => err);
    expect(isEveSessionNotActiveError(error)).toBeFalse();
    expect(error).toBeInstanceOf(Error);
  });

  test("other non-2xx stay generic failures", async () => {
    const { client } = recordingClient(() => new Response("boom", { status: 502 }));
    await expect(
      client.continueEveSession(WORKER, HASH, JWT, "wrun_1", { message: "hi" }),
    ).rejects.toThrow(/eve session continue failed: 502/);
  });
});

describe("control routes (0.31)", () => {
  test("cancel posts an empty body when no turnId is scoped", async () => {
    const { client, calls } = recordingClient(() =>
      Response.json({ ok: true, sessionId: "wrun_1", status: "accepted" }, { status: 202 }),
    );
    const result = await client.cancelEveTurn(WORKER, HASH, JWT, "wrun_1");
    expect(calls[0]!.url).toBe(`${WORKER}/agents/${HASH}/eve/v1/session/wrun_1/cancel`);
    expect(calls[0]!.body).toEqual({});
    expect(result).toEqual({ ok: true, sessionId: "wrun_1", status: "accepted" });
  });

  test("cancel's 200 no_active_turn is a SUCCESS, not an error", async () => {
    const { client } = recordingClient(() =>
      Response.json({ ok: true, status: "no_active_turn" }, { status: 200 }),
    );
    expect(await client.cancelEveTurn(WORKER, HASH, JWT, "wrun_1")).toEqual({
      ok: true,
      status: "no_active_turn",
    });
  });

  test("clear and compact hit their own subroutes with empty bodies", async () => {
    const { client, calls } = recordingClient(() =>
      Response.json({ ok: true, sessionId: "wrun_1", status: "accepted" }, { status: 202 }),
    );
    await client.clearEveSession(WORKER, HASH, JWT, "wrun_1");
    await client.compactEveSession(WORKER, HASH, JWT, "wrun_1");
    expect(calls.map((c) => c.url)).toEqual([
      `${WORKER}/agents/${HASH}/eve/v1/session/wrun_1/clear`,
      `${WORKER}/agents/${HASH}/eve/v1/session/wrun_1/compact`,
    ]);
    expect(calls.every((c) => c.method === "POST" && Object.keys(c.body as object).length === 0)).toBeTrue();
  });

  test("reset answers HTTP 200 with previousSessionId (never 202, never `sessionId`)", async () => {
    const { client, calls } = recordingClient(() =>
      Response.json({ ok: true, previousSessionId: "wrun_1", status: "reset" }, { status: 200 }),
    );
    const result = await client.resetEveSession(WORKER, HASH, JWT, "wrun_1", {
      reason: "user asked",
    });
    expect(calls[0]!.body).toEqual({ reason: "user asked" });
    expect(result).toEqual({ ok: true, previousSessionId: "wrun_1", status: "reset" });
  });
});

describe("openEventStream (0.31)", () => {
  test("omits startIndex at 0 and never sends a `follow` parameter", async () => {
    const { client, calls } = recordingClient(() => new Response("", { status: 200 }));
    await client.openEventStream(WORKER, HASH, JWT, "wrun_1", 0, new AbortController().signal);
    expect(calls[0]!.url).toBe(`${WORKER}/agents/${HASH}/eve/v1/session/wrun_1/stream`);
  });

  test("opts into the tail-index header for a bounded catch-up read", async () => {
    const { client, calls } = recordingClient(() => new Response("", { status: 200 }));
    await client.openEventStream(
      WORKER,
      HASH,
      JWT,
      "wrun_1",
      12,
      new AbortController().signal,
      { includeTailIndex: true },
    );
    expect(calls[0]!.url).toBe(
      `${WORKER}/agents/${HASH}/eve/v1/session/wrun_1/stream?startIndex=12&includeTailIndex=1`,
    );
  });
});
