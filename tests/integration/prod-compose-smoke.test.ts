/**
 * Prod-compose smoke (container drift guard): builds the REAL production
 * images from the working tree, boots the full prod topology
 * (docker-compose.prod.yml + docker-compose.prod.build.yml), and drives one
 * workflow publish end-to-end over plain HTTP through the web gateway on
 * 127.0.0.1:8080 — the same traffic a browser sends.
 *
 * WHY THIS LANE EXISTS: every other lane runs the control plane on the HOST
 * (Bun + mise-installed node), so code that accidentally depends on host-only
 * tooling passes CI and dies only inside the shipped image (2026-07: build
 * steps spawned the `mise` binary — absent from the image, which bakes bare
 * node — so EVERY production publish failed with `Executable not found in
 * $PATH: "mise"`). A publish executed inside the real containers is the
 * regression gate for that whole class of code↔image drift, and it also
 * exercises the nginx route-prefix enumeration (AGENTS.md) since all calls
 * ride the gateway.
 *
 * Deliberately standalone: no app/workspace imports — the stack under test is
 * the images, not host code. Gated on PROD_SMOKE=1 (+ docker). Slow (3 image
 * builds + an in-container npm install for `eve build`):
 *
 *   PROD_SMOKE=1 bun test tests/integration/prod-compose-smoke.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const PROJECT = "psmoke";
const BASE = "http://localhost:8080";

const GATE_PROBLEMS: string[] = [];
if (process.env.PROD_SMOKE !== "1") GATE_PROBLEMS.push("PROD_SMOKE not set to 1");
if (Bun.which("docker") === null) GATE_PROBLEMS.push("docker not on PATH");
const GATE = GATE_PROBLEMS.length === 0;
if (!GATE) {
  console.warn(`[prod-compose-smoke] skipped: ${GATE_PROBLEMS.join("; ")}`);
}

// Mirrors docs/DEPLOY.md §6 "Local smoke": IMAGE_TAG=smoke, throwaway secrets.
function writeSmokeEnvFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "prod-smoke-"));
  const envFile = join(dir, "smoke.env");
  const lines = [
    "APP_DOMAIN=localhost:8080",
    "IMAGE_TAG=smoke",
    `POSTGRES_PASSWORD=${randomBytes(16).toString("hex")}`,
    `GARAGE_RPC_SECRET=${randomBytes(32).toString("hex")}`,
    `S3_ACCESS_KEY_ID=GK${randomBytes(16).toString("hex")}`,
    `S3_SECRET_ACCESS_KEY=${randomBytes(32).toString("hex")}`,
    `ENCRYPTION_MASTER_KEY=${randomBytes(32).toString("base64")}`,
    `PLATFORM_JWT_SECRET=${randomBytes(32).toString("base64")}`,
    `BETTER_AUTH_SECRET=${randomBytes(32).toString("base64")}`,
    `WORKER_SHARED_SECRET=${randomBytes(32).toString("base64")}`,
    `WORKER_ID=${randomUUID()}`,
  ];
  writeFileSync(envFile, `${lines.join("\n")}\n`, { mode: 0o600 });
  return envFile;
}

let composeBase: string[] = [];

/** Compose against the smoke project; build/up output streams to the runner log. */
async function compose(args: string[], timeoutMs: number): Promise<void> {
  const proc = Bun.spawn([...composeBase, ...args], {
    cwd: REPO_ROOT,
    stdout: "inherit",
    stderr: "inherit",
  });
  const timer = setTimeout(() => proc.kill(9), timeoutMs);
  const exitCode = await proc.exited;
  clearTimeout(timer);
  if (exitCode !== 0) {
    throw new Error(`docker compose ${args.join(" ")} exited ${exitCode}`);
  }
}

async function until<T>(
  probe: () => Promise<T | undefined>,
  what: string,
  timeoutMs: number,
  intervalMs = 2_000,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe().catch(() => undefined);
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(intervalMs);
  }
}

// Session cookies accumulate across auth calls (sign-up sets the session).
let cookie = "";

/** Browser-shaped request: session cookie + an Origin Better Auth trusts. */
async function api(
  method: string,
  path: string,
  body?: unknown,
): Promise<Response> {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      origin: BASE,
      cookie,
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const setCookies = res.headers.getSetCookie();
  if (setCookies.length > 0) {
    const jar = new Map(
      cookie
        .split("; ")
        .filter(Boolean)
        .map((c) => [c.split("=")[0]!, c] as const),
    );
    for (const c of setCookies) {
      const pair = c.split(";")[0]!;
      jar.set(pair.split("=")[0]!, pair);
    }
    cookie = [...jar.values()].join("; ");
  }
  return res;
}

