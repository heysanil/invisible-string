/**
 * `agent/agent.ts` — the eve runtime config with an EXPLICIT platform-resolved
 * model (never eve's default) and the world-postgres durability world.
 *
 * Provider quirks the templates encode (spike/REPORT.md + versions.json):
 * - `openrouter("<id>")` NO LONGER throws at model CONSTRUCTION. As of
 *   @openrouter/ai-sdk-provider@3.0.0 the key is resolved LAZILY: with no key
 *   present `createOpenRouter({})("<id>")` constructs successfully and
 *   AI_LoadAPIKeyError is raised only at the FIRST model call
 *   (doGenerate/doStream). The 6.0.0-alpha.1 line threw at construction —
 *   spike friction 4 described THAT behavior and is superseded here
 *   (re-verified empirically against both lines, 2026-08-07).
 *   This makes the OPENROUTER_API_KEY guard below MORE load-bearing, not
 *   redundant. It is no longer backstopped by a loud build-time throw:
 *   without the guard a keyless build would construct a real provider model,
 *   eve would bake EXTERNAL routing into the artifact, `eve build` would exit
 *   0 — and the agent's first turn would die at runtime. With the guard the
 *   keyless path returns the model-id STRING, eve bakes GATEWAY routing
 *   (confirmed in a cold 0.31.3 compiled-agent manifest), and the artifact is
 *   genuinely servable keyless (health/auth/channel routes work; model turns
 *   fail, which is expected). NEVER collapse the conditional.
 * - OPENROUTER_BASE_URL (optional) redirects the provider — this is how tests
 *   point the agent at a mock model gateway.
 * - `@ai-sdk/anthropic` resolves ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL
 *   lazily at request time (verified in 4.0.7 source), so plain
 *   `anthropic("<id>")` is keyless-build-safe.
 *
 * REASONING EFFORT is emitted DIFFERENTLY per provider, and the asymmetry is
 * deliberate (see the per-branch comments, which ship inside the generated
 * file):
 * - anthropic keeps eve's `reasoning:` config — @ai-sdk/anthropic is spec-v4
 *   and eve maps the effort onto a thinking budget.
 * - openrouter CANNOT use it: eve hands `reasoning` to ai@7 as a top-level
 *   LanguageModelV4CallOptions field and @openrouter/ai-sdk-provider@3.0.0's
 *   getArgs() never destructures it, so the effort is silently dropped. The
 *   effort therefore rides the MODEL's `extraBody` setting instead.
 */
import type { ReasoningEffort } from "@invisible-string/shared";

import type { CompileDeps } from "../types";
import { tsString } from "./strings";

/**
 * eve's `reasoning` config takes the AI SDK's effort union, which tops out at
 * `xhigh` — the platform's `max` (OpenRouter's own top effort for the seeded
 * models) has no member there, so the anthropic branch clamps it.
 */
function anthropicEffort(effort: ReasoningEffort): string {
  return effort === "max" ? "xhigh" : effort;
}

/**
 * The anthropic `reasoning:` line plus the comment explaining it. Empty for
 * `provider-default`: omitting the field entirely is what "let the provider
 * decide" means, and is distinct from `"none"` (explicitly no reasoning).
 */
function anthropicReasoningBlock(effort: ReasoningEffort): string {
  if (effort === "provider-default") return "";
  const clamped =
    effort === "max"
      ? `
  // The platform effort "max" is emitted as "xhigh": the AI SDK effort union
  // tops out there, and both mean "spend the most".`
      : "";
  return `
  // Platform-resolved reasoning effort. eve maps it onto an Anthropic
  // thinking budget (a fraction of the output budget), and @ai-sdk/anthropic
  // is spec-v4, so the config route works here — unlike OpenRouter.${clamped}
  reasoning: ${tsString(anthropicEffort(effort))},`;
}

/**
 * How the OpenRouter model is constructed for a given effort. `extraBody`
 * rather than eve's `reasoning:` config or the provider's own typed
 * `reasoning` setting — both would be wrong; the generated comment says why.
 */
