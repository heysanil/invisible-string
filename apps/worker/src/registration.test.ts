/**
 * Registration loop failure-mode tests (review findings):
 *
 * - a heartbeat 401 (expired per-worker session token after a control-plane
 *   outage) must DEMOTE to a fresh bootstrap-authenticated register — never
 *   retry the dead token forever;
 * - a heartbeat 404 (row unknown OR fenced `dead`) must invoke the `onFenced`
 *   hook (the supervisor stops all local agents there) BEFORE re-registering;
 * - `beginDrain()` flags heartbeats with `draining: true` and pushes one
 *   immediately so the scheduler stops routing at drain start.
 */
import { afterEach, describe, expect, test } from "bun:test";

import {
  WORKER_BOOTSTRAP_SECRET_HEADER,
  WORKER_TOKEN_HEADER,
} from "@invisible-string/shared";

import { createRegistration, type Registration } from "./registration";

const SECRET = "registration-test-secret-0123456789";

interface RecordedCall {
  path: string;
  body: Record<string, unknown>;
  bootstrap: string | null;
  sessionToken: string | null;
}

/** Scriptable control-plane stub: per-path response override. */
function startStub(): {
  url: string;
  calls: RecordedCall[];
  respond: (path: string, fn: (call: RecordedCall) => Response) => void;
  stop(): void;
} {
  const calls: RecordedCall[] = [];
  const overrides = new Map<string, (call: RecordedCall) => Response>();
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const call: RecordedCall = {
        path: new URL(request.url).pathname,
        body: ((await request.json().catch(() => ({}))) ?? {}) as Record<string, unknown>,
        bootstrap: request.headers.get(WORKER_BOOTSTRAP_SECRET_HEADER),
        sessionToken: request.headers.get(WORKER_TOKEN_HEADER),
      };
      calls.push(call);
      const override = overrides.get(call.path);
      if (override) return override(call);
      return Response.json({ ok: true });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port}`,
    calls,
    respond: (path, fn) => overrides.set(path, fn),
    stop: () => server.stop(true),
  };
}

const live: Registration[] = [];
const stubs: { stop(): void }[] = [];

function makeRegistration(
  controlPlaneUrl: string,
  options: {
    authMode?: "shared-secret" | "worker-token";
    onFenced?: () => void | Promise<void>;
  } = {},
): Registration {
  const registration = createRegistration({
    config: {
      controlPlaneUrl,
      workerSharedSecret: SECRET,
      workerId: "11111111-2222-4333-8444-555555555555",
      publicUrl: "http://worker.test",
      heartbeatIntervalMs: 25,
      maxAgents: 20,
      authMode: options.authMode ?? "shared-secret",
    },
    snapshot: () => ({ runningAgents: 0, activeRequests: 0, runningHashes: [] }),
    onFenced: options.onFenced,
  });
  live.push(registration);
  return registration;
}

async function waitFor(predicate: () => boolean, timeoutMs = 3_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (predicate()) return;
    if (Date.now() > deadline) throw new Error(`waitFor timed out after ${timeoutMs}ms`);
    await Bun.sleep(10);
  }
}

afterEach(() => {
  while (live.length > 0) live.pop()?.stop();
  while (stubs.length > 0) stubs.pop()?.stop();
});

describe("registration failure modes", () => {
  test("heartbeat 401 (expired token) demotes to a bootstrap re-register — no permanent 401 loop", async () => {
    const stub = startStub();
    stubs.push(stub);
    let registerCount = 0;
    stub.respond("/internal/workers/register", () => {
      registerCount += 1;
      return Response.json({
        ok: true,
        authMode: "worker-token",
        workerToken: `token-${registerCount}`,
        heartbeatIntervalMs: 25,
      });
    });
    // Every heartbeat 401s (the control plane restarted; the token is dead).
    stub.respond("/internal/workers/heartbeat", () =>
      Response.json({ error: { code: "unauthorized", message: "bad token" } }, { status: 401 }),
    );

    const registration = makeRegistration(stub.url, { authMode: "worker-token" });
    registration.start();

    // register #1 → heartbeat 401 → register #2 (with the bootstrap secret).
    await waitFor(() => registerCount >= 2);
    const registers = stub.calls.filter((c) => c.path === "/internal/workers/register");
    expect(registers.length).toBeGreaterThanOrEqual(2);
    for (const call of registers) {
      expect(call.bootstrap).toBe(SECRET); // register always uses the bootstrap secret
    }
    // The failing heartbeat presented the (stale) session token, not the secret.
    const heartbeat = stub.calls.find((c) => c.path === "/internal/workers/heartbeat");
    expect(heartbeat?.sessionToken).toBe("token-1");
    expect(heartbeat?.bootstrap).toBeNull();
  });

  test("heartbeat 404 (fenced) runs onFenced BEFORE re-registering", async () => {
    const stub = startStub();
    stubs.push(stub);
    const order: string[] = [];
    let fenceOnce = true;
    stub.respond("/internal/workers/register", () => {
      order.push("register");
      return Response.json({ ok: true, authMode: "shared-secret", heartbeatIntervalMs: 25 });
    });
    stub.respond("/internal/workers/heartbeat", () => {
      if (fenceOnce) {
        fenceOnce = false;
        order.push("heartbeat-404");
        return Response.json(
          { error: { code: "worker_fenced", message: "re-register" } },
          { status: 404 },
        );
      }
      order.push("heartbeat-ok");
      return Response.json({ ok: true });
    });

    const registration = makeRegistration(stub.url, {
      onFenced: () => {
        order.push("fenced-hook");
      },
    });
    registration.start();

    await waitFor(() => order.includes("heartbeat-ok"));
    const fencedAt = order.indexOf("fenced-hook");
    const reregisterAt = order.indexOf("register", order.indexOf("heartbeat-404"));
    expect(fencedAt).toBeGreaterThan(order.indexOf("heartbeat-404"));
    expect(reregisterAt).toBeGreaterThan(fencedAt); // agents stopped BEFORE re-register
    expect(registration.state().registered).toBe(true);
  });

  test("beginDrain sends an immediate draining heartbeat and flags all later ones", async () => {
    const stub = startStub();
    stubs.push(stub);
    const registration = makeRegistration(stub.url);
    registration.start();
    await waitFor(() =>
      stub.calls.some((c) => c.path === "/internal/workers/register"),
    );

    await registration.beginDrain();
    const draining = stub.calls.filter(
      (c) => c.path === "/internal/workers/heartbeat" && c.body.draining === true,
    );
    expect(draining.length).toBeGreaterThanOrEqual(1);
  });
});
