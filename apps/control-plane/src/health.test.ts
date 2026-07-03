import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";

import { healthPlugin, runDeepHealth } from "./health";

const ok = async () => {};
const fail = (message: string) => async () => {
  throw new Error(message);
};

describe("runDeepHealth", () => {
  test("all checks pass ⇒ ok", async () => {
    const report = await runDeepHealth({
      pingDb: ok,
      pingObjectStore: ok,
      countLiveWorkers: async () => 2,
    });
    expect(report.ok).toBe(true);
    expect(report.status).toBe("ok");
    expect(report.checks.database?.status).toBe("ok");
    expect(report.checks.objectStore?.status).toBe("ok");
    expect(report.checks.workers).toMatchObject({ status: "ok", detail: "2 live" });
  });

  test("a failing DB degrades the report", async () => {
    const report = await runDeepHealth({
      pingDb: fail("connection refused"),
      pingObjectStore: ok,
      countLiveWorkers: async () => 1,
    });
    expect(report.ok).toBe(false);
    expect(report.status).toBe("degraded");
    expect(report.checks.database).toMatchObject({
      status: "degraded",
      detail: "connection refused",
    });
  });

  test("an unreachable object store degrades the report", async () => {
    const report = await runDeepHealth({
      pingDb: ok,
      pingObjectStore: fail("s3 timeout"),
      countLiveWorkers: async () => 1,
    });
    expect(report.ok).toBe(false);
    expect(report.checks.objectStore).toMatchObject({
      status: "degraded",
      detail: "s3 timeout",
    });
  });

  test("zero live workers degrades the report", async () => {
    const report = await runDeepHealth({
      pingDb: ok,
      pingObjectStore: ok,
      countLiveWorkers: async () => 0,
    });
    expect(report.ok).toBe(false);
    expect(report.checks.workers).toMatchObject({
      status: "degraded",
      detail: "no live workers",
    });
  });

  test("a throwing worker count degrades the report", async () => {
    const report = await runDeepHealth({
      pingDb: ok,
      pingObjectStore: ok,
      countLiveWorkers: async () => {
        throw new Error("workers query failed");
      },
    });
    expect(report.ok).toBe(false);
    expect(report.checks.workers).toMatchObject({
      status: "degraded",
      detail: "workers query failed",
    });
  });

  test("absent probes are skipped, not failed (Phase-0 boot)", async () => {
    const report = await runDeepHealth({ pingDb: ok });
    expect(report.ok).toBe(true);
    expect(report.checks.objectStore?.status).toBe("skipped");
    expect(report.checks.workers?.status).toBe("skipped");
  });
});

describe("healthPlugin route wiring", () => {
  test("shallow GET /api/health is { ok: true }, 200", async () => {
    const app = new Elysia().use(
      healthPlugin({ pingDb: fail("should not run on a shallow probe") }),
    );
    const res = await app.handle(new Request("http://localhost/api/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("?deep=1 with all checks passing is 200 + report", async () => {
    const app = new Elysia().use(
      healthPlugin({ pingDb: ok, pingObjectStore: ok, countLiveWorkers: async () => 1 }),
    );
    const res = await app.handle(
      new Request("http://localhost/api/health?deep=1"),
    );
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, status: "ok" });
  });

  test("?deep=1 with a degraded dependency answers 503", async () => {
    const app = new Elysia().use(
      healthPlugin({ pingDb: fail("db down"), countLiveWorkers: async () => 0 }),
    );
    const res = await app.handle(
      new Request("http://localhost/api/health?deep=1"),
    );
    expect(res.status).toBe(503);
    const body = (await res.json()) as {
      status: string;
      checks: { database: { status: string } };
    };
    expect(body.status).toBe("degraded");
    expect(body.checks.database.status).toBe("degraded");
  });
});