function openrouterModelExpression(effort: ReasoningEffort): string {
  if (effort === "provider-default") return "openrouter(MODEL_ID)";
  return `openrouter(MODEL_ID, {
      extraBody: { reasoning: { effort: ${tsString(effort)} } },
    })`;
}

/**
 * The paragraph of the generated `resolveModel()` doc comment that explains
 * the effort plumbing. Its two "losses" are real and documented so nobody
 * "fixes" the artifact back onto the config route.
 */
function openrouterReasoningDoc(effort: ReasoningEffort): string {
  if (effort === "provider-default") {
    return ` *
 * The platform resolved the reasoning effort to "provider-default", so NO
 * reasoning field is sent at all and OpenRouter applies the model's own
 * behavior. (That is distinct from an explicit "none", which would disable
 * reasoning on a model that supports it.)`;
  }
  return ` *
 * The reasoning effort rides the MODEL's \`extraBody\`, deliberately, and must
 * stay there:
 * - eve's own \`reasoning:\` config reaches ai@7 as the top-level
 *   \`LanguageModelV4CallOptions.reasoning\` call option, and
 *   @openrouter/ai-sdk-provider@3.0.0's \`getArgs()\` never destructures it —
 *   through that route the effort is silently DROPPED from every request.
 * - the provider's typed \`reasoning\` SETTING would reach the wire, but its
 *   effort union is xhigh|high|medium|low|minimal|none — it has no "max",
 *   which is exactly the top effort OpenRouter advertises for the seeded
 *   models.
 * \`settings.extraBody\` is spread LAST over the request body, so it wins over
 * anything the provider derived.
 *
 * Two known losses, accepted: the keyless/gateway branch below carries no
 * effort at all (there is no model object to attach settings to), and eve's
 * agent-info introspection route reports \`config.reasoning\`, which is now
 * unset for OpenRouter agents.`;
}

/**
 * Context windows for the workspace-seeded OpenRouter models (source of
 * truth: OpenRouter /models `context_length`, verified 2026-08-08 — the
 * runtime calls OpenRouter, not the upstream vendor). Models outside the
 * seed set get a conservative default: the value only tunes eve's compaction
 * threshold, and compacting early is safe while compacting late overflows.
 *
 * The pre-2026-08-08 seed models stay listed: their agent versions are
 * immutable and must keep recompiling to the same bytes.
 */
const OPENROUTER_CONTEXT_WINDOW_TOKENS: Readonly<Record<string, number>> = {
  "z-ai/glm-5.2": 1_048_576,
  "deepseek/deepseek-v4-pro": 1_048_576,
  "deepseek/deepseek-v4-flash": 1_048_576,
  "moonshotai/kimi-k3": 1_048_576,
  "~deepseek/deepseek-v4-flash-latest": 1_048_576,
};
const DEFAULT_OPENROUTER_CONTEXT_WINDOW_TOKENS = 131_072;

function openrouterContextWindowTokens(modelId: string): number {
  return (
    OPENROUTER_CONTEXT_WINDOW_TOKENS[modelId] ??
    DEFAULT_OPENROUTER_CONTEXT_WINDOW_TOKENS
  );
}

/**
 * EXPLICIT runtime limits, not inherited. eve 0.31 applies a 40,000,000
 * input-token budget per root session and a 30-day `sessionTimeoutMs` whether
 * or not an agent configures them, so the platform pins both at the values
 * that match today's effective behavior. Inheriting silently would let a
 * future eve release move every published agent's runtime envelope without a
 * COMPILER_VERSION bump, a rebuild, or a hash change — the limits would drift
 * invisibly. Pinning them makes the envelope part of the artifact.
 *
 * These are PLATFORM constants: per-agent spend limits in the agent editor
 * are deliberately out of scope (design spec §6.2).
 */
