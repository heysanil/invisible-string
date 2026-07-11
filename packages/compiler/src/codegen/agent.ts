/**
 * `agent/agent.ts` — the eve runtime config with an EXPLICIT platform-resolved
 * model (never eve's default) and the world-postgres durability world.
 *
 * Provider quirks the templates encode (spike/REPORT.md + versions.json):
 * - `openrouter("<id>")` throws AI_LoadAPIKeyError at model CONSTRUCTION when
 *   the key is missing (friction 4), so the provider model is only built when
 *   OPENROUTER_API_KEY is set; otherwise the model-id STRING keeps keyless
 *   `eve build` / `eve start` alive (health/auth/channel routes work; model
 *   turns fail, which is expected).
 * - OPENROUTER_BASE_URL (optional) redirects the provider — this is how tests
 *   point the agent at a mock model gateway.
 * - `@ai-sdk/anthropic` resolves ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL
 *   lazily at request time (verified in 4.0.7 source), so plain
 *   `anthropic("<id>")` is keyless-build-safe.
 */
import type { ReasoningEffort } from "@invisible-string/shared";

import type { CompileDeps } from "../types";
import { tsString } from "./strings";

function reasoningLine(effort: ReasoningEffort): string {
  return `\n  reasoning: ${tsString(effort)},`;
}

/**
 * Context windows for the workspace-seeded OpenRouter models (source of
 * truth: OpenRouter /models `context_length`, verified 2026-07-03 — the
 * runtime calls OpenRouter, not the upstream vendor). Models outside the
 * seed set get a conservative default: the value only tunes eve's compaction
 * threshold, and compacting early is safe while compacting late overflows.
 */
const OPENROUTER_CONTEXT_WINDOW_TOKENS: Readonly<Record<string, number>> = {
  "z-ai/glm-5.2": 1_048_576,
  "deepseek/deepseek-v4-pro": 1_048_576,
  "deepseek/deepseek-v4-flash": 1_048_576,
};
const DEFAULT_OPENROUTER_CONTEXT_WINDOW_TOKENS = 131_072;

function openrouterContextWindowTokens(modelId: string): number {
  return (
    OPENROUTER_CONTEXT_WINDOW_TOKENS[modelId] ??
    DEFAULT_OPENROUTER_CONTEXT_WINDOW_TOKENS
  );
}

const WORLD_BLOCK = `  experimental: {
    workflow: {
      // Durability: all session/run state lives in Postgres, not local disk.
      // WORKFLOW_POSTGRES_URL is read AS-IS and must point at this agent
      // version's DEDICATED world database — the job prefix does NOT isolate
      // agents sharing a world DB (see packages/compiler/WORLD-ISOLATION.md).
      world: "@workflow/world-postgres",
    },
  },`;

export function emitAgentTs(
  deps: CompileDeps,
  reasoning: ReasoningEffort,
): string {
  const { resolvedModel } = deps;
  if (resolvedModel.provider === "anthropic") {
    return `import { anthropic } from "@ai-sdk/anthropic";
import { defineAgent } from "eve";

/**
 * Explicit platform-resolved model. @ai-sdk/anthropic reads
 * ANTHROPIC_API_KEY (and optional ANTHROPIC_BASE_URL) lazily at request
 * time, so keyless \`eve build\` / boots stay alive.
 */
export default defineAgent({
  model: anthropic(${tsString(resolvedModel.modelId)}),${reasoningLine(reasoning)}
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
 * STRING keeps keyless \`eve build\` / \`eve start\` alive:
 * \`openrouter("<id>")\` throws AI_LoadAPIKeyError at model construction.
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
  modelContextWindowTokens: ${openrouterContextWindowTokens(resolvedModel.modelId)},${reasoningLine(reasoning)}
${WORLD_BLOCK}
});
`;
}
