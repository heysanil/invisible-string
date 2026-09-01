/**
 * Proposal validation: zod schema (shared, per tool) + semantic checks
 * against the fresh workspace inventory AND the turn's draft state. Invalid
 * tool calls never reach the client — they come back to the model as tool
 * errors so it self-corrects.
 *
 * Split per surface (design §5.7); the draft state carries the surface
 * discriminant, so a tool from the other surface is rejected outright. The
 * checks mirror the publish-time rules so an applied proposal never produces
 * a draft that publish rejects:
 *
 * workflow surface (pipelines redesign — workflow publish validator parity):
 * - the draft state IS the pipeline (trigger + step tree); granular
 *   mutations (addStep/updateStep/removeStep/moveStep/setTrigger) are
 *   validated by SIMULATING them on a clone and diffing publish-gate
 *   problems ({@link collectPipelineProblems}) before vs after — a mid-edit
 *   draft that already carries issues never blocks an unrelated proposal;
 * - NEW problems inside the proposed/moved subtree REJECT the call (the
 *   model self-corrects); new problems the mutation causes elsewhere
 *   (a removed step stranding later @refs, a trigger change breaking
 *   @trigger paths) are WARNINGS threaded into the tool result;
 * - step IDS ARE MINTED SERVER-SIDE: addStep strips every model-supplied id
 *   and mints fresh ones ({@link mintStepIds}) before schema parse;
 *   updateStep preserves valid nested ids but forces the root id to the
 *   addressed step — a replacement can rename a slug, never re-identify;
 * - unknown stepIds bounce with the draft's known-id roster so the model
 *   can self-correct instead of guessing.
 *
 * agent surface (compiler parity, packages/compiler/src/instructions.ts):
 * - `setPersona` refs must resolve to context ATTACHED to the agent (draft
 *   context ∪ addContext proposals accepted earlier in the same turn), and
 *   `@trigger.*` is rejected (compile error TRIGGER_REF_NOT_ALLOWED);
 * - `addContext` must point at an ENABLED connection (publish resolution
 *   drops disabled rows with context_resource_not_found);
 * - `setModel.modelId` must be on the enabled workspace allowlist, and an
 *   explicit `setModel.reasoning` must be an effort the EFFECTIVE model
 *   advertises — but only when the catalog answered (fail-open, same rule as
 *   the allowlist-add catalog check);
 * - `setName`/`setDescription` (spec D7.3/D7.4) edit the `agents` ROW rather
 *   than the definition, so there is no publish rule to mirror: the schemas
 *   are the PATCH route's own and the only semantic check is "this changes
 *   nothing", which spares the user a card they would just dismiss.
 */
import {
  agentCopilotMutationParamSchemas,
  copilotMutationParamSchemas,
  findStep,
  mintStepIds,
  parseReferences,
  pipelineStepSchema,
  triggerConfigSchema,
  workflowCopilotMutationParamSchemas,
  workflowCopilotReadParamSchemas,
  type CopilotAgentIdentity,
  type CopilotMutationParams,
  type CopilotMutationTool,
  type CopilotSurface,
  type PipelineStep,
  type TriggerConfig,
} from "@invisible-string/shared";

import type { WorkspaceInventory } from "./inventory";
import {
  allStepIds,
  collectPipelineProblems,
  describeKnownSteps,
  insertStep,
  removeStepById,
  replaceStepById,
  stripStepIds,
  subtreeStepIds,
  type PipelineProblem,
} from "./pipeline-draft";

export type MutationValidation =
  | {
      ok: true;
      tool: CopilotMutationTool;
      params: CopilotMutationParams[CopilotMutationTool];
      /**
       * Warning-grade advisories (never blocking): collateral the mutation
       * causes OUTSIDE its own subtree, and cache-grade uncertainty (a tool
       * name the probe cache cannot confirm). The session threads them into
       * the model's tool result once the proposal is applied.
       */
      warnings: string[];
    }
  | { ok: false; message: string };

/**
 * The draft state a turn validates against — seeded from the client's draft
 * at turn start and updated as the user ACCEPTS proposals mid-turn (see
 * session.ts) so later calls in the same turn validate against what the
 * draft will actually contain (an addStep referencing a step accepted a
 * moment ago, a setPersona following an accepted addContext).
 */
