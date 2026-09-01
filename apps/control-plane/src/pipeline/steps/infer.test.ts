/**
 * `infer` step executor. Ungated: the guards that fire before any DB or wire
 * touch (malformed input, prompt clamp, unknown preset slug). DB-gated (skips
 * cleanly without TEST_DATABASE_URL): the model path against a CAPTURING stub
 * gateway (the reasoning-wire idiom — assertions on request BYTES, because
 * the titler taught us a seam above the provider proves nothing), including
 * the schema-enforcement loop: valid object, one repair retry carrying the
 * validator's errors, and the `validation_failed` terminal.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import {
  newStepId,
  type InferStep,
  type PipelineStep,
} from "@invisible-string/shared";

import { createDb, type Db, type DbHandle } from "../../db";
import { createLogger } from "../../log";
import { runMigrations } from "../../migrate";
import type { PipelineExecutorDeps, StepExecuteContext } from "../types";
import {
  executeInferStep,
  INFER_DEFAULT_MAX_OUTPUT_TOKENS,
  INFER_MAX_PROMPT_BYTES,
} from "./infer";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const logger = createLogger({ sink: () => {}, minLevel: "error" });

const MODEL_ID = "~deepseek/deepseek-v4-flash-latest";

// ── stub gateway (reasoning-wire idiom, scriptable bodies) ───────────────────

interface Captured {
  body: Record<string, unknown>;
}

/**
 * OpenAI-compatible gateway recording every request body and answering from a
 * SCRIPT of `{status, content}` entries (last entry repeats). `port: 0` +
 * `idleTimeout: 0` are the house pattern.
 */
function stubGateway(script: { status?: number; content: string }[]) {
  const captured: Captured[] = [];
  const server = Bun.serve({
    port: 0,
    idleTimeout: 0,
    async fetch(req) {
      const body = (await req.json()) as Record<string, unknown>;
      captured.push({ body });
      const entry = script[Math.min(captured.length - 1, script.length - 1)]!;
      if (entry.status && entry.status !== 200) {
        return Response.json({ error: "stub failure" }, { status: entry.status });
      }
      return Response.json({
        id: "wire",
        object: "chat.completion",
        created: 0,
        model: "wire",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: entry.content },
          },
        ],
        usage: { prompt_tokens: 3, completion_tokens: 5, total_tokens: 8 },
      });
    },
  });
  return {
    captured,
    baseUrl: `http://127.0.0.1:${server.port}/api/v1`,
    [Symbol.dispose]: () => void server.stop(true),
  };
}

// ── context builders ─────────────────────────────────────────────────────────

function inferStep(overrides: Partial<InferStep> = {}): InferStep {
  return {
    id: newStepId(),
    slug: "summarize",
    kind: "infer",
    preset: "quick",
    prompt: { markdown: "" },
    ...overrides,
  };
}

function contextFor(
  db: Db,
  orgId: string,
  step: PipelineStep,
  input: unknown,
  providerKeys?: PipelineExecutorDeps["providerKeys"],
): StepExecuteContext {
  return {
    deps: {
      db,
      logger,
      masterKey: undefined,
      fetchImpl: fetch,
      ...(providerKeys ? { providerKeys } : {}),
    },
    orgId,
    run: { id: `run-${randomUUID()}`, workflowId: `wf-${randomUUID()}` },
    step,
    input,
    scope: { trigger: {}, steps: {}, state: {}, now: new Date().toISOString() },
    signal: new AbortController().signal,
    attempt: 1,
    path: step.id,
  };
}

// ── ungated: guards before any DB/wire touch ─────────────────────────────────

