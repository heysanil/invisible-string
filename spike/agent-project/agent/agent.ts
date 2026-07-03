import { defineAgent } from "eve";

import { resolveModel } from "./lib/model.js";

export default defineAgent({
  model: resolveModel(),
  experimental: {
    workflow: {
      // Durability bet: all session/run state lives in Postgres, not local disk.
      // Reads WORKFLOW_POSTGRES_URL (+ WORKFLOW_POSTGRES_JOB_PREFIX) from env.
      world: "@workflow/world-postgres",
    },
  },
});