export interface WorkflowDraftState {
  surface: "workflow";
  /** null when the draft's trigger doesn't parse (lenient mid-edit drafts). */
  trigger: TriggerConfig | null;
  /**
   * The draft PIPELINE. Lenient per element: top-level steps that fail the
   * shared schema are dropped (they cannot be reasoned about), the rest
   * survive — a half-broken draft still lets the copilot work on the good
   * steps.
   */
  steps: PipelineStep[];
}

export interface AgentDraftState {
  surface: "agent";
  connectionIds: Set<string>;
  skillIds: Set<string>;
  /**
   * The agent's IDENTITY for this turn (spec D7.3/D7.4) — the frame's own
   * `identity` field (the editor's live values), else the persisted `agents`
   * row the plugin resolved. NOT read off the draft: the draft is an
   * `AgentDefinition` and carries neither column. Null when nothing resolved —
   * the no-op checks below then simply do not fire, which is the right failure
   * direction: a missing baseline must never turn a legitimate rename into an
   * error.
   */
  name: string | null;
  description: string | null;
  /**
   * The draft's MODEL selection, needed to know which model an effort-only
   * `setModel` would actually apply to. Loose strings: mid-edit drafts are
   * lenient, and an unrecognized preset simply finds no mapping (no check).
   */
  preset: string | null;
  /** Specific-model override; wins over `preset`, exactly as at publish. */
  modelId: string | null;
}

export type CopilotDraftState = WorkflowDraftState | AgentDraftState;

/**
 * Parse the loose client draft into the state the semantic checks need.
 *
 * `identity` is the agent surface's row identity (name + description) and
 * arrives BESIDE the draft, per the frame contract — the workflow surface
 * passes nothing.
 */
export function draftStateFor(
  surface: CopilotSurface,
  draft: Record<string, unknown>,
  identity: CopilotAgentIdentity | null = null,
): CopilotDraftState {
  if (surface === "workflow") {
    const trigger = triggerConfigSchema.safeParse(draft.trigger);
    const steps: PipelineStep[] = [];
    if (Array.isArray(draft.steps)) {
      for (const raw of draft.steps) {
        const parsed = pipelineStepSchema.safeParse(raw);
        if (parsed.success) steps.push(parsed.data);
      }
    }
    return {
      surface,
      trigger: trigger.success ? trigger.data : null,
      steps,
    };
  }
  const context = (draft.context ?? {}) as Record<string, unknown>;
  const model = (draft.model ?? {}) as Record<string, unknown>;
  const ids = (value: unknown): Set<string> =>
    new Set(
      Array.isArray(value)
        ? value.filter((item): item is string => typeof item === "string")
        : [],
    );
  return {
    surface,
    connectionIds: ids(context.mcpConnectionIds),
    skillIds: ids(context.skillIds),
    preset: typeof model.preset === "string" ? model.preset : null,
    modelId: typeof model.modelId === "string" ? model.modelId : null,
    // Identity rides ALONGSIDE the definition draft (it lives on the `agents`
    // row), so it comes from the caller, not from `draft`.
    name: identity?.name ?? null,
    description: identity?.description ?? null,
  };
}

/**
 * Apply an ACCEPTED mutation to the turn's draft state (session bookkeeping).
 * Best-effort by design: the params were validated against THIS state a
 * moment ago, so failures cannot happen in the normal flow, and bookkeeping
 * must never throw a turn.
 */
