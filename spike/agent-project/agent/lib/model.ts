import { createOpenRouter } from "@openrouter/ai-sdk-provider";
import type { LanguageModel } from "ai";

/** Model slug used for spike runs (the platform's "quick" preset default). */
export const SPIKE_MODEL_ID = "deepseek/deepseek-v4-flash";

/**
 * Resolve the agent model.
 *
 * With OPENROUTER_API_KEY set, calls OpenRouter directly through the AI SDK
 * provider (`openrouter("provider/slug")` call style).
 *
 * Without the key, falls back to the gateway model-id STRING form so the
 * project still builds and boots: `openrouter("...")` throws
 * AI_LoadAPIKeyError at model-construction time when the key is missing
 * (verified empirically), which would break keyless `eve build`/`eve start`.
 * Keyless processes can serve health/auth/channel routes; any real model turn
 * fails at the provider call, which is expected.
 */
export function resolveModel(): LanguageModel {
  const apiKey = process.env.OPENROUTER_API_KEY;
  if (apiKey !== undefined && apiKey.length > 0) {
    const openrouter = createOpenRouter({ apiKey });
    return openrouter(SPIKE_MODEL_ID);
  }
  return SPIKE_MODEL_ID;
}
