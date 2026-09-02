/**
 * HTTP client for worker-hosted agents.
 *
 * Two planes:
 * - INTERNAL (shared-secret): `POST <worker>/internal/agents/ensure` with
 *   `{versionHash, artifactUrl, env}` and the `x-worker-secret` header asks
 *   the supervisor to have the agent for `versionHash` running (pull+extract
 *   artifact, spawn the agent server, wait healthy). Idempotent. This is the
 *   contract apps/worker/src/server.ts actually serves (reconciled at the
 *   Integrate stage; see docs/runtime-worker-contract.md).
 * - AGENT PROXY (platform JWT): `<worker>/agents/:hash/eve/v1/...` forwards
 *   to the agent's eve channel routes (the worker proxy forwards BOTH /eve/
 *   and /.well-known/workflow/ under /agents/:hash/).
 *
 * eve SESSION API v2 (eve@0.31.3 — the shapes live in
 * `@invisible-string/shared`'s `eve-session-api`, extracted from the shipped
 * package; this module is the transport for them):
 *
 * ```
 * POST /eve/v1/session          {message, mode?, outputSchema?}
 *                                                    → 202 {ok,sessionId,status:"accepted"}
 * POST /eve/v1/session/:id      {message} XOR {inputResponses}
 *                                                    → 202 {ok,sessionId,status:"accepted"}
 *                                                    → 409 {ok:false,code:"session_not_active"}
 * POST /eve/v1/session/:id/cancel  {turnId?}         → 202 accepted | 200 no_active_turn
 * POST /eve/v1/session/:id/clear   (empty)           → 202 accepted | 200 no_active_session
 * POST /eve/v1/session/:id/compact (empty)           → 202 accepted | 200 no_active_session
 * POST /eve/v1/session/:id/reset   {reason?}         → 200 {previousSessionId,status:"reset"}
 *                                                            | 200 no_active_session
 * GET  /eve/v1/session/:id/stream?startIndex=&includeTailIndex=1 → NDJSON
 * ```
 *
 * THREE THINGS THAT WILL BITE YOU:
 *
 * 1. **Continuation tokens are gone, and their mere presence is a 400.** eve
 *    runs `rejectSessionContinuationToken()` on EVERY route above and the
 *    check is `"continuationToken" in body` — not truthiness. So a body built
 *    as `{continuationToken: x ?? null, message}` fails closed with a 400 that
 *    reads like a malformed request. Bodies here are built from the shared
 *    discriminated union so the key cannot appear.
 * 2. **`session_not_active` is PERMANENT for that session id** — it covers
 *    unknown, terminal, timed-out and reset sessions, not "a turn is running".
 *    It is surfaced as {@link EveSessionNotActiveError} so callers can take a
 *    recovery path (release the Slack thread claim, start a new session)
 *    instead of the generic 502 `worker_dispatch_failed`. The PLATFORM's own
 *    `session_busy` (one tail per eve stream) is a different, transient thing.
 * 3. **`no_active_turn` / `no_active_session` are not "nothing to do".** eve
 *    renders ONE dead-session condition under those two names and under the
 *    409 — a 202 on cancel never proves a turn was stopped, and a 200 never
 *    proves the session was healthy. Callers must not infer liveness here.
 *
 * `streamReconnectPolicy: {reconnect:false}` and `follow:false` are
 * `eve/client` SDK options, NOT wire fields. This client is hand-rolled fetch
 * and the tailer owns cursor recovery, so those semantics hold structurally —
 * but any future `eve/client` adoption (spike harnesses, evals) MUST pass
 * `{reconnect:false}` or eve's internal reconnect loop contends with ours and
 * double-consumes the cursor. The bounded catch-up read is `includeTailIndex`
 * below; there is no `follow` query parameter to send.
 */
