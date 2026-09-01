/**
 * `infer` step executor — one direct control-plane model call on a workspace
 * preset (the session-titler precedent, generalized). The runner renders the
 * step's prompt markdown against the run scope and hands it here as `input`
 * (see {@link inferStepRenderedInputSchema}); this executor never re-renders.
 *
 * Model resolution and effort routing COPY the titler exactly:
 * preset → `resolvePresetModel` (model/presets.ts, the shared extraction),
 * provider construction lazy per call, `OPENROUTER_BASE_URL` honored so
 * harnesses can point the wire at a stub, and the reasoning effort taking a
 * DIFFERENT ROUTE PER PROVIDER — `extraBody` on OpenRouter (the provider's
 * `getArgs()` drops ai@7's top-level `reasoning` call option; spike finding
 * 29), the top-level option on Anthropic (spec-v4, `max` clamped to `xhigh`).
 * `model/reasoning.ts` owns that asymmetry; this module just applies it.
 * Keys come from the injected `providerKeys` RECORD, never `process.env` —
 * an ambient key must not turn an offline test run into billable traffic.
 *
 * The workspace model ALLOWLIST is re-checked at execution (the dispatch-time
 * stance): a preset's model was allowlisted when the workflow published, but
 * the allowlist is mutable and an unattended run must honor its current state.
 *
 * Output contract:
 *  - no `output.schema` → `generateText` → `{ text, usage }`
 *  - `output.schema`    → `generateObject` against the schema (as raw JSON
 *    Schema — the restricted shared subset IS one), then the SHARED compiled
 *    validator (`compileOutputSchema`) enforces it belt-and-braces →
 *    `{ result, usage }`. ONE repair retry re-prompts with the validator's
 *    errors appended; a second miss fails `validation_failed`.
 *  - `usage` sums token counts across the repair round-trips (honest cost).
 */
import {
  APICallError,
  generateObject,
  generateText,
  jsonSchema,
  NoObjectGeneratedError,
  type JSONSchema7,
  type LanguageModel,
} from "ai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { schema } from "@invisible-string/db";
import {
  compileOutputSchema,
  type OutputSchemaNode,
} from "@invisible-string/shared";

import type { Db } from "../../db";
import { resolvePresetModel, type PresetModelRef } from "../../model/presets";
import {
  anthropicReasoningEffort,
  openRouterReasoningSettings,
  type AnthropicReasoningEffort,
} from "../../model/reasoning";
import type {
  PipelineExecutorDeps,
  StepExecutor,
  StepOutcome,
} from "../types";

/** Rendered-prompt cap: over it the step FAILS `input_too_large` — silent
 *  truncation would produce confidently wrong output. */
export const INFER_MAX_PROMPT_BYTES = 131_072;

/** Output-token budget when the step sets none. */
export const INFER_DEFAULT_MAX_OUTPUT_TOKENS = 4_096;

/** Failure messages are bounded like every other `run_steps.error` writer. */
const MAX_STEP_ERROR_CHARS = 500;

/**
 * The DECREED rendered-input shape the runner persists to `run_steps.input`
 * for an `infer` step: the prompt markdown after `@reference` rendering.
 */
export const inferStepRenderedInputSchema = z.object({
  prompt: z.string(),
});
export type InferStepRenderedInput = z.infer<typeof inferStepRenderedInputSchema>;