async function expectJson<T>(res: Response, step: string, status: number): Promise<T> {
  const text = await res.text();
  if (res.status !== status) {
    throw new Error(`${step}: expected ${status}, got ${res.status}\n${text.slice(0, 2_000)}`);
  }
  return JSON.parse(text) as T;
}

describe.skipIf(!GATE)("prod-compose smoke (publish inside the shipped images)", () => {
  beforeAll(async () => {
    const envFile = writeSmokeEnvFile();
    composeBase = [
      "docker",
      "compose",
      "-p",
      PROJECT,
      "--env-file",
      envFile,
      "-f",
      "docker-compose.prod.yml",
      "-f",
      "docker-compose.prod.build.yml",
    ];

    // Clear any leftover smoke stack (a prior aborted run holds :8080).
    await compose(["down", "-v", "--remove-orphans"], 120_000).catch(() => {});
    await compose(["up", "-d", "--build"], 25 * 60_000);

    // No `--wait` (it races the migrate one-shot — DEPLOY.md §6); poll instead.
    await until(
      async () => ((await fetch(`${BASE}/api/health`)).ok ? true : undefined),
      "gateway + control plane health",
      180_000,
    );
    // Deep health = DB + object store + a live registered worker.
    await until(
      async () => ((await fetch(`${BASE}/api/health?deep=1`)).ok ? true : undefined),
      "deep health (live worker registered)",
      120_000,
    );
  }, 30 * 60_000);

  afterAll(async () => {
    if (composeBase.length === 0) return;
    if (process.env.PROD_SMOKE_KEEP === "1") {
      console.warn("[prod-compose-smoke] PROD_SMOKE_KEEP=1 — stack left running");
      return;
    }
    await compose(["down", "-v"], 180_000).catch((error) => console.error(error));
  }, 240_000);

  test(
    "sign-up → workspace → workflow → publish → build succeeds in-container",
    async () => {
      const signUp = await api("POST", "/api/auth/sign-up/email", {
        email: `smoke-${randomUUID()}@example.com`,
        password: "correct-horse-battery",
        name: "Prod Smoke",
      });
      await expectJson(signUp, "sign-up", 200);

      const created = await api("POST", "/api/auth/organization/create", {
        name: "Smoke Workspace",
        slug: `smoke-${randomUUID().slice(0, 8)}`,
      });
      const createdBody = await expectJson<{ id?: string; data?: { id?: string } }>(
        created,
        "organization create",
        200,
      );
      const orgId = createdBody.id ?? createdBody.data?.id;
      if (!orgId) throw new Error("organization create returned no id");
      const setActive = await api("POST", "/api/auth/organization/set-active", {
        organizationId: orgId,
      });
      await expectJson(setActive, "organization set-active", 200);

      // afterCreateOrganization seeds the workspace defaults (agent presets).
      const agents = await expectJson<{ agents: { id: string }[] }>(
        await api("GET", `/workspaces/${orgId}/agents`),
        "list agent presets",
        200,
      );
      const agentPresetId = agents.agents[0]?.id;
      if (!agentPresetId) throw new Error("workspace seed produced no agent presets");

      const createdWorkflow = await expectJson<{ workflow: { id: string } }>(
        await api("POST", `/workspaces/${orgId}/workflows`, {
          name: "Prod Smoke Workflow",
          draft: {
            trigger: { type: "manual" },
            context: {},
            agent: { agentPresetId },
            instructions: { markdown: "Answer questions directly and briefly." },
          },
        }),
        "create workflow",
        201,
      );
      const workflowId = createdWorkflow.workflow.id;

      const published = await expectJson<{
        versionId: string;
        contentHash: string;
        buildStatus: string;
        buildError: string | null;
      }>(
        await api("POST", `/workspaces/${orgId}/workflows/${workflowId}/publish`),
        "publish",
        200,
      );
      expect(published.versionId).toBeTruthy();

      // The real regression gate: compile + npm install + `eve build` run
      // INSIDE the control-plane image. The 2026-07 mise drift surfaced here
      // as status "failed" with `Executable not found in $PATH: "mise"`.
      const final = await until(
        async () => {
          const status = await expectJson<{ status: string; error: string | null }>(
            await api(
              "GET",
              `/workspaces/${orgId}/workflows/${workflowId}/versions/${published.versionId}/build`,
            ),
            "build status",
            200,
          );
          return status.status === "building" || status.status === "pending"
            ? undefined
            : status;
        },
        "build to finish",
        15 * 60_000,
        3_000,
      );
      if (final.status !== "succeeded") {
        throw new Error(`in-container build ${final.status}:\n${final.error ?? "(no log)"}`);
      }
    },
    20 * 60_000,
  );
});