import {
  DISPATCH_TOKEN_HEADER,
  EVE_SESSION_ID_HEADER,
  WORKER_ID_HEADER,
  eveSessionCancelPath,
  eveSessionClearPath,
  eveSessionCompactPath,
  eveSessionPath,
  eveSessionResetPath,
  eveSessionStreamPath,
  eveStreamQueryString,
  isEveSessionNotActive,
  EVE_SESSION_ROUTE_PATH,
  type EveCancelTurnResponse,
  type EveClearSessionResponse,
  type EveCompactSessionResponse,
  type EveCreateSessionRequest,
  type EveResetSessionResponse,
  type EveSessionFollowUpRequest,
} from "@invisible-string/shared";

export interface EnsureAgentRequest {
  /** Presigned artifact GET URL (tar.gz of the built agent). */
  artifactUrl: string;
  /**
   * Full process env for the agent (secrets included — spawn-time injection
   * only; the supervisor must never write these to disk or logs).
   */
  env: Record<string, string>;
  /**
   * Target worker id — enables the per-worker DISPATCH token (Phase-3 identity)
   * when the client is configured with `mintDispatchToken`. The token's
   * audience is `worker:<id>`, so a captured dispatch cannot be replayed at a
   * different worker.
   */
  workerId?: string;
}

/**
 * `POST /eve/v1/session` result. 0.31 returns no continuation token — the
 * session id in the path IS the handle for every later call.
 */
export interface EveSessionCreated {
  sessionId: string;
}

/**
 * `POST /eve/v1/session/:id` body — send XOR respond, from the shared
 * contract. Re-exported so call sites read as one protocol, not two.
 */
export type EveContinueRequest = EveSessionFollowUpRequest;

/** An accepted follow-up (202). A terminal session throws instead. */
export interface EveContinueResult {
  sessionId: string;
  status: "accepted";
}

/**
 * eve answered 409 `session_not_active`: this session id is PERMANENTLY
 * unusable (unknown, terminal, timed out, or reset). The recovery is never
 * "retry" — release whatever claim points at it and create a new session.
 *
 * Thrown (rather than returned) so every existing `catch` keeps failing the
 * run; callers that HAVE a recovery path check {@link isEveSessionNotActiveError}
 * before falling through to `failDispatch`.
 */
export class EveSessionNotActiveError extends Error {
  override readonly name = "EveSessionNotActiveError";
  readonly code = "session_not_active";
  constructor(
    readonly eveSessionId: string,
    detail?: string,
  ) {
    super(
      `eve session ${eveSessionId} is no longer active${detail ? `: ${detail}` : ""}`,
    );
  }
}

export function isEveSessionNotActiveError(
  value: unknown,
): value is EveSessionNotActiveError {
  return value instanceof EveSessionNotActiveError;
}

/** Options for a stream open — see {@link WorkerClient.openEventStream}. */
export interface OpenEventStreamOptions {
  /**
   * Ask eve for the `x-eve-stream-tail-index` response header so the caller
   * can run a BOUNDED catch-up read. Request it only on the FIRST open of such
   * a read: re-requesting it on every reconnect re-pins the bound and turns
   * the read into a moving target that never terminates.
   */
  includeTailIndex?: boolean;
}