export function applyAcceptedMutation(
  state: CopilotDraftState,
  tool: CopilotMutationTool,
  params: CopilotMutationParams[CopilotMutationTool],
): void {
  if (state.surface === "workflow") {
    switch (tool) {
      case "setTrigger":
        state.trigger = (params as CopilotMutationParams["setTrigger"]).trigger;
        break;
      case "addStep": {
        const { step, position } = params as CopilotMutationParams["addStep"];
        // Clone so later accepted mutations never alias the params object the
        // proposal frame carried.
        insertStep(state.steps, structuredClone(step), position);
        break;
      }
      case "updateStep": {
        const { stepId, step } = params as CopilotMutationParams["updateStep"];
        replaceStepById(state.steps, stepId, structuredClone(step));
        break;
      }
      case "removeStep": {
        const { stepId } = params as CopilotMutationParams["removeStep"];
        removeStepById(state.steps, stepId);
        break;
      }
      case "moveStep": {
        const { stepId, position } = params as CopilotMutationParams["moveStep"];
        const removed = removeStepById(state.steps, stepId);
        if (removed && insertStep(state.steps, removed, position) !== null) {
          // Unreachable after validation; never lose the subtree regardless.
          state.steps.push(removed);
        }
        break;
      }
      default:
        break;
    }
    return;
  }
  switch (tool) {
    case "addContext": {
      const { kind, id } = params as CopilotMutationParams["addContext"];
      (kind === "connection" ? state.connectionIds : state.skillIds).add(id);
      break;
    }
    case "removeContext": {
      const { kind, id } = params as CopilotMutationParams["removeContext"];
      (kind === "connection" ? state.connectionIds : state.skillIds).delete(id);
      break;
    }
    case "setModel": {
      // Keeps a follow-up effort-only proposal in the same turn validating
      // against the model the user just accepted, not the stale one.
      const model = params as CopilotMutationParams["setModel"];
      if (model.preset !== undefined) state.preset = model.preset;
      if (model.modelId !== undefined) state.modelId = model.modelId;
      break;
    }
    case "setName":
      // Same reason: an accepted rename makes a second identical rename later
      // in the turn the no-op the check below catches.
      state.name = (params as CopilotMutationParams["setName"]).name;
      break;
    case "setDescription":
      state.description = (
        params as CopilotMutationParams["setDescription"]
      ).description;
      break;
    default:
      break;
  }
}

function invalid(message: string): MutationValidation {
  return { ok: false, message };
}

export function isMutationTool(name: string): name is CopilotMutationTool {
  return name in copilotMutationParamSchemas;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Pre-parse id preparation for the step-carrying workflow tools — the
 * server-side minting the shared contract decrees (`mintStepIds` docs):
 * - addStep: STRIP every model-supplied id, then mint fresh ones against the
 *   whole draft's id set — a new step never keeps an id the model wrote;
 * - updateStep: preserve well-formed nested ids that belong to the replaced
 *   subtree (so the model can keep children stable), re-mint anything
 *   missing/malformed/colliding, and force the ROOT id to the addressed
 *   stepId.
 */
function prepareWorkflowInput(
  tool: CopilotMutationTool,
  input: unknown,
  state: WorkflowDraftState,
): unknown {
  if (!isRecord(input)) return input;
  if (tool === "addStep") {
    const existing = allStepIds(state.steps);
    return { ...input, step: mintStepIds(stripStepIds(input.step), existing) };
  }
  if (tool === "updateStep") {
    const stepId = typeof input.stepId === "string" ? input.stepId : null;
    const target = stepId ? findStep(state.steps, stepId) : null;
    // Seen = every id OUTSIDE the replaced subtree, plus the root id itself
    // (so a nested reuse of it re-mints and the forced root stays unique).
    const seen = allStepIds(state.steps);
    if (target) {
      for (const id of subtreeStepIds(target)) {
        if (id !== stepId) seen.delete(id);
      }
    }
    const minted = mintStepIds(input.step, seen);
    if (stepId && isRecord(minted)) {
      (minted as Record<string, unknown>).id = stepId;
    }
    return { ...input, step: minted };
  }
  return input;
}

/**
 * Validate a raw model tool call against the turn's surface (carried on
 * `draftState`). Returns parsed params (plus warning advisories) on success
 * or a model-facing error message describing how to fix the call.
 *
 * READ tools never reach this on the workflow surface — the session executes
 * them inline first; on the agent surface they bounce with a surface hint.
 */
export function validateMutation(
  toolName: string,
  input: unknown,
  inventory: WorkspaceInventory,
  draftState: CopilotDraftState,
): MutationValidation {
  const registry =
    draftState.surface === "workflow"
      ? workflowCopilotMutationParamSchemas
      : agentCopilotMutationParamSchemas;
  if (!(toolName in registry)) {
    if (isMutationTool(toolName)) {
      return invalid(
        `tool "${toolName}" is not available on the ${draftState.surface} surface (available: ${Object.keys(registry).join(", ")})`,
      );
    }
    if (toolName in workflowCopilotReadParamSchemas) {
      return invalid(
        `tool "${toolName}" is a workflow-surface read tool and is not available on the ${draftState.surface} surface`,
      );
    }
    return invalid(`unknown tool "${toolName}"`);
  }
  const tool = toolName as CopilotMutationTool;
  const effectiveInput =
    draftState.surface === "workflow"
      ? prepareWorkflowInput(tool, input, draftState)
      : input;
  const parsed = copilotMutationParamSchemas[tool].safeParse(effectiveInput);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    return invalid(`invalid ${tool} params — ${issues}`);
  }
  const params = parsed.data as CopilotMutationParams[CopilotMutationTool];

  if (draftState.surface === "workflow") {
    return workflowMutationValidation(tool, params, inventory, draftState);
  }
  const problem = agentSemanticProblem(tool, params, inventory, draftState);
  if (problem) return invalid(problem);
  return { ok: true, tool, params, warnings: [] };
}

