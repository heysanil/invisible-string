import { describe, expect, test } from "bun:test";

import * as controlPlane from "./index";
import { createAppStack } from "./index";

// No DB connection is made here: postgres-js connects lazily, and none of
// the endpoints exercised below touch the database.
const stack = createAppStack({
  DATABASE_URL: "postgres://dev:dev@localhost:5432/unit-test-not-connected",
  BETTER_AUTH_SECRET: "unit-test-secret-0123456789-0123456789",
  CORS_ORIGIN: "http://localhost:5173",
});
const { app } = stack;

describe("control-plane app", () => {
  test("GET /api/health returns { ok: true }", async () => {
    const res = await app.handle(new Request("http://localhost/api/health"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("Better Auth is mounted at /api/auth (GET /api/auth/ok)", async () => {
    const res = await app.handle(new Request("http://localhost/api/auth/ok"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  test("CORS: allowed origin gets credentialed headers", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/health", {
        headers: { origin: "http://localhost:5173" },
      }),
    );
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:5173",
    );
    expect(res.headers.get("access-control-allow-credentials")).toBe("true");
  });

  test("CORS: preflight from an allowed origin succeeds", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/health", {
        method: "OPTIONS",
        headers: {
          origin: "http://localhost:5173",
          "access-control-request-method": "GET",
        },
      }),
    );
    expect(res.status).toBeLessThan(300);
    expect(res.headers.get("access-control-allow-origin")).toBe(
      "http://localhost:5173",
    );
  });

  test("CORS: disallowed origin is not reflected", async () => {
    const res = await app.handle(
      new Request("http://localhost/api/health", {
        headers: { origin: "https://evil.example.com" },
      }),
    );
    expect(res.headers.get("access-control-allow-origin")).not.toBe(
      "https://evil.example.com",
    );
  });
});

describe("Bun.serve transport options", () => {
  test("idle timeout is disabled — run-stream SSE tails and >10s dispatch awaits must outlive Bun's ~10s default idle kill", () => {
    expect(controlPlane.BUN_SERVE_OPTIONS?.idleTimeout).toBe(0);
  });

  test("request body cap stays at 8 MiB (mirrors nginx client_max_body_size in infra/nginx/web.conf)", () => {
    expect(controlPlane.BUN_SERVE_OPTIONS?.maxRequestBodySize).toBe(
      8 * 1024 * 1024,
    );
  });
});
