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
 * eve HTTP contract (Phase-0 verified):
 * - `POST /eve/v1/session` {message} → 202 {sessionId, continuationToken}
 * - `POST /eve/v1/session/:id` {continuationToken, message | inputResponses}
 *   → 202 (async — the turn runs in the durable queue)
 * - `GET /eve/v1/session/:id/stream?startIndex=N` → NDJSON
 */
import {
  DISPATCH_TOKEN_HEADER,
  WORKER_ID_HEADER,
  type EveInputResponse,
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

export interface EveSessionCreated {
  sessionId: string;
  continuationToken: string;
}

export interface EveContinueRequest {
  continuationToken: string;
  message?: string;
  inputResponses?: EveInputResponse[];
}

export interface EveContinueResult {
  /** eve may rotate the continuation token on follow-ups; null = unchanged. */
  continuationToken: string | null;
}

/**
 * A normalized TriggerEvent envelope POSTed to a compiled agent's custom
 * trigger channel. Structurally the platform's `TriggerEvent` (see
 * packages/shared) — kept as an index signature here so the client stays
 * decoupled from the shared type while carrying the full envelope.
 */
export type TriggerEventPayload = Record<string, unknown>;

export interface WorkerClient {
  ensureAgent(
    workerAddress: string,
    contentHash: string,
    request: EnsureAgentRequest,
  ): Promise<void>;
  createEveSession(
    workerAddress: string,
    contentHash: string,
    jwt: string,
    message: string,
  ): Promise<EveSessionCreated>;
  /**
   * POST a TriggerEvent to a compiled agent's custom trigger channel at the
   * locked route `/eve/v1/platform/<trigger>` (form/webhook/slack). The
   * channel calls send() and returns `{ ok, sessionId, continuationToken }`.
   * For threaded/continuation triggers the envelope carries a
   * `continuationToken` the channel passes to send() (same eve session).
   */
  postTriggerEvent(
    workerAddress: string,
    contentHash: string,
    jwt: string,
    triggerType: string,
    triggerEvent: TriggerEventPayload,
  ): Promise<EveSessionCreated>;
  continueEveSession(
    workerAddress: string,
    contentHash: string,
    jwt: string,
    eveSessionId: string,
    request: EveContinueRequest,
  ): Promise<EveContinueResult>;
  /** Open the NDJSON stream (caller owns the AbortSignal + body). */
  openEventStream(
    workerAddress: string,
    contentHash: string,
    jwt: string,
    eveSessionId: string,
    startIndex: number,
    signal: AbortSignal,
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

  return {
    async ensureAgent(workerAddress, contentHash, request) {
      assertSecureTransport(workerAddress);
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      // Per-worker dispatch token (Phase-3 identity) when configured. The
      // bootstrap secret is NOT sent alongside it — otherwise every ensure
      // call would hand the fleet-master secret to the (possibly compromised)
      // worker, undercutting the whole point of per-worker identity. Workers
      // verify dispatch tokens with their own copy of the bootstrap secret +
      // their id, so this works against shared-secret-mode workers too.
      if (options.mintDispatchToken && request.workerId) {
        headers[DISPATCH_TOKEN_HEADER] = options.mintDispatchToken(request.workerId);
        headers[WORKER_ID_HEADER] = request.workerId;
      } else {
        headers["x-worker-secret"] = options.workerSharedSecret;
      }
      const { workerId: _workerId, ...ensureBody } = request;
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
    },

    async createEveSession(workerAddress, contentHash, jwt, message) {
      const res = await doFetch(`${agentProxyBase(workerAddress, contentHash)}/eve/v1/session`, {
        method: "POST",
        headers: {
          authorization: `Bearer ${jwt}`,
          "content-type": "application/json",
        },
        body: JSON.stringify({ message }),
        signal: AbortSignal.timeout(timeoutMs),
      });
      // eve acks session creation asynchronously with a 202 (Phase-0 fact).
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`eve session create failed: ${await readError(res)}`);
      }
      const json = (await res.json()) as Partial<EveSessionCreated>;
      if (!json.sessionId || !json.continuationToken) {
        throw new Error("eve session create returned no sessionId/continuationToken");
      }
      return { sessionId: json.sessionId, continuationToken: json.continuationToken };
    },

    async postTriggerEvent(workerAddress, contentHash, jwt, triggerType, triggerEvent) {
      const res = await doFetch(
        `${agentProxyBase(workerAddress, contentHash)}/eve/v1/platform/${triggerType}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${jwt}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(triggerEvent),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`trigger channel dispatch failed: ${await readError(res)}`);
      }
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        sessionId?: string;
        continuationToken?: string;
        error?: string;
      };
      if (json.ok === false) {
        throw new Error(
          `trigger channel rejected the event: ${json.error ?? "unknown error"}`,
        );
      }
      if (!json.sessionId || !json.continuationToken) {
        throw new Error(
          "trigger channel returned no sessionId/continuationToken",
        );
      }
      return { sessionId: json.sessionId, continuationToken: json.continuationToken };
    },

    async continueEveSession(workerAddress, contentHash, jwt, eveSessionId, request) {
      const res = await doFetch(
        `${agentProxyBase(workerAddress, contentHash)}/eve/v1/session/${eveSessionId}`,
        {
          method: "POST",
          headers: {
            authorization: `Bearer ${jwt}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(timeoutMs),
        },
      );
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`eve session continue failed: ${await readError(res)}`);
      }
      const json = (await res.json().catch(() => ({}))) as {
        continuationToken?: string;
      };
      return { continuationToken: json.continuationToken ?? null };
    },

    async openEventStream(workerAddress, contentHash, jwt, eveSessionId, startIndex, signal) {
      const suffix = startIndex > 0 ? `?startIndex=${startIndex}` : "";
      return doFetch(
        `${agentProxyBase(workerAddress, contentHash)}/eve/v1/session/${eveSessionId}/stream${suffix}`,
        { headers: { authorization: `Bearer ${jwt}` }, signal },
      );
    },
  };
}
