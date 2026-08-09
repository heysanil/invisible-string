import { anthropic } from "@ai-sdk/anthropic";
import { defineAgent } from "eve";

/**
 * Explicit platform-resolved model. @ai-sdk/anthropic reads
 * ANTHROPIC_API_KEY (and optional ANTHROPIC_BASE_URL) lazily at request
 * time, so keyless `eve build` / boots stay alive.
 */
export default defineAgent({
  model: anthropic("claude-opus-4-8"),
  // Platform-resolved reasoning effort. eve maps it onto an Anthropic
  // thinking budget (a fraction of the output budget), and @ai-sdk/anthropic
  // is spec-v4, so the config route works here — unlike OpenRouter.
  // The platform effort "max" is emitted as "xhigh": the AI SDK effort union
  // tops out there, and both mean "spend the most".
  reasoning: "xhigh",
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
