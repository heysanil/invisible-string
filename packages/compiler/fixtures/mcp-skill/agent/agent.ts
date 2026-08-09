import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import { defineAgent } from "eve";

const MODEL_ID = "deepseek/deepseek-v4-flash";

/**
 * Explicit platform-resolved model. With OPENROUTER_API_KEY set the agent
 * calls OpenRouter directly (OPENROUTER_BASE_URL optionally redirects the
 * provider, e.g. at a mock gateway in tests). Without the key the model-id
 * STRING is returned instead, eve bakes GATEWAY routing at build time, and
 * keyless `eve build` / `eve start` stay alive.
 *
 * The branch is REQUIRED — do not simplify it to a bare
 * `createOpenRouter({}).`. @openrouter/ai-sdk-provider@3.0.0 resolves the
 * key LAZILY, so `openrouter("<id>")` constructs fine without one and
 * raises AI_LoadAPIKeyError only on the first model call. Dropping the guard
 * would therefore NOT fail loudly at build: it would emit a provider model
 * with EXTERNAL routing baked in, build clean, boot clean, and die on the
 * agent's first turn.
 *
 * The reasoning effort rides the MODEL's `extraBody`, deliberately, and must
 * stay there:
 * - eve's own `reasoning:` config reaches ai@7 as the top-level
 *   `LanguageModelV4CallOptions.reasoning` call option, and
 *   @openrouter/ai-sdk-provider@3.0.0's `getArgs()` never destructures it —
 *   through that route the effort is silently DROPPED from every request.
 * - the provider's typed `reasoning` SETTING would reach the wire, but its
 *   effort union is xhigh|high|medium|low|minimal|none — it has no "max",
 *   which is exactly the top effort OpenRouter advertises for the seeded
 *   models.
 * `settings.extraBody` is spread LAST over the request body, so it wins over
 * anything the provider derived.
 *
 * Two known losses, accepted: the keyless/gateway branch below carries no
 * effort at all (there is no model object to attach settings to), and eve's
 * agent-info introspection route reports `config.reasoning`, which is now
 * unset for OpenRouter agents.
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
    return openrouter(MODEL_ID, {
      extraBody: { reasoning: { effort: "high" } },
    });
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
  modelContextWindowTokens: 1048576,
  limits: {
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
    // pin. Omission and `false` are different values; this is the hook a
    // future per-agent output cap would fill.
  },
  experimental: {
    workflow: {
      // Durability: all session/run state lives in Postgres, not local disk.
      // WORKFLOW_POSTGRES_URL is read AS-IS and must point at this agent
      // version's DEDICATED world database — the job prefix does NOT isolate
      // agents sharing a world DB (see packages/compiler/WORLD-ISOLATION.md).
      world: "@workflow/world-postgres",
    },
  },
});
