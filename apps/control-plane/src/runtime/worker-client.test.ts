/**
 * Worker-client ensure-agent retry semantics (regression for the keyed
 * acceptance finding: a COLD first agent boot can outlast the request
 * timeout, and without a retry the very first session on a fresh version
 * 502s and its run is marked failed).
 */
import { describe, expect, test } from "bun:test";

import { DISPATCH_TOKEN_HEADER } from "@invisible-string/shared";

import { createWorkerClient, ENSURE_AGENT_MAX_ATTEMPTS } from "./worker-client";

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