const LIMITS_BLOCK = `  limits: {
    // eve's own default (40M). Crossing it does NOT kill the session: a
    // conversation-mode session parks on a deterministic Approve/Stop
    // prompt (input.requested with kind "session-limit", answered through
    // the normal HITL path); a task-mode run with no input channel instead
    // fails the next model call with SESSION_TOKEN_LIMIT_REACHED.
    maxInputTokensPerSession: 40_000_000,
    // eve's own default (30 days). The deadline starts at session creation
    // and survives restarts/redeploys; an in-flight turn is allowed to
    // settle, then eve emits session.completed and the next message starts
    // a fresh session.
    sessionTimeoutMs: 2_592_000_000,
    // maxOutputTokensPerSession is deliberately OMITTED: eve applies no
    // default for it (unset === uncapped), so there is no silent default to
    // pin. Omission and \`false\` are different values; this is the hook a
    // future per-agent output cap would fill.
  },`;

const WORLD_BLOCK = `  experimental: {
    workflow: {
      // Durability: all session/run state lives in Postgres, not local disk.
      // WORKFLOW_POSTGRES_URL is read AS-IS and must point at this agent
      // version's DEDICATED world database — the job prefix does NOT isolate
      // agents sharing a world DB (see packages/compiler/WORLD-ISOLATION.md).
      world: "@workflow/world-postgres",
    },
  },`;

export function emitAgentTs(deps: CompileDeps): string {
  const { resolvedModel } = deps;
  const reasoning = resolvedModel.reasoning;
  if (resolvedModel.provider === "anthropic") {
    return `import { anthropic } from "@ai-sdk/anthropic";
import { defineAgent } from "eve";

/**
 * Explicit platform-resolved model. @ai-sdk/anthropic reads
 * ANTHROPIC_API_KEY (and optional ANTHROPIC_BASE_URL) lazily at request
 * time, so keyless \`eve build\` / boots stay alive.
 */
export default defineAgent({
  model: anthropic(${tsString(resolvedModel.modelId)}),${anthropicReasoningBlock(reasoning)}
${LIMITS_BLOCK}
${WORLD_BLOCK}
});
`;
  }
  return `import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import { defineAgent } from "eve";

const MODEL_ID = ${tsString(resolvedModel.modelId)};

/**
 * Explicit platform-resolved model. With OPENROUTER_API_KEY set the agent
 * calls OpenRouter directly (OPENROUTER_BASE_URL optionally redirects the
 * provider, e.g. at a mock gateway in tests). Without the key the model-id
 * STRING is returned instead, eve bakes GATEWAY routing at build time, and
 * keyless \`eve build\` / \`eve start\` stay alive.
 *
 * The branch is REQUIRED — do not simplify it to a bare
 * \`createOpenRouter({}).\`. @openrouter/ai-sdk-provider@3.0.0 resolves the
 * key LAZILY, so \`openrouter("<id>")\` constructs fine without one and
 * raises AI_LoadAPIKeyError only on the first model call. Dropping the guard
 * would therefore NOT fail loudly at build: it would emit a provider model
 * with EXTERNAL routing baked in, build clean, boot clean, and die on the
 * agent's first turn.
${openrouterReasoningDoc(reasoning)}
 */
function resolveModel(): LanguageModel {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (apiKey !== undefined && apiKey.length > 0) {
    const openrouter = createOpenRouter({
      apiKey,
      ...(process.env.OPENROUTER_BASE_URL
        ? { baseURL: process.env.OPENROUTER_BASE_URL }
        : {}),
    });
    return ${openrouterModelExpression(reasoning)};
  }
  return MODEL_ID;
}

export default defineAgent({
  model: resolveModel(),
  // Verbatim context window — REQUIRED for OpenRouter models. eve build
  // evaluates this file and otherwise resolves the window from its
  // AI-Gateway model catalog, which cannot resolve module-backed OpenRouter
  // models (gateway id "openrouter/<id>" has no catalog slug) and knows
  // some ids under different slugs (z-ai/glm-5.2 vs zai/glm-5.2) — either
  // way "does not have known AI Gateway context window metadata" fails the
  // build (spike/agent-project documented this escape hatch).
  modelContextWindowTokens: ${openrouterContextWindowTokens(resolvedModel.modelId)},
${LIMITS_BLOCK}
${WORLD_BLOCK}
});
`;
}