export const executeInferStep: StepExecutor = async (ctx) => {
  const { deps, step } = ctx;
  if (step.kind !== "infer") {
    return failed("internal", `executeInferStep received a "${step.kind}" step`);
  }
  const parsed = inferStepRenderedInputSchema.safeParse(ctx.input);
  if (!parsed.success) {
    return failed(
      "internal",
      "rendered infer input is malformed — expected { prompt: string }",
    );
  }
  const prompt = parsed.data.prompt;
  if (new TextEncoder().encode(prompt).byteLength > INFER_MAX_PROMPT_BYTES) {
    return failed(
      "input_too_large",
      `rendered prompt exceeds the ${INFER_MAX_PROMPT_BYTES}-byte cap — truncating would produce confidently wrong output`,
    );
  }

  const model = await resolvePresetModel(deps.db, ctx.orgId, step.preset);
  if (!model) {
    return failed(
      "model_preset_not_found",
      `workspace has no "${step.preset}" model preset`,
    );
  }
  if (!(await isModelAllowlistedNow(deps.db, ctx.orgId, model))) {
    return failed(
      "model_not_allowlisted",
      `model "${model.modelId}" is no longer on this workspace's allowlist — the step was not executed`,
    );
  }

  const languageModel = buildLanguageModel(model, deps.providerKeys ?? {});
  if (!languageModel) {
    return failed(
      "provider_key_missing",
      `platform has no API key configured for provider "${model.provider}"`,
    );
  }
  // Anthropic-only: on OpenRouter the effort already rode `extraBody` in the
  // model settings above; adding the call option too would be inert but
  // misleading (session-title.ts documents the same split).
  const reasoning =
    model.provider === "anthropic"
      ? anthropicReasoningEffort(model.reasoning)
      : undefined;
  const maxOutputTokens = step.maxOutputTokens ?? INFER_DEFAULT_MAX_OUTPUT_TOKENS;

  try {
    if (step.output) {
      return await generateStructured({
        languageModel,
        schemaNode: step.output.schema,
        prompt,
        maxOutputTokens,
        reasoning,
        signal: ctx.signal,
      });
    }
    const result = await generateText({
      model: languageModel,
      prompt,
      maxOutputTokens,
      // The RUNNER owns retry policy (attempt budgets + backoff); the SDK's
      // internal retry loop would silently multiply it.
      maxRetries: 0,
      ...(reasoning ? { reasoning } : {}),
      abortSignal: ctx.signal,
    });
    return {
      status: "succeeded",
      output: { text: result.text, usage: usageRecord(result.usage) },
    };
  } catch (error) {
    return classifyModelFailure(error, ctx.signal);
  }
};

// ── structured output (schema + one repair retry) ────────────────────────────

interface StructuredCallInput {
  languageModel: LanguageModel;
  schemaNode: OutputSchemaNode;
  prompt: string;
  maxOutputTokens: number;
  reasoning: AnthropicReasoningEffort | undefined;
  signal: AbortSignal;
}

async function generateStructured(
  input: StructuredCallInput,
): Promise<StepOutcome> {
  const validator = compileOutputSchema(input.schemaNode);
  // The restricted subset is valid JSON Schema by construction — hand it to
  // the SDK raw (no validate fn: OUR compiled validator is the enforcement,
  // shared byte-for-byte with the SPA's preview).
  const schemaArg = jsonSchema<unknown>(
    input.schemaNode as unknown as JSONSchema7,
  );
  const usageTotal: Record<string, number> = {};
  let prompt = input.prompt;
  let lastErrors: string[] = [];
  // Attempt 0 is the step's own call; attempt 1 is the ONE repair retry.
  for (let attempt = 0; attempt < 2; attempt++) {
    let object: unknown;
    try {
      const result = await generateObject({
        model: input.languageModel,
        schema: schemaArg,
        prompt,
        maxOutputTokens: input.maxOutputTokens,
        maxRetries: 0, // the runner owns retry policy
        ...(input.reasoning ? { reasoning: input.reasoning } : {}),
        abortSignal: input.signal,
      });
      addUsage(usageTotal, result.usage);
      object = result.object;
    } catch (error) {
      if (!NoObjectGeneratedError.isInstance(error)) throw error;
      // Unparseable output is a validation miss, repairable like any other.
      if (error.usage) addUsage(usageTotal, error.usage);
      lastErrors = ["the output was not parseable as JSON"];
      prompt = repairPrompt(input.prompt, lastErrors);
      continue;
    }
    const checked = validator(object);
    if (checked.ok) {
      return {
        status: "succeeded",
        output: { result: checked.value, usage: usageTotal },
      };
    }
    lastErrors = checked.errors;
    prompt = repairPrompt(input.prompt, lastErrors);
  }
  return failed(
    "validation_failed",
    `output failed schema validation after a repair retry: ${lastErrors.join("; ")}`,
  );
}