export interface WorkerClient {
  ensureAgent(
    workerAddress: string,
    contentHash: string,
    request: EnsureAgentRequest,
  ): Promise<void>;
  /**
   * Create an ID-addressed session with its first message. The request is the
   * SHARED create contract ({@link EveCreateSessionRequest}): chat and thread
   * continuations send `{message}` alone; a pipeline agent step's
   * `session: "fresh"` child adds `mode: "task"` (+ `outputSchema` when the
   * step declares one — spike finding 36).
   */
  createEveSession(
    workerAddress: string,
    contentHash: string,
    jwt: string,
    request: EveCreateSessionRequest,
  ): Promise<EveSessionCreated>;
  /**
   * Follow up on an existing session (send XOR respond). Throws
   * {@link EveSessionNotActiveError} on eve's 409.
   */
  continueEveSession(
    workerAddress: string,
    contentHash: string,
    jwt: string,
    eveSessionId: string,
    request: EveContinueRequest,
  ): Promise<EveContinueResult>;
  /**
   * Cancel the in-flight turn. Fire-and-forget safe and idempotent; a turnId
   * naming another turn is consumed as a no-op, so a guarded cancel racing a
   * turn boundary cannot stop a turn the user never saw. NEVER 409s.
   */
  cancelEveTurn(
    workerAddress: string,
    contentHash: string,
    jwt: string,
    eveSessionId: string,
    options?: { turnId?: string },
  ): Promise<EveCancelTurnResponse>;
  /** Clear durable model history, keep the session id. */
  clearEveSession(
    workerAddress: string,
    contentHash: string,
    jwt: string,
    eveSessionId: string,
  ): Promise<EveClearSessionResponse>;
  /** Summarize + compact context. May emit no `compaction.*` at all. */
  compactEveSession(
    workerAddress: string,
    contentHash: string,
    jwt: string,
    eveSessionId: string,
  ): Promise<EveCompactSessionResponse>;
  /** Retire the session id permanently (always HTTP 200). */
  resetEveSession(
    workerAddress: string,
    contentHash: string,
    jwt: string,
    eveSessionId: string,
    options?: { reason?: string },
  ): Promise<EveResetSessionResponse>;
  /** Open the NDJSON stream (caller owns the AbortSignal + body). */
  openEventStream(
    workerAddress: string,
    contentHash: string,
    jwt: string,
    eveSessionId: string,
    startIndex: number,
    signal: AbortSignal,
    options?: OpenEventStreamOptions,
  ): Promise<Response>;
}

export function agentProxyBase(workerAddress: string, contentHash: string): string {
  return `${workerAddress.replace(/\/+$/, "")}/agents/${contentHash}`;
}

export interface CreateWorkerClientOptions {
  workerSharedSecret: string;
  /**
   * Allow secret-bearing calls to http:// worker addresses
   * (ALLOW_INSECURE_WORKER_TRANSPORT=1 — local dev/CI only). The ensure-agent
   * payload carries the agent's full env map; plaintext transport exposes it
   * on any observable network segment.
   */
  allowInsecureWorkerTransport?: boolean;
  /** Per-request timeout for non-streaming calls (default 60s — ensure-agent
   *  may pull + boot the agent synchronously in v1). */
  requestTimeoutMs?: number;
  /**
   * When set, mint a per-worker DISPATCH token for each ensure-agent call
   * (Phase-3 worker identity; `worker-token` mode). The worker verifies it via
   * `x-dispatch-token` in addition to (or instead of) the bootstrap secret.
   */
  mintDispatchToken?: (workerId: string) => string;
  fetchImpl?: typeof fetch;
}

/**
 * ensure-agent attempts per call (1 original + 1 retry). The retry fires ONLY
 * on a client-side timeout: a COLD first boot (artifact download + extract +
 * node boot + world/graphile migration) can outlast the request timeout while
 * the worker keeps booting — the supervisor's ensure is single-flight per
 * hash and reuses ready agents, so a retry joins the in-flight boot (or
 * fast-returns once ready) instead of 502-failing the very first session on
 * a fresh version. HTTP errors are NOT retried (deterministic failures).
 * Scheduler placement reservations must outlive timeout × attempts
 * (scheduler.setAgentReservationTtlMs, wired in index.ts).
 */
export const ENSURE_AGENT_MAX_ATTEMPTS = 2;

function isTimeoutError(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.name === "TimeoutError" || error.name === "AbortError")
  );
}

