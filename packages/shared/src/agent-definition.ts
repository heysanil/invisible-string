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

/** Mirrors pgEnum `reasoning_effort`. */
export const reasoningEffortSchema = z.enum(["low", "medium", "high"]);
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
  reasoning: reasoningEffortSchema.default("medium"),
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