describe("executeInferStep guards", () => {
  const poisonedDb = null as unknown as Db;

  test("malformed rendered input fails internal", async () => {
    const outcome = await executeInferStep(
      contextFor(poisonedDb, "org", inferStep(), { markdown: "nope" }),
    );
    expect(outcome).toMatchObject({
      status: "failed",
      errorClass: "internal",
      retryable: false,
    });
  });

  test("an over-cap prompt fails input_too_large before resolving anything", async () => {
    const outcome = await executeInferStep(
      contextFor(poisonedDb, "org", inferStep(), {
        prompt: "x".repeat(INFER_MAX_PROMPT_BYTES + 1),
      }),
    );
    expect(outcome).toMatchObject({
      status: "failed",
      errorClass: "input_too_large",
      retryable: false,
    });
  });

  test("an unknown preset slug fails model_preset_not_found without touching the DB", async () => {
    // resolvePresetModel guards the pgEnum slug BEFORE querying, so the
    // poisoned db proves no query was issued.
    const outcome = await executeInferStep(
      contextFor(poisonedDb, "org", inferStep({ preset: "warp-speed" }), {
        prompt: "hi",
      }),
    );
    expect(outcome).toMatchObject({
      status: "failed",
      errorClass: "model_preset_not_found",
      retryable: false,
    });
  });
});

// ── DB-gated: the wire ───────────────────────────────────────────────────────

if (!TEST_DATABASE_URL) {
  console.warn(
    "[pipeline-infer] TEST_DATABASE_URL not set — skipping infer-step executor tests",
  );
}

