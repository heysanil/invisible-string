/**
 * Phase-0 spike — KEYLESS acceptance (no provider API key required).
 *
 * Proves, end to end through the reverse proxy:
 *   1. `eve build` succeeds and registers the 1-minute schedule.
 *   2. `eve start` serves /eve/v1/health through the proxy.
 *   3. Route auth fails closed: unauthenticated POST /eve/v1/session -> 401,
 *      platform-JWT-signed -> not-401 (session created).
 *   4. world-postgres bootstrap created the workflow_* tables.
 *   5. The Nitro schedule runner fires the 1-minute schedule under `eve start`.
 *
 * Gated on TEST_DATABASE_URL (docker compose provides Postgres on :5443).
 */
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import {
  AGENT_PROJECT_DIR,
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
  queryWorldDb,
  readNdjson,
  resetMarkerDir,
  sleep,
  startEve,
  stopProxy,
  type EveProcess,
} from "./harness.ts";

if (!DB_GATE_AVAILABLE) {
  console.warn(`[spike] skipping keyless suite: ${DB_GATE_SKIP_REASON}`);
}

describe.skipIf(!DB_GATE_AVAILABLE)("spike keyless acceptance", () => {
  let eve: EveProcess | null = null;

  beforeAll(async () => {
    await ensurePostgres();
    await bootstrapWorld();
    await eveBuild();
    resetMarkerDir();
    eve = await startEve();
    ensureProxy();
  }, 600_000);

  afterAll(async () => {
    await eve?.stop();
    stopProxy();
  }, 30_000);

  test("eve build produced the Nitro server output", () => {
    expect(existsSync(join(AGENT_PROJECT_DIR, ".output", "server", "index.mjs"))).toBe(true);
  });

  test("schedule is registered in the compiled manifest (cron * * * * *)", () => {
    const manifest = JSON.parse(
      readFileSync(
        join(AGENT_PROJECT_DIR, ".eve", "compile", "compiled-agent-manifest.json"),
        "utf8",
      ),
    ) as { schedules?: { name: string; cron: string; hasRun: boolean }[] };
    const heartbeat = manifest.schedules?.find((s) => s.name === "heartbeat");
    expect(heartbeat).toBeDefined();
    expect(heartbeat?.cron).toBe("* * * * *");
    expect(heartbeat?.hasRun).toBe(true);
  });

  test("GET /eve/v1/health responds through the proxy", async () => {
    const res = await fetch(`${PROXY_URL}/eve/v1/health`);
    expect(res.status).toBe(200);
  });

  test("proxy forwards ONLY /eve/ and /.well-known/workflow/ prefixes", async () => {
    const blocked = await fetch(`${PROXY_URL}/dispatch`, { method: "POST" });
    expect(blocked.status).toBe(404);
    expect(await blocked.text()).toContain("not forwarded");
  });

  test("unauthenticated POST /eve/v1/session -> 401 (fails closed)", async () => {
    const res = await fetch(`${PROXY_URL}/eve/v1/session`, {
      body: JSON.stringify({ message: "hello" }),
      headers: { "content-type": "application/json" },
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  test("JWT signed with the wrong secret -> 401", async () => {
    const token = await mintPlatformJwt({}, "not-the-platform-secret-000000000");
    const res = await fetch(`${PROXY_URL}/eve/v1/session`, {
      body: JSON.stringify({ message: "hello" }),
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
      },
      method: "POST",
    });
    expect(res.status).toBe(401);
  });

  test(
    "platform-JWT-signed POST /eve/v1/session -> not 401; NDJSON stream reachable through proxy",
    async () => {
      const token = await mintPlatformJwt();
      const res = await fetch(`${PROXY_URL}/eve/v1/session`, {
        body: JSON.stringify({ message: "Say the word: spike." }),
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
        },
        method: "POST",
      });
      expect(res.status).not.toBe(401);
      expect(res.status).toBeLessThan(300);
      const body = (await res.json()) as { sessionId?: string; continuationToken?: string };
      expect(typeof body.sessionId).toBe("string");
      expect(typeof body.continuationToken).toBe("string");

      // Keyless: the turn itself fails at the model call, but the durable
      // session machinery (workflow callbacks THROUGH the proxy) still runs
      // and emits real events. Capture them as live-observed shapes.
      const events = await readNdjson(
        `${PROXY_URL}/eve/v1/session/${body.sessionId}/stream`,
        {
          headers: { authorization: `Bearer ${token}` },
          timeoutMs: 60_000,
          until: (event) =>
            event.type === "session.failed" ||
            event.type === "session.waiting" ||
            event.type === "session.completed" ||
            event.type === "turn.failed",
        },
      );
      expect(events.length).toBeGreaterThan(0);
      expect(events.map((e) => e.type)).toContain("session.started");

      mkdirSync(join(ARTIFACTS_DIR), { recursive: true });
      writeFileSync(
        join(ARTIFACTS_DIR, "keyless-observed-events.ndjson"),
        events.map((e) => JSON.stringify(e)).join("\n") + "\n",
      );
    },
    120_000,
  );

  test("world bootstrap created the workflow_* tables in Postgres", async () => {
    // world-postgres@5.0.0-beta.20 creates its tables in the `workflow`
    // schema (plus `workflow_drizzle` migrations and `graphile_worker`).
    const rows = await queryWorldDb<{ table_name: string }>(
      "select table_name from information_schema.tables where table_schema in ('workflow', 'public') and table_name like 'workflow_%' order by table_name",
    );
    const names = rows.map((r) => r.table_name);
    for (const required of [
      "workflow_runs",
      "workflow_events",
      "workflow_steps",
      "workflow_hooks",
      "workflow_stream_chunks",
    ]) {
      expect(names).toContain(required);
    }
  });

  test(
    "1-minute schedule fires under `eve start` (Nitro scheduled tasks)",
    async () => {
      const marker = join(markerDir(), "heartbeat.log");
      const deadline = Date.now() + 130_000;
      while (Date.now() < deadline) {
        if (existsSync(marker) && readFileSync(marker, "utf8").trim().length > 0) {
          return;
        }
        await sleep(2_000);
      }
      throw new Error(
        "schedule did not fire within 130s (no heartbeat.log marker written)",
      );
    },
    150_000,
  );
});
