import { defineAgent } from "eve";

import { resolveModel } from "./lib/model.js";

export default defineAgent({
  model: resolveModel(),
  // Escape hatch for keyed builds: with OPENROUTER_API_KEY set, resolveModel()
  // returns the provider MODEL OBJECT and eve derives the gateway id
  // "openrouter/deepseek/deepseek-v4-flash", which the AI Gateway model
  // catalog cannot resolve ("does not have known AI Gateway context window
  // metadata" -> eve build fails). Setting the context window verbatim skips
  // the catalog lookup. 1,000,000 matches the catalog entry for
  // deepseek/deepseek-v4-flash (azure/deepseek/fireworks providers).
  modelContextWindowTokens: 1_000_000,
  experimental: {
    workflow: {
      // Durability bet: all session/run state lives in Postgres, not local disk.
      // Reads WORKFLOW_POSTGRES_URL (+ WORKFLOW_POSTGRES_JOB_PREFIX) from env.
      world: "@workflow/world-postgres",
    },
  },
});