function repairPrompt(basePrompt: string, errors: string[]): string {
  return [
    basePrompt,
    "",
    "Your previous answer failed validation against the required output schema:",
    ...errors.map((error) => `- ${error}`),
    "",
    "Answer again with ONLY corrected JSON that satisfies the schema.",
  ].join("\n");
}

// ── model construction + allowlist ───────────────────────────────────────────

/**
 * Lazy provider construction, null when the platform key is absent (a keyless
 * deployment fails the step typed, never throws `AI_LoadAPIKeyError`).
 * Byte-for-byte the titler's shape: `provider-default` yields a BARE
 * `openrouter(id)` — no settings object at all.
 */
function buildLanguageModel(
  model: PresetModelRef,
  keys: NonNullable<PipelineExecutorDeps["providerKeys"]>,
): LanguageModel | null {
  if (model.provider === "anthropic") {
    if (!keys.anthropicApiKey) return null;
    return createAnthropic({ apiKey: keys.anthropicApiKey })(model.modelId);
  }
  if (!keys.openrouterApiKey) return null;
  const openrouter = createOpenRouter({
    apiKey: keys.openrouterApiKey,
    ...(keys.openrouterBaseUrl ? { baseURL: keys.openrouterBaseUrl } : {}),
  });
  const settings = openRouterReasoningSettings(model.reasoning);
  return settings
    ? openrouter(model.modelId, settings)
    : openrouter(model.modelId);
}

/**
 * Execution-time mirror of the dispatch-time allowlist re-check
 * (runtime/dispatch.ts): present AND enabled on the CURRENT allowlist.
 * Local, not imported — executors stay decoupled from the dispatch module.
 */
async function isModelAllowlistedNow(
  db: Db,
  organizationId: string,
  model: PresetModelRef,
): Promise<boolean> {
  const rows = await db
    .select({ enabled: schema.modelAllowlist.enabled })
    .from(schema.modelAllowlist)
    .where(
      and(
        eq(schema.modelAllowlist.organizationId, organizationId),
        eq(schema.modelAllowlist.provider, model.provider),
        eq(schema.modelAllowlist.modelId, model.modelId),
      ),
    )
    .limit(1);
  return rows[0]?.enabled === true;
}

// ── failure classification + usage ───────────────────────────────────────────

function failed(errorClass: string, error: string): StepOutcome {
  return {
    status: "failed",
    errorClass,
    error: error.slice(0, MAX_STEP_ERROR_CHARS),
    retryable: false,
  };
}

/**
 * Provider-call failures. Retryable ONLY for transient provider conditions
 * (network, 429, 5xx) — the runner owns the attempt budget. API error
 * messages are NOT echoed (they can quote request bodies); the status code
 * and the SDK's own retryability flag are enough.
 */
function classifyModelFailure(
  error: unknown,
  signal: AbortSignal,
): StepOutcome {
  if (signal.aborted) return failed("canceled", "the run was canceled");
  if (APICallError.isInstance(error)) {
    const status = error.statusCode;
    const retryable =
      status === undefined
        ? error.isRetryable
        : status === 429 || status >= 500;
    return {
      status: "failed",
      errorClass: "provider_error",
      error: `model call failed${status !== undefined ? ` (HTTP ${status})` : ""}`,
      retryable,
    };
  }
  const message =
    error instanceof Error ? error.message || error.name : String(error);
  return failed("provider_error", `model call failed: ${message}`);
}

/** Flatten ai@7's usage into the plain numeric record persisted on output. */
function usageRecord(usage: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (usage === null || typeof usage !== "object") return out;
  const record = usage as Record<string, unknown>;
  for (const key of [
    "inputTokens",
    "outputTokens",
    "totalTokens",
    "reasoningTokens",
  ]) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) out[key] = value;
  }
  return out;
}

function addUsage(total: Record<string, number>, usage: unknown): void {
  for (const [key, value] of Object.entries(usageRecord(usage))) {
    total[key] = (total[key] ?? 0) + value;
  }
}
