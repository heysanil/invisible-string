import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";
import { defineAgent } from "eve";

const MODEL_ID = "z-ai/glm-5.2";

/**
 * Explicit platform-resolved model. With OPENROUTER_API_KEY set the agent
 * calls OpenRouter directly (OPENROUTER_BASE_URL optionally redirects the
 * provider, e.g. at a mock gateway in tests). Without the key the model-id
 * STRING keeps keyless `eve build` / `eve start` alive:
 * `openrouter("<id>")` throws AI_LoadAPIKeyError at model construction.
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
    return openrouter(MODEL_ID);
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
  reasoning: "medium",
  experimental: {
    workflow: {
      // Durability: all session/run state lives in Postgres, not local disk.
      // WORKFLOW_POSTGRES_URL is read AS-IS and must point at this workflow
      // version's DEDICATED world database — the job prefix does NOT isolate
      // agents sharing a world DB (see packages/compiler/WORLD-ISOLATION.md).
      world: "@workflow/world-postgres",
    },
  },
});