// ── workflow-surface semantics (simulate + problem diff) ─────────────────────

const problemKey = (p: PipelineProblem): string =>
  `${p.severity}|${p.stepId}|${p.message}`;

function workflowMutationValidation(
  tool: CopilotMutationTool,
  params: CopilotMutationParams[CopilotMutationTool],
  inventory: WorkspaceInventory,
  draftState: WorkflowDraftState,
): MutationValidation {
  // Simulate the mutation on a clone; structural failures (unknown ids, bad
  // positions) reject immediately with the draft's id roster.
  const simulated = structuredClone(draftState.steps);
  let simulatedTrigger = draftState.trigger;
  /** Ids whose NEW error-grade problems reject (the proposed subtree). */
  let affected = new Set<string>();

  switch (tool) {
    case "setTrigger": {
      simulatedTrigger = (params as CopilotMutationParams["setTrigger"]).trigger;
      break;
    }
    case "addStep": {
      const { step, position } = params as CopilotMutationParams["addStep"];
      const error = insertStep(simulated, structuredClone(step), position);
      if (error) return invalid(error);
      affected = subtreeStepIds(step);
      break;
    }
    case "updateStep": {
      const { stepId, step } = params as CopilotMutationParams["updateStep"];
      if (!findStep(draftState.steps, stepId)) {
        return invalid(unknownStepMessage(stepId, draftState.steps));
      }
      replaceStepById(simulated, stepId, structuredClone(step));
      affected = subtreeStepIds(step);
      break;
    }
    case "removeStep": {
      const { stepId } = params as CopilotMutationParams["removeStep"];
      if (!findStep(draftState.steps, stepId)) {
        return invalid(unknownStepMessage(stepId, draftState.steps));
      }
      removeStepById(simulated, stepId);
      // Nothing new to reject on: collateral (stranded refs) is warned about.
      break;
    }
    case "moveStep": {
      const { stepId, position } = params as CopilotMutationParams["moveStep"];
      const moving = findStep(draftState.steps, stepId);
      if (!moving) {
        return invalid(unknownStepMessage(stepId, draftState.steps));
      }
      const subtree = subtreeStepIds(moving);
      if (position.after !== null && subtree.has(position.after)) {
        return invalid(
          `cannot move step "${stepId}" relative to itself or into its own subtree ("${position.after}" is inside it)`,
        );
      }
      if (position.parent && subtree.has(position.parent.stepId)) {
        return invalid(
          `cannot move step "${stepId}" into its own subtree ("${position.parent.stepId}" is inside it)`,
        );
      }
      const removed = removeStepById(simulated, stepId);
      if (!removed) return invalid(unknownStepMessage(stepId, draftState.steps));
      const error = insertStep(simulated, removed, position);
      if (error) return invalid(error);
      affected = subtree;
      break;
    }
    default:
      break;
  }

  // Publish-gate problem diff: only problems the mutation INTRODUCES count —
  // a mid-edit draft's pre-existing issues never block an unrelated proposal.
  const before = new Set(
    collectPipelineProblems(draftState.steps, draftState.trigger, inventory).map(
      problemKey,
    ),
  );
  const fresh = collectPipelineProblems(
    simulated,
    simulatedTrigger,
    inventory,
  ).filter((p) => !before.has(problemKey(p)));

  const rejects = fresh.filter(
    (p) => p.severity === "error" && affected.has(p.stepId),
  );
  if (rejects.length > 0) {
    return invalid(
      `${tool} would produce steps that fail to publish: ${rejects
        .map((p) => p.message)
        .join("; ")}`,
    );
  }
  return {
    ok: true,
    tool,
    params,
    warnings: fresh.map((p) => p.message),
  };
}

