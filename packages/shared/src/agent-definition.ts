/**
 * AgentDefinition — the agent draft (PERSONA · MODEL · CONTEXT) stored on
 * `agents.draft` and snapshotted immutably into `agent_versions.definition`
 * at publish. This is the input to `packages/compiler`'s pure
 * `compile(AgentDefinition, deps)` — the agent is the compile unit.
 *
 * Draft-lenient by design: a draft may be incomplete in ways the compiler
 * rejects at publish (empty persona, unresolved @references, model not
 * allowlisted, run_as user no longer a member, …). This schema guards SHAPE,
 * not publishability.
 *
 * Enum values here mirror packages/db pgEnums (`model_preset_slug`,
 * `reasoning_effort`) — keep them in lockstep.
 */
import { z } from "zod";

// ── MODEL ───────────────────────────────────────────────────────────────────

/** Mirrors pgEnum `model_preset_slug` (spec §7). */
export const modelPresetSlugSchema = z.enum(["powerful", "balanced", "quick"]);
export type ModelPresetSlug = z.infer<typeof modelPresetSlugSchema>;

/**
 * Mirrors pgEnum `reasoning_effort`. The vocabulary is OpenRouter's
 * per-model `reasoning.supported_efforts` set (no model supports all of it —
 * the UI filters against the live catalog), plus one platform value:
 *
 * - `provider-default` (name borrowed from the AI SDK's own
 *   `CallSettings["reasoning"]` union) means OMIT the reasoning field from the
 *   request entirely. Distinct from `none`, which explicitly DISABLES
 *   reasoning. It is the escape hatch for the ~1/3 of catalog models with no
 *   reasoning support at all, where sending a reasoning block is unverified.
 *
 * `medium` is retained even though none of the seeded models supports it:
 * pre-existing drafts and IMMUTABLE published `agent_versions.definition`
 * snapshots carry it and must keep parsing.
 */
export const reasoningEffortSchema = z.enum([
  "provider-default",
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
]);
export type ReasoningEffort = z.infer<typeof reasoningEffortSchema>;

/**
 * Which model the agent runs on. Compile-time resolution order (spec §7):
 * `modelId → preset → workspace preset mapping → provider+modelId → emit
 * model: in agent.ts`, allowlist-checked at compile AND dispatch.
 */
export const agentModelSchema = z.object({
  /** Workspace model preset the agent resolves through. */
  preset: modelPresetSlugSchema.default("balanced"),
  /** Specific-model override; wins over `preset`. Must be allowlisted. */
  modelId: z.string().min(1).optional(),
  /**
   * Reasoning-effort OVERRIDE. `undefined` = inherit — the preset's own
   * effort when resolving through `preset`, `provider-default` when a
   * `modelId` override is in play (inheriting a preset's effort onto a
   * deliberately-chosen different model is the wrong semantic).
   *
   * Deliberately NOT `.default(…)`: a default would materialize an explicit
   * effort on every parse and permanently erase the inherit signal.
   */
  reasoning: reasoningEffortSchema.optional(),
});

export type AgentModel = z.infer<typeof agentModelSchema>;

// ── CONTEXT ─────────────────────────────────────────────────────────────────

const uuidArray = (what: string) =>
  z
    .array(z.uuid())
    .superRefine((ids, ctx) => {
      if (new Set(ids).size !== ids.length) {
        ctx.addIssue({
          code: "custom",
          message: `duplicate ${what} ids`,
        });
      }
    })
    .default([]);

/**
 * What the agent is equipped with. Ids point at `mcp_connections` / `skills`
 * rows; the control plane resolves them to concrete connection/skill
 * definitions before compiling.
 */
export const agentContextSchema = z.object({
  mcpConnectionIds: uuidArray("MCP connection"),
  skillIds: uuidArray("skill"),
});

export type AgentContext = z.infer<typeof agentContextSchema>;

// ── The full definition ─────────────────────────────────────────────────────

export const agentDefinitionSchema = z.object({
  /**
   * Root instructions markdown (`agent/instructions.md`). May reference the
   * agent's own context (`@<connection>` / `@skill.<slug>`); `@trigger.*` is
   * a compile error — trigger data belongs to workflow instructions, rendered
   * at dispatch (see render.ts). Empty is a valid DRAFT; the compiler
   * requires non-empty at publish.
   */
  persona: z.string().default(""),
  model: agentModelSchema,
  context: agentContextSchema,
});

/** Parsed (defaults applied) definition — what the compiler consumes. */
export type AgentDefinition = z.infer<typeof agentDefinitionSchema>;

/** Pre-parse shape (defaults still optional) — what API bodies may send. */
export type AgentDefinitionInput = z.input<typeof agentDefinitionSchema>;