describe.skipIf(!TEST_DATABASE_URL)("executeInferStep", () => {
  let handle: DbHandle;
  let orgId: string;
  let allowlistId: string;

  function keys(baseUrl: string): PipelineExecutorDeps["providerKeys"] {
    return { openrouterApiKey: "wire-key", openrouterBaseUrl: baseUrl };
  }

  beforeAll(async () => {
    await runMigrations(TEST_DATABASE_URL!);
    handle = createDb(TEST_DATABASE_URL!, { max: 2 });
    orgId = `org-pinfer-${randomUUID()}`;
    await handle.db.insert(schema.organization).values({
      id: orgId,
      name: "Infer Step Org",
      slug: orgId,
      createdAt: new Date(),
    });
    await handle.db.insert(schema.modelPresets).values({
      organizationId: orgId,
      slug: "quick",
      provider: "openrouter",
      modelId: MODEL_ID,
      reasoning: "low",
    });
    const allowRows = await handle.db
      .insert(schema.modelAllowlist)
      .values({
        organizationId: orgId,
        provider: "openrouter",
        modelId: MODEL_ID,
        enabled: true,
      })
      .returning({ id: schema.modelAllowlist.id });
    allowlistId = allowRows[0]!.id;
  }, 30_000);

  afterAll(async () => {
    await handle?.db
      .delete(schema.organization)
      .where(eq(schema.organization.id, orgId));
    await handle?.close();
  }, 15_000);

  test("text path: generateText with the preset's effort on extraBody, usage persisted", async () => {
    using gw = stubGateway([{ content: "All clear." }]);
    const outcome = await executeInferStep(
      contextFor(
        handle.db,
        orgId,
        inferStep(),
        { prompt: "Summarize the day." },
        keys(gw.baseUrl),
      ),
    );
    expect(outcome).toMatchObject({
      status: "succeeded",
      output: {
        text: "All clear.",
        usage: { inputTokens: 3, outputTokens: 5, totalTokens: 8 },
      },
    });
    expect(gw.captured.length).toBe(1);
    const body = gw.captured[0]!.body;
    expect(body.model).toBe(MODEL_ID);
    // The preset's effort reaches the WIRE via extraBody (spike finding 29 —
    // the provider drops ai@7's top-level reasoning call option).
    expect(body.reasoning).toEqual({ effort: "low" });
    expect(body.max_tokens).toBe(INFER_DEFAULT_MAX_OUTPUT_TOKENS);
  });

  test("schema path: a valid object validates and lands as output.result", async () => {
    using gw = stubGateway([{ content: '{"title":"Standup summary"}' }]);
    const step = inferStep({
      output: {
        schema: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
        },
      },
    });
    const outcome = await executeInferStep(
      contextFor(handle.db, orgId, step, { prompt: "Title this." }, keys(gw.baseUrl)),
    );
    expect(outcome).toMatchObject({
      status: "succeeded",
      output: { result: { title: "Standup summary" } },
    });
    expect(gw.captured.length).toBe(1);
  });

  test("one repair retry carries the validator's errors, then succeeds", async () => {
    using gw = stubGateway([
      { content: '{"title":42}' },
      { content: '{"title":"Fixed"}' },
    ]);
    const step = inferStep({
      output: {
        schema: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
        },
      },
    });
    const outcome = await executeInferStep(
      contextFor(handle.db, orgId, step, { prompt: "Title this." }, keys(gw.baseUrl)),
    );
    expect(outcome).toMatchObject({
      status: "succeeded",
      output: { result: { title: "Fixed" } },
    });
    expect(gw.captured.length).toBe(2);
    // The repair prompt appends the validator's own error strings.
    const repairBody = JSON.stringify(gw.captured[1]!.body);
    expect(repairBody).toContain("failed validation");
    expect(repairBody).toContain("expected string");
    // Usage sums the two round-trips (honest cost).
    if (outcome.status !== "succeeded") throw new Error("unreachable");
    expect(outcome.output.usage).toEqual({
      inputTokens: 6,
      outputTokens: 10,
      totalTokens: 16,
    });
  });

  test("a second miss fails validation_failed, never retryable", async () => {
    using gw = stubGateway([{ content: '{"title":42}' }]);
    const step = inferStep({
      output: {
        schema: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
        },
      },
    });
    const outcome = await executeInferStep(
      contextFor(handle.db, orgId, step, { prompt: "Title this." }, keys(gw.baseUrl)),
    );
    expect(outcome).toMatchObject({
      status: "failed",
      errorClass: "validation_failed",
      retryable: false,
    });
    expect(gw.captured.length).toBe(2);
  });

  test("unparseable output is repairable the same way", async () => {
    using gw = stubGateway([
      { content: "Sure! Here's your JSON: {oops" },
      { content: '{"title":"Recovered"}' },
    ]);
    const step = inferStep({
      output: {
        schema: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
        },
      },
    });
    const outcome = await executeInferStep(
      contextFor(handle.db, orgId, step, { prompt: "Title this." }, keys(gw.baseUrl)),
    );
    expect(outcome).toMatchObject({
      status: "succeeded",
      output: { result: { title: "Recovered" } },
    });
    expect(gw.captured.length).toBe(2);
  });

  test("a disabled allowlist row fails model_not_allowlisted at execution", async () => {
    using gw = stubGateway([{ content: "never reached" }]);
    await handle.db
      .update(schema.modelAllowlist)
      .set({ enabled: false })
      .where(eq(schema.modelAllowlist.id, allowlistId));
    try {
      const outcome = await executeInferStep(
        contextFor(handle.db, orgId, inferStep(), { prompt: "hi" }, keys(gw.baseUrl)),
      );
      expect(outcome).toMatchObject({
        status: "failed",
        errorClass: "model_not_allowlisted",
        retryable: false,
      });
      expect(gw.captured.length).toBe(0);
    } finally {
      await handle.db
        .update(schema.modelAllowlist)
        .set({ enabled: true })
        .where(eq(schema.modelAllowlist.id, allowlistId));
    }
  });

  test("a keyless deployment fails provider_key_missing, typed", async () => {
    const outcome = await executeInferStep(
      contextFor(handle.db, orgId, inferStep(), { prompt: "hi" }, {}),
    );
    expect(outcome).toMatchObject({
      status: "failed",
      errorClass: "provider_key_missing",
      retryable: false,
    });
  });

  test("a provider 500 is provider_error and RETRYABLE (the runner owns the budget)", async () => {
    using gw = stubGateway([{ status: 500, content: "" }]);
    const outcome = await executeInferStep(
      contextFor(handle.db, orgId, inferStep(), { prompt: "hi" }, keys(gw.baseUrl)),
    );
    expect(outcome).toMatchObject({
      status: "failed",
      errorClass: "provider_error",
      retryable: true,
    });
  });
});
