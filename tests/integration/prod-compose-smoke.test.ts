/**
 * Prod-compose smoke (container drift guard): builds the REAL production
 * images from the working tree, boots the full prod topology
 * (docker-compose.prod.yml + docker-compose.prod.build.yml), and drives the
 * agents-first product path end-to-end over plain HTTP through the web
 * gateway on 127.0.0.1:8080 — the same traffic a browser sends:
 *
 *   sign-up → workspace (seeds AGENTS, and the onboarding kick background-
 *   publishes "General Purpose") → explicit agent publish → the REAL
 *   in-container `eve build` succeeds → workflow publish validation rejects
 *   an agent-less draft (422 workflow_validation_failed + diagnostics) →
 *   a valid webhook workflow publishes INSTANTLY ({workflow}, no build) →
 *   mint an ingress token → POST /t/:token dispatches a run (202): the agent
 *   artifact is pulled from Garage and BOOTED inside the worker container.
 *
 * WHY THIS LANE EXISTS: every other lane runs the control plane on the HOST
 * (Bun + mise-installed node), so code that accidentally depends on host-only
 * tooling passes CI and dies only inside the shipped image (2026-07: build
 * steps spawned the `mise` binary — absent from the image, which bakes bare
 * node — so EVERY production publish failed with `Executable not found in
 * $PATH: "mise"`). A publish + dispatch executed inside the real containers
 * is the regression gate for that whole class of code↔image drift, and it
 * also exercises the nginx route-prefix enumeration (AGENTS.md) since all
 * calls (including /t/:token) ride the gateway.
 *
 * The dispatched run itself is NOT awaited: OPENROUTER_API_KEY is a throwaway
 * value (dispatch only requires a key to be configured; no mock model ships
 * in the prod images), so the model turn would fail — the smoke asserts the
 * dispatch/boot path, which completes before the 202.
 *
 * Deliberately standalone: no app/workspace imports — the stack under test is
 * the images, not host code. Gated on PROD_SMOKE=1 (+ docker). Slow (3 image
 * builds + an in-container npm install for `eve build`):
 *
 *   PROD_SMOKE=1 bun test tests/integration/prod-compose-smoke.test.ts
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const PROJECT = "psmoke";
const BASE = "http://localhost:8080";
const COMPOSE_FILES = ["docker-compose.prod.yml", "docker-compose.prod.build.yml"];

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
    // Throwaway, NEVER a real key: dispatch requires a provider key to be
    // CONFIGURED (agent env assembly), but the smoke never awaits a model
    // turn — the run fails harmlessly after the asserted 202 dispatch.
    `OPENROUTER_API_KEY=sk-or-smoke-${randomBytes(8).toString("hex")}`,
  ];
  writeFileSync(envFile, `${lines.join("\n")}\n`, { mode: 0o600 });
  return envFile;
}

let composeBase: string[] = [];

/**
 * Environment for the spawned `docker compose`, with every variable the prod
 * compose files interpolate REMOVED. Compose gives OS-environment values —
 * even empty strings — precedence over `--env-file` during ${VAR}
 * interpolation, and `bun test` auto-loads the repo .env into process.env, so
 * an inherited env silently overrides smoke.env (observed: an empty
 * `OPENROUTER_API_KEY=` .env line blanked the throwaway key → dispatch 500
 * provider_key_missing). Scrubbing also guarantees a REAL host key can never
 * leak into the smoke containers. The name list is parsed from the compose
 * files themselves so new interpolations can't drift out of the scrub.
 */
function composeEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = { ...process.env };
  for (const file of COMPOSE_FILES) {
    const text = readFileSync(join(REPO_ROOT, file), "utf8");
    for (const match of text.matchAll(/\$\{([A-Za-z_][A-Za-z0-9_]*)/g)) {
      delete env[match[1]!];
    }
  }
  return env;
}