export function createWorkerClient(options: CreateWorkerClientOptions): WorkerClient {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.requestTimeoutMs ?? 60_000;
  const allowInsecureHttp = options.allowInsecureWorkerTransport === true;

  async function readError(res: Response): Promise<string> {
    const text = await res.text().catch(() => "");
    return `${res.status} ${text.slice(0, 500)}`;
  }

  function assertSecureTransport(workerAddress: string): void {
    if (allowInsecureHttp) return;
    if (!workerAddress.startsWith("http://")) return;
    throw new Error(
      `refusing to send agent secrets to plaintext worker address ${workerAddress} — ` +
        "use https:// (or ALLOW_INSECURE_WORKER_TRANSPORT=1 for local dev only)",
    );
  }

  /**
   * One authenticated POST to an eve session route. `body` is serialized as-is
   * — callers pass shared-contract shapes, so the forbidden `continuationToken`
   * key can never appear. Returns the parsed JSON body on 2xx; every non-2xx
   * throws, with eve's 409 lifted to {@link EveSessionNotActiveError}.
   */
  async function postEve<T>(
    workerAddress: string,
    contentHash: string,
    jwt: string,
    path: string,
    body: unknown,
    context: { label: string; eveSessionId?: string },
  ): Promise<T> {
    const res = await doFetch(`${agentProxyBase(workerAddress, contentHash)}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${jwt}`,
        "content-type": "application/json",
      },
      body: JSON.stringify(body ?? {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.status < 200 || res.status >= 300) {
      // Read the body ONCE, then decide: eve's machine-readable `code` is the
      // only thing distinguishing a permanently dead session from a dead
      // worker, and collapsing them into a bare Error strands every recovery
      // path downstream.
      const text = await res.text().catch(() => "");
      let parsed: unknown = undefined;
      try {
        parsed = JSON.parse(text) as unknown;
      } catch {
        parsed = undefined;
      }
      if (context.eveSessionId && isEveSessionNotActive(res.status, parsed)) {
        throw new EveSessionNotActiveError(context.eveSessionId, text.slice(0, 200));
      }
      throw new Error(`${context.label} failed: ${res.status} ${text.slice(0, 500)}`);
    }
    return (await res.json().catch(() => ({}))) as T;
  }

  return {
    async ensureAgent(workerAddress, contentHash, request) {
      assertSecureTransport(workerAddress);
      const { workerId: _workerId, ...ensureBody } = request;
      const attempt = async (): Promise<void> => {
        // Headers are built PER ATTEMPT: dispatch tokens are single-use
        // (worker jti replay guard), so a retry must mint a fresh one.
        const headers: Record<string, string> = {
          "content-type": "application/json",
        };
        // Per-worker dispatch token (Phase-3 identity) when configured. The
        // bootstrap secret is NOT sent alongside it — otherwise every ensure
        // call would hand the fleet-master secret to the (possibly
        // compromised) worker, undercutting the whole point of per-worker
        // identity. Workers verify dispatch tokens with their own copy of the
        // bootstrap secret + their id, so this works against
        // shared-secret-mode workers too.
        if (options.mintDispatchToken && request.workerId) {
          headers[DISPATCH_TOKEN_HEADER] = options.mintDispatchToken(request.workerId);
          headers[WORKER_ID_HEADER] = request.workerId;
        } else {
          headers["x-worker-secret"] = options.workerSharedSecret;
        }
        const res = await doFetch(
          `${workerAddress.replace(/\/+$/, "")}/internal/agents/ensure`,
          {
            method: "POST",
            headers,
            body: JSON.stringify({ versionHash: contentHash, ...ensureBody }),
            signal: AbortSignal.timeout(timeoutMs),
          },
        );
        if (!res.ok) {
          throw new Error(`ensure-agent failed: ${await readError(res)}`);
        }
      };
      for (let attempts = 1; ; attempts += 1) {
        try {
          await attempt();
          return;
        } catch (error) {
          // Timeouts only — the worker may still be mid-boot (cold artifact
          // pull); its single-flight ensure makes another attempt safe and
          // usually fast. Everything else propagates unchanged.
          if (attempts >= ENSURE_AGENT_MAX_ATTEMPTS || !isTimeoutError(error)) {
            throw error;
          }
        }
      }
    },

    async createEveSession(workerAddress, contentHash, jwt, request) {
      const res = await doFetch(
        `${agentProxyBase(workerAddress, contentHash)}${EVE_SESSION_ROUTE_PATH}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${jwt}`,
            "content-type": "application/json",
          },
          // The shared create contract, serialized as-is — create has no 409
          // path, and keys eve does not expect (notably `continuationToken`)
          // are a hard 400, so bodies are built ONLY from that strict shape.
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
      // eve acks session creation asynchronously with a 202.
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`eve session create failed: ${await readError(res)}`);
      }
      const json = (await res.json().catch(() => ({}))) as { sessionId?: unknown };
      // eve sets the id on BOTH the body and the header; the header is the
      // fallback its own client uses.
      const sessionId =
        typeof json.sessionId === "string" && json.sessionId.length > 0
          ? json.sessionId
          : (res.headers.get(EVE_SESSION_ID_HEADER) ?? "");
      if (sessionId.length === 0) {
        throw new Error("eve session create returned no sessionId");
      }
      return { sessionId };
    },

    async continueEveSession(workerAddress, contentHash, jwt, eveSessionId, request) {
      const json = await postEve<{ sessionId?: unknown }>(
        workerAddress,
        contentHash,
        jwt,
        eveSessionPath(eveSessionId),
        request,
        { label: "eve session continue", eveSessionId },
      );
      return {
        sessionId:
          typeof json.sessionId === "string" && json.sessionId.length > 0
            ? json.sessionId
            : eveSessionId,
        status: "accepted",
      };
    },

    async cancelEveTurn(workerAddress, contentHash, jwt, eveSessionId, opts) {
      // Omit the key entirely when there is no turnId — eve rejects bodies by
      // key presence, and a `{turnId: undefined}` literal only survives
      // because JSON.stringify drops it. Do not rely on that elsewhere.
      return postEve<EveCancelTurnResponse>(
        workerAddress,
        contentHash,
        jwt,
        eveSessionCancelPath(eveSessionId),
        opts?.turnId ? { turnId: opts.turnId } : {},
        { label: "eve session cancel", eveSessionId },
      );
    },

    async clearEveSession(workerAddress, contentHash, jwt, eveSessionId) {
      return postEve<EveClearSessionResponse>(
        workerAddress,
        contentHash,
        jwt,
        eveSessionClearPath(eveSessionId),
        {},
        { label: "eve session clear", eveSessionId },
      );
    },

    async compactEveSession(workerAddress, contentHash, jwt, eveSessionId) {
      return postEve<EveCompactSessionResponse>(
        workerAddress,
        contentHash,
        jwt,
        eveSessionCompactPath(eveSessionId),
        {},
        { label: "eve session compact", eveSessionId },
      );
    },

    async resetEveSession(workerAddress, contentHash, jwt, eveSessionId, opts) {
      return postEve<EveResetSessionResponse>(
        workerAddress,
        contentHash,
        jwt,
        eveSessionResetPath(eveSessionId),
        opts?.reason ? { reason: opts.reason } : {},
        { label: "eve session reset", eveSessionId },
      );
    },

    async openEventStream(
      workerAddress,
      contentHash,
      jwt,
      eveSessionId,
      startIndex,
      signal,
      streamOptions,
    ) {
      const query = eveStreamQueryString({
        startIndex,
        ...(streamOptions?.includeTailIndex === true
          ? { includeTailIndex: true }
          : {}),
      });
      return doFetch(
        `${agentProxyBase(workerAddress, contentHash)}${eveSessionStreamPath(eveSessionId)}${query}`,
        { headers: { authorization: `Bearer ${jwt}` }, signal },
      );
    },
  };
}