function unknownStepMessage(stepId: string, steps: PipelineStep[]): string {
  return `stepId "${stepId}" does not exist in the draft — known steps: ${describeKnownSteps(steps)}. Never invent step ids; use the ids from the current draft.`;
}

// ── agent-surface semantics ──────────────────────────────────────────────────

/**
 * Which model a `setModel` proposal would actually run on, mirroring publish
 * resolution (runtime/model-resolution.ts): a specific-model override wins
 * outright — the proposal's own, else one already on the draft — and only
 * without one does the preset mapping apply. Undefined when nothing resolves
 * (unknown preset, presets not loaded); callers then skip the effort check.
 */
function effectiveModelId(
  params: CopilotMutationParams["setModel"],
  draftState: AgentDraftState,
  inventory: WorkspaceInventory,
): string | undefined {
  const override = params.modelId ?? draftState.modelId;
  if (override != null) return override;
  const slug = params.preset ?? draftState.preset;
  return inventory.modelPresets.find((preset) => preset.slug === slug)?.modelId;
}

function agentSemanticProblem(
  tool: CopilotMutationTool,
  params: CopilotMutationParams[CopilotMutationTool],
  inventory: WorkspaceInventory,
  draftState: AgentDraftState,
): string | null {
  switch (tool) {
    case "addContext":
    case "removeContext": {
      const { kind, id } = params as CopilotMutationParams["addContext"];
      const pool =
        kind === "connection" ? inventory.connections : inventory.skills;
      const item = pool.find((candidate) => candidate.id === id);
      if (!item) {
        const known = pool
          .map((candidate) => `${candidate.id} (${candidate.name})`)
          .join(", ");
        return `${kind} id "${id}" does not exist in this workspace — known ${kind}s: ${known || "(none)"}`;
      }
      // Attaching a DISABLED connection fails publish resolution with
      // context_resource_not_found; detaching one is always fine.
      if (
        tool === "addContext" &&
        kind === "connection" &&
        "enabled" in item &&
        item.enabled === false
      ) {
        const enabledNames = inventory.connections
          .filter((connection) => connection.enabled)
          .map((connection) => `${connection.id} (${connection.name})`)
          .join(", ");
        return `connection "${item.name}" is disabled and cannot be attached — enabled connections: ${enabledNames || "(none)"}`;
      }
      return null;
    }
    case "setModel": {
      const model = params as CopilotMutationParams["setModel"];
      if (
        model.modelId !== undefined &&
        !inventory.allowlist.some(
          (entry) => entry.enabled && entry.modelId === model.modelId,
        )
      ) {
        const allowed = inventory.allowlist
          .filter((entry) => entry.enabled)
          .map((entry) => entry.modelId)
          .join(", ");
        return `model "${model.modelId}" is not on this workspace's allowlist — allowed: ${allowed || "(none)"}`;
      }
      // `null` = clear the override (inherit) and `provider-default` = send no
      // reasoning setting at all; both are legal for every model. Only an
      // explicit LEVEL is checked, and only when the catalog answered — an
      // openrouter.ai outage must not start rejecting proposals (fail-open,
      // matching the allowlist-add catalog check).
      if (
        model.reasoning != null &&
        model.reasoning !== "provider-default" &&
        inventory.catalogAvailable
      ) {
        const target = effectiveModelId(model, draftState, inventory);
        const supported = inventory.allowlist.find(
          (entry) => entry.enabled && entry.modelId === target,
        )?.supportedEfforts;
        if (
          supported !== undefined &&
          supported !== null &&
          !supported.includes(model.reasoning)
        ) {
          return `reasoning effort "${model.reasoning}" is not supported by "${target}" — supported: ${
            supported.join(", ") || "(none — use provider-default)"
          }`;
        }
      }
      return null;
    }
    case "setName": {
      // Nothing to check against the inventory: duplicate agent names are
      // legal since spec D1 dropped `agents_organization_id_name_uidx`, and
      // the shape is exactly the PATCH route's own `agentNameSchema`. The one
      // real problem is a proposal that changes nothing — a card the user has
      // to dismiss for no reason.
      const { name } = params as CopilotMutationParams["setName"];
      if (draftState.name !== null && draftState.name.trim() === name.trim()) {
        return `the agent is already named "${name}" — propose a rename only when it should actually change`;
      }
      return null;
    }
    case "setDescription": {
      const { description } =
        params as CopilotMutationParams["setDescription"];
      if (
        draftState.description !== null &&
        draftState.description.trim() === description.trim()
      ) {
        return "the agent already has exactly this description — propose a change only when it should actually change";
      }
      return null;
    }
    case "setPersona": {
      const { markdown } = params as CopilotMutationParams["setPersona"];
      const problems: string[] = [];
      // Disabled connections are excluded: their refs fail publish resolution.
      const enabledConnections = inventory.connections.filter(
        (connection) => connection.enabled,
      );
      const attachedConnectionSlugs = new Set(
        enabledConnections
          .filter((connection) => draftState.connectionIds.has(connection.id))
          .map((connection) => connection.slug),
      );
      const attachedSkillSlugs = new Set(
        inventory.skills
          .filter((skill) => draftState.skillIds.has(skill.id))
          .map((skill) => skill.slug),
      );
      for (const ref of parseReferences(markdown)) {
        if (ref.kind === "trigger") {
          // Compiler parity: TRIGGER_REF_NOT_ALLOWED at agent publish.
          problems.push(
            `"${ref.raw}" is not allowed in an agent persona — trigger data exists only in workflow pipelines`,
          );
        } else if (ref.kind === "step" || ref.kind === "state" || ref.kind === "item" || ref.kind === "now") {
          // Pipeline scope refs have no meaning at agent compile time.
          problems.push(
            `"${ref.raw}" is not allowed in an agent persona — pipeline scope (@steps/@state/@item/@now) exists only in workflow pipelines`,
          );
        } else if (ref.kind === "connection") {
          if (!enabledConnections.some((c) => c.slug === ref.name)) {
            problems.push(
              `"${ref.raw}" references an unknown connection (known: ${
                enabledConnections.map((c) => `@${c.slug}`).join(", ") || "(none)"
              })`,
            );
          } else if (!attachedConnectionSlugs.has(ref.name)) {
            problems.push(
              `"${ref.raw}" references a connection that is not attached to this agent's context — propose addContext for it first (attached: ${
                [...attachedConnectionSlugs].map((slug) => `@${slug}`).join(", ") ||
                "(none)"
              })`,
            );
          }
        } else {
          if (ref.slug === "" || !inventory.skills.some((s) => s.slug === ref.slug)) {
            problems.push(
              `"${ref.raw}" references an unknown skill (known: ${
                inventory.skills.map((s) => `@skill.${s.slug}`).join(", ") || "(none)"
              })`,
            );
          } else if (!attachedSkillSlugs.has(ref.slug)) {
            problems.push(
              `"${ref.raw}" references a skill that is not attached to this agent's context — propose addContext for it first (attached: ${
                [...attachedSkillSlugs]
                  .map((slug) => `@skill.${slug}`)
                  .join(", ") || "(none)"
              })`,
            );
          }
        }
      }
      if (problems.length > 0) {
        return (
          `persona references resources that would fail to publish: ${problems.join("; ")}. ` +
          "Only reference attached workspace connections/skills (propose addContext first); never @trigger."
        );
      }
      return null;
    }
    default:
      return null;
  }
}