/** Compose against the smoke project; build/up output streams to the runner log. */
async function compose(args: string[], timeoutMs: number): Promise<void> {
  const proc = Bun.spawn([...composeBase, ...args], {
    cwd: REPO_ROOT,
    env: composeEnv(),
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

describe.skipIf(!GATE)("prod-compose smoke (agent publish + dispatch inside the shipped images)", () => {
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
    "sign-up → seeded agents → agent publish builds in-container → workflow validate/publish → /t/:token dispatch",
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

      // afterCreateOrganization seeds the workspace's default AGENTS (the
      // first-class entity — presets are gone) and fire-and-forget-publishes
      // "General Purpose" in the background.
      const agents = await expectJson<{
        agents: { id: string; name: string; publishedVersionId: string | null }[];
      }>(await api("GET", `/workspaces/${orgId}/agents`), "list agents", 200);
      if (agents.agents.length < 3) {
        throw new Error(`workspace seed produced ${agents.agents.length} agents; expected the 3 defaults`);
      }
      const seedAgent = agents.agents.find((a) => a.name === "General Purpose");
      if (!seedAgent) throw new Error('workspace seed produced no "General Purpose" agent');
      const agentId = seedAgent.id;

      // Explicit publish — idempotent by content hash, so it coalesces with
      // the onboarding kick's background publish (single-flight per hash).
      const published = await expectJson<{
        agentId: string;
        versionId: string;
        contentHash: string;
        buildStatus: string;
        cached: boolean;
        buildError: string | null;
      }>(
        await api("POST", `/workspaces/${orgId}/agents/${agentId}/publish`),
        "agent publish",
        200,
      );
      expect(published.versionId).toBeTruthy();
      expect(published.contentHash).toHaveLength(64);

      // The real regression gate: compile + npm install + `eve build` run
      // INSIDE the control-plane image. The 2026-07 mise drift surfaced here
      // as status "failed" with `Executable not found in $PATH: "mise"`.
      const final = await until(
        async () => {
          const status = await expectJson<{ status: string; error: string | null }>(
            await api(
              "GET",
              `/workspaces/${orgId}/agents/${agentId}/versions/${published.versionId}/build`,
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

      // ── workflow leg: validate → instant publish (no build) ──────────────
      const createdWorkflow = await expectJson<{ workflow: { id: string } }>(
        await api("POST", `/workspaces/${orgId}/workflows`, {
          name: "Prod Smoke Workflow",
          draft: {
            trigger: { type: "webhook" },
            agentId: null,
            instructions: { markdown: "" },
          },
        }),
        "create workflow",
        201,
      );
      const workflowId = createdWorkflow.workflow.id;

      // The validator BLOCKS an agent-less, instruction-less draft with typed
      // diagnostics (agents-first publish gate — no compiler involved).
      const rejected = await api(
        "POST",
        `/workspaces/${orgId}/workflows/${workflowId}/publish`,
      );
      const rejection = await expectJson<{
        error: { code: string; details?: { diagnostics?: unknown[] } };
      }>(rejected, "publish validation rejection", 422);
      expect(rejection.error.code).toBe("workflow_validation_failed");
      expect(Array.isArray(rejection.error.details?.diagnostics)).toBeTrue();
      expect(rejection.error.details!.diagnostics!.length).toBeGreaterThan(0);

      // Fix the draft → publish is INSTANT: the response is the row (no
      // contentHash/build fields — workflows compile nothing).
      await expectJson(
        await api("PATCH", `/workspaces/${orgId}/workflows/${workflowId}`, {
          draft: {
            trigger: { type: "webhook" },
            agentId,
            instructions: {
              markdown: "Summarize the incoming event described by @trigger.kind in one line.",
            },
          },
        }),
        "update workflow draft",
        200,
      );
      const publishedWorkflow = await expectJson<{
        workflow: { id: string; published: Record<string, unknown> | null; publishedAt: string | null };
        contentHash?: unknown;
      }>(
        await api("POST", `/workspaces/${orgId}/workflows/${workflowId}/publish`),
        "workflow publish",
        200,
      );
      expect(publishedWorkflow.workflow.published).not.toBeNull();
      expect(publishedWorkflow.workflow.publishedAt).not.toBeNull();
      expect(publishedWorkflow.contentHash).toBeUndefined();

      // ── one ingress dispatch through the gateway ──────────────────────────
      const minted = await expectJson<{ token: string; ingressUrl: string }>(
        await api(
          "POST",
          `/workspaces/${orgId}/workflows/${workflowId}/triggers/webhook-token`,
        ),
        "mint webhook token",
        201,
      );

      // 202 means the whole dispatch path ran inside the containers: snapshot
      // + agent resolution, task-message render, artifact pulled from Garage,
      // agent BOOTED in the worker image, eve session created. (The model
      // turn after this fails on the throwaway key — deliberately unasserted.)
      const ingress = await fetch(`${BASE}/t/${minted.token}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Prod smoke ingress event.", kind: "smoke" }),
      });
      const accepted = await expectJson<{ accepted: boolean; runId: string; sessionId: string }>(
        ingress,
        "trigger ingress",
        202,
      );
      expect(accepted.accepted).toBeTrue();
      expect(accepted.runId).toBeTruthy();
      expect(accepted.sessionId).toBeTruthy();
    },
    30 * 60_000,
  );
});
