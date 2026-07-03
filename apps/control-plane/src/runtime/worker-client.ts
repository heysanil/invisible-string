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
import type { EveInputResponse } from "@invisible-string/shared";

export interface EnsureAgentRequest {
  /** Presigned artifact GET URL (tar.gz of the built agent). */
  artifactUrl: string;
  /**
   * Full process env for the agent (secrets included — spawn-time injection
   * only; the supervisor must never write these to disk or logs).
   */
  env: Record<string, string>;
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
  /** Per-request timeout for non-streaming calls (default 60s — ensure-agent
   *  may pull + boot the agent synchronously in v1). */
  requestTimeoutMs?: number;
  fetchImpl?: typeof fetch;
}

export function createWorkerClient(options: CreateWorkerClientOptions): WorkerClient {
  const doFetch = options.fetchImpl ?? fetch;
  const timeoutMs = options.requestTimeoutMs ?? 60_000;

  async function readError(res: Response): Promise<string> {
    const text = await res.text().catch(() => "");
    return `${res.status} ${text.slice(0, 500)}`;
  }

  return {
    async ensureAgent(workerAddress, contentHash, request) {
      const res = await doFetch(
        `${workerAddress.replace(/\/+$/, "")}/internal/agents/ensure`,
        {
          method: "POST",
          headers: {
            "x-worker-secret": options.workerSharedSecret,
            "content-type": "application/json",
          },
          body: JSON.stringify({ versionHash: contentHash, ...request }),
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
