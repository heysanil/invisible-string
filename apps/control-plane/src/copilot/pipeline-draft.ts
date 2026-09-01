/**
 * Pipeline-draft tree mechanics for the workflow copilot: position
 * resolution + insert/replace/remove/move over a step tree, and the
 * publish-gate-mirroring problem collector validate.ts diffs proposals
 * against.
 *
 * Everything here is PURE over `PipelineStep[]` values (the mutating helpers
 * mutate the array they are given — validate.ts hands them clones for
 * simulation and the accepted draft state for application, so simulate and
 * apply cannot drift). The problem collector deliberately reports the WHOLE
 * tree: validate.ts computes before/after sets and classifies only the NEW
 * problems, so a mid-edit draft that already carries issues never blocks an
 * unrelated proposal (draft-lenient, exactly like the shared schemas).
 */
import {
  findStep,
  parseReferences,
  stepsBefore,
  walkSteps,
  type PipelineCondition,
  type PipelineStep,
  type StepPosition,
  type TriggerConfig,
} from "@invisible-string/shared";

import type { WorkspaceInventory } from "./inventory";

// ── id preparation (addStep strips, updateStep preserves) ────────────────────

/**
 * Deep-copy a RAW candidate step subtree with every step-shaped node's `id`
 * REMOVED, mirroring `mintStepIds`' walk exactly (for_each.steps,
 * branch.branches[n].steps, branch.else — nothing else). addStep runs this
 * BEFORE minting so a model-supplied id — even a well-formed one copied from
 * an existing step — is never honored: new-step ids are minted server-side,
 * full stop.
 */
export function stripStepIds(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return value;
  }
  const step = value as Record<string, unknown>;
  const out: Record<string, unknown> = { ...step };
  delete out.id;
  if (step.kind === "for_each" && Array.isArray(step.steps)) {
    out.steps = step.steps.map(stripStepIds);
  } else if (step.kind === "branch") {
    if (Array.isArray(step.branches)) {
      out.branches = step.branches.map((branch) => {
        if (
          branch === null ||
          typeof branch !== "object" ||
          Array.isArray(branch)
        ) {
          return branch;
        }
        const lane = branch as Record<string, unknown>;
        return Array.isArray(lane.steps)
          ? { ...lane, steps: lane.steps.map(stripStepIds) }
          : lane;
      });
    }
    if (Array.isArray(step.else)) {
      out.else = step.else.map(stripStepIds);
    }
  }
  return out;
}

// ── tree addressing ──────────────────────────────────────────────────────────

/** Every step id in the tree (walk order). */
export function allStepIds(steps: readonly PipelineStep[]): Set<string> {
  return new Set(walkSteps(steps).map((entry) => entry.step.id));
}

/** Ids of one step's whole subtree (itself included). */
export function subtreeStepIds(step: PipelineStep): Set<string> {
  return allStepIds([step]);
}

/** Model-facing roster of the draft's step ids, for unknown-id errors. */
export function describeKnownSteps(steps: readonly PipelineStep[]): string {
  const lines = walkSteps(steps).map(
    (entry) =>
      `${entry.step.id} (${entry.step.kind}${
        entry.step.slug ? ` "${entry.step.slug}"` : ""
      })`,
  );
  return lines.join(", ") || "(none — the draft has no steps yet)";
}

/** Locate the LIST holding a step (direct parent list) plus its index. */
function locateStep(
  steps: PipelineStep[],
  stepId: string,
): { list: PipelineStep[]; index: number } | null {
  const search = (list: PipelineStep[]): { list: PipelineStep[]; index: number } | null => {
    for (const [index, step] of list.entries()) {
      if (step.id === stepId) return { list, index };
      if (step.kind === "for_each") {
        const found = search(step.steps);
        if (found) return found;
      } else if (step.kind === "branch") {
        for (const branch of step.branches) {
          const found = search(branch.steps);
          if (found) return found;
        }
        if (step.else) {
          const found = search(step.else);
          if (found) return found;
        }
      }
    }
    return null;
  };
  return search(steps);
}

/**
 * Resolve a {@link StepPosition}'s target list, enforcing the slot contract
 * the shared schema documents: `body` needs a for_each parent, `then`/`else`
 * a branch parent; a `then` lane resolves from `after` (null = the first
 * lane); a missing `else` list is CREATED (which is why apply-time callers
 * pass the real tree and simulation callers pass a clone).
 */
function resolveTargetList(
  steps: PipelineStep[],
  position: StepPosition,
): { list: PipelineStep[] } | { error: string } {
  if (!position.parent) return { list: steps };
  const parent = findStep(steps, position.parent.stepId);
  if (!parent) {
    return {
      error: `position.parent.stepId "${position.parent.stepId}" does not exist in the draft — known steps: ${describeKnownSteps(steps)}`,
    };
  }
  const { slot } = position.parent;
  if (slot === "body") {
    if (parent.kind !== "for_each") {
      return {
        error: `slot "body" requires a for_each parent — step "${parent.id}" is a ${parent.kind} step`,
      };
    }
    return { list: parent.steps };
  }
  if (parent.kind !== "branch") {
    return {
      error: `slot "${slot}" requires a branch parent — step "${parent.id}" is a ${parent.kind} step`,
    };
  }
  if (slot === "else") {
    if (!parent.else) parent.else = [];
    return { list: parent.else };
  }
  // slot "then": the lane is resolved from `after`; null targets the first.
  if (position.after === null) {
    const first = parent.branches[0];
    if (!first) {
      return { error: `branch "${parent.id}" has no lanes to insert into` };
    }
    return { list: first.steps };
  }
  const lane = parent.branches.find((branch) =>
    branch.steps.some((step) => step.id === position.after),
  );
  if (!lane) {
    return {
      error: `position.after "${position.after}" is not a direct child of any lane of branch "${parent.id}"`,
    };
  }
  return { list: lane.steps };
}

/**
 * Insert `step` at `position` (mutates `steps`). Returns a model-facing
 * error string when the position does not resolve, null on success.
 */
export function insertStep(
  steps: PipelineStep[],
  step: PipelineStep,
  position: StepPosition,
): string | null {
  const target = resolveTargetList(steps, position);
  if ("error" in target) return target.error;
  if (position.after === null) {
    target.list.unshift(step);
    return null;
  }
  const index = target.list.findIndex((s) => s.id === position.after);
  if (index === -1) {
    const children = target.list.map((s) => s.id).join(", ") || "(empty)";
    return `position.after "${position.after}" is not a direct child of the target list — direct children: ${children}`;
  }
  target.list.splice(index + 1, 0, step);
  return null;
}

/** Replace the step named by `stepId` in place. False when it is unknown. */
export function replaceStepById(
  steps: PipelineStep[],
  stepId: string,
  step: PipelineStep,
): boolean {
  const located = locateStep(steps, stepId);
  if (!located) return false;
  located.list[located.index] = step;
  return true;
}

/** Detach and return the step named by `stepId` (subtree and all). */
export function removeStepById(
  steps: PipelineStep[],
  stepId: string,
): PipelineStep | null {
  const located = locateStep(steps, stepId);
  if (!located) return null;
  const [removed] = located.list.splice(located.index, 1);
  return removed ?? null;
}

// ── publish-gate-mirroring problem collection ────────────────────────────────

/**
 * One diagnosable problem in a pipeline tree. `stepId` attributes it (so
 * validate.ts can tell "inside the proposed subtree" from collateral);
 * `message` names the step itself and is the stable diff key, so it must be
 * a pure function of the tree + trigger + inventory. `warning` severity is
 * reserved for advisories that must never block a proposal (a tool name
 * missing from a stale cache — the live server is authoritative).
 */
export interface PipelineProblem {
  stepId: string;
  severity: "error" | "warning";
  message: string;
}

/** `steps` head + trigger-path legality, shared with validate.ts's checks. */
export function triggerPathProblem(
  trigger: TriggerConfig,
  path: string,
  raw: string,
): string | null {
  if (path === "") {
    return `bare "${raw}" reference — name a data path like "@trigger.email"`;
  }
  if (
    trigger.type !== "form" &&
    trigger.type !== "webhook" &&
    trigger.type !== "slack"
  ) {
    return `"${raw}" cannot be used with a "${trigger.type}" trigger — it carries no dispatch data (propose setTrigger to a form/webhook/slack trigger first)`;
  }
  if (trigger.type === "form") {
    const head = path.split(".")[0] ?? "";
    if (!trigger.fields.some((field) => field.key === head)) {
      return `"${raw}" does not match any form field key (fields: ${trigger.fields
        .map((field) => field.key)
        .join(", ")})`;
    }
  }
  return null;
}

/** Collect every sole-key `{$ref}` path and `{$tpl}` string in a JSON value. */
function harvestTags(
  value: unknown,
  out: { refs: string[]; tpls: string[] },
): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const entry of value) harvestTags(entry, out);
    return;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length === 1 && keys[0] === "$ref" && typeof record.$ref === "string") {
    out.refs.push(record.$ref);
    return;
  }
  if (keys.length === 1 && keys[0] === "$tpl" && typeof record.$tpl === "string") {
    out.tpls.push(record.$tpl);
    return;
  }
  for (const entry of Object.values(record)) harvestTags(entry, out);
}

function stepLabel(step: PipelineStep): string {
  return step.slug ? `step "${step.slug}"` : `step ${step.id}`;
}

/**
 * Walk one tree and report every publish-gate-grade problem the copilot can
 * see: tree integrity (duplicate ids/slugs, empty slugs, nested for_each),
 * per-kind semantics against the inventory (tool connections
 * existing/enabled/workspace-scoped, infer presets, agent steps published,
 * thread-session legality), and every reference — markdown `@refs`, `$tpl`
 * strings and `$ref` dot-paths — checked for head validity, PRECEDING-step
 * visibility, `@item` loop scoping, and trigger-path legality against the
 * (possibly turn-updated) trigger.
 */
export function collectPipelineProblems(
  steps: readonly PipelineStep[],
  trigger: TriggerConfig | null,
  inventory: WorkspaceInventory,
): PipelineProblem[] {
  const problems: PipelineProblem[] = [];
  const entries = walkSteps(steps);

  // Duplicate ids/slugs are attributed to EVERY occurrence: whichever copy
  // sits inside a proposed subtree must reject, wherever walk order put it.
  const byId = new Map<string, PipelineStep[]>();
  const bySlug = new Map<string, PipelineStep[]>();
  for (const { step } of entries) {
    byId.set(step.id, [...(byId.get(step.id) ?? []), step]);
    if (step.slug) {
      bySlug.set(step.slug, [...(bySlug.get(step.slug) ?? []), step]);
    }
  }
  for (const [id, group] of byId) {
    if (group.length < 2) continue;
    for (const step of group) {
      problems.push({
        stepId: step.id,
        severity: "error",
        message: `duplicate step id "${id}"`,
      });
    }
  }
  for (const [slug, group] of bySlug) {
    if (group.length < 2) continue;
    for (const step of group) {
      problems.push({
        stepId: step.id,
        severity: "error",
        message: `duplicate step slug "${slug}" (on ${group.map((s) => s.id).join(", ")}) — slugs are the @steps handles and must be unique`,
      });
    }
  }

  for (const entry of entries) {
    const { step, ancestors } = entry;
    const insideLoop = ancestors.some((a) => a.kind === "for_each");
    const push = (severity: "error" | "warning", detail: string) =>
      problems.push({
        stepId: step.id,
        severity,
        message: `${stepLabel(step)} (${step.kind}): ${detail}`,
      });

    if (step.slug === "") {
      push("error", `needs a slug — it is the step's @steps handle`);
    }
    if (step.kind === "for_each" && insideLoop) {
      push("error", "for_each steps cannot nest inside another for_each");
    }

    // The step's own agent context, when its markdown may @reference it.
    let agentContext: {
      name: string;
      connections: Set<string>;
      skills: Set<string>;
    } | null = null;

    switch (step.kind) {
      case "tool": {
        if (step.connectionId === "") {
          push(
            "error",
            "pick a connection — call searchConnectionTools to find the right tool first",
          );
          break;
        }
        const connection = inventory.connections.find(
          (c) => c.id === step.connectionId,
        );
        if (!connection) {
          const known = inventory.connections
            .filter((c) => c.enabled && c.scope === "workspace")
            .map((c) => `${c.id} (${c.name})`)
            .join(", ");
          push(
            "error",
            `connection id "${step.connectionId}" does not exist in this workspace — known workspace connections: ${known || "(none)"}`,
          );
          break;
        }
        if (connection.scope === "user") {
          push(
            "error",
            `connection "${connection.name}" is user-scoped — workflow tool steps run unattended and need a WORKSPACE connection`,
          );
          break;
        }
        if (!connection.enabled) {
          push("error", `connection "${connection.name}" is disabled`);
          break;
        }
        if (step.tool === "") {
          push(
            "error",
            "name the tool to call — searchConnectionTools lists the real tool names",
          );
          break;
        }
        // Cache checks are WARNING-grade: the live server is authoritative
        // and the cache may be stale or absent — never block on it.
        if (connection.cachedTools.length === 0) {
          push(
            "warning",
            `connection "${connection.name}" has no cached tool list (health=${connection.health}) — "${step.tool}" cannot be verified until a probe succeeds`,
          );
        } else if (
          !connection.cachedTools.some((tool) => tool.name === step.tool)
        ) {
          const names = connection.cachedTools
            .slice(0, 20)
            .map((tool) => tool.name)
            .join(", ");
          push(
            "warning",
            `tool "${step.tool}" is not in connection "${connection.name}"'s cached tool list (cached: ${names}${connection.cachedTools.length > 20 ? ", …" : ""}) — the live server is authoritative, but double-check with searchConnectionTools`,
          );
        }
        break;
      }
      case "infer": {
        if (!inventory.modelPresets.some((p) => p.slug === step.preset)) {
          const known = inventory.modelPresets.map((p) => p.slug).join(", ");
          push(
            "error",
            `preset "${step.preset}" is not a workspace model preset — known presets: ${known || "(none)"}`,
          );
        }
        break;
      }
      case "agent": {
        const published = inventory.agents
          .filter((a) => a.published)
          .map((a) => `${a.id} (${a.name})`)
          .join(", ");
        if (step.agentId === null) {
          push(
            "error",
            `name a PUBLISHED agent to delegate to — published agents: ${published || "(none)"}`,
          );
        } else {
          const agent = inventory.agents.find((a) => a.id === step.agentId);
          if (!agent) {
            push(
              "error",
              `agent id "${step.agentId}" does not exist in this workspace — published agents: ${published || "(none)"}`,
            );
          } else if (!agent.published) {
            push(
              "error",
              `agent "${agent.name}" has no published version and cannot handle workflow runs yet — published agents: ${published || "(none)"}`,
            );
          } else {
            agentContext = {
              name: agent.name,
              connections: new Set(agent.contextConnectionSlugs),
              skills: new Set(agent.contextSkillSlugs),
            };
          }
        }
        if (step.session === "thread") {
          // Publish rule: thread continuity is a Slack concept, and a thread
          // session's output is the conversation — never a schema.
          if (trigger !== null && trigger.type !== "slack") {
            push(
              "error",
              `session "thread" is only legal with a slack trigger (draft trigger: "${trigger.type}")`,
            );
          }
          if (step.output !== undefined) {
            push(
              "error",
              'session "thread" cannot carry an output schema — use session "fresh" for structured output',
            );
          }
        }
        break;
      }
      default:
        break;
    }

    // ── references ──
    const precedingSlugs = new Set(
      stepsBefore(steps, step.id)
        .map((s) => s.slug)
        .filter((slug) => slug !== ""),
    );
    const available = [...precedingSlugs].map((s) => `@steps.${s}`).join(", ");
    const refProblem = (detail: string) => push("error", detail);

    const checkMarkdown = (markdown: string): void => {
      for (const ref of parseReferences(markdown)) {
        if (ref.kind === "step") {
          if (ref.slug === "") {
            refProblem(`bare "@steps" reference — name a step slug`);
          } else if (!precedingSlugs.has(ref.slug)) {
            refProblem(
              `"${ref.raw}" must reference a PRECEDING step's slug (available here: ${available || "(none)"})`,
            );
          }
        } else if (ref.kind === "item") {
          if (!insideLoop) {
            refProblem(
              `"${ref.raw}" is only available inside a for_each body`,
            );
          }
        } else if (ref.kind === "trigger") {
          if (trigger !== null) {
            const found = triggerPathProblem(trigger, ref.path, ref.raw);
            if (found) refProblem(found);
          }
        } else if (ref.kind === "connection" || ref.kind === "skill") {
          // Live-context refs only mean something in agent instructions —
          // everywhere else they render as prose literals and are left alone.
          if (step.kind === "agent" && agentContext) {
            const has =
              ref.kind === "connection"
                ? agentContext.connections.has(ref.name)
                : ref.slug !== "" && agentContext.skills.has(ref.slug);
            if (!has) {
              const context = [
                ...[...agentContext.connections].map((s) => `@${s}`),
                ...[...agentContext.skills].map((s) => `@skill.${s}`),
              ].join(", ");
              refProblem(
                `"${ref.raw}" is not in agent "${agentContext.name}"'s published context (available: ${context || "(none)"})`,
              );
            }
          }
        }
        // state/now: keys are dynamic and @now is always legal.
      }
    };

    const checkRefPath = (path: string): void => {
      const raw = `{"$ref": "${path}"}`;
      const segments = path.split(".");
      const head = segments[0] ?? "";
      const rest = segments.slice(1).join(".");
      switch (head) {
        case "steps": {
          const slug = segments[1] ?? "";
          if (slug === "") {
            refProblem(`${raw} needs a step slug ("steps.<slug>.<path>")`);
          } else if (!precedingSlugs.has(slug)) {
            refProblem(
              `${raw} must reference a PRECEDING step's slug (available here: ${available || "(none)"})`,
            );
          }
          break;
        }
        case "item":
          if (!insideLoop) {
            refProblem(`${raw} is only available inside a for_each body`);
          }
          break;
        case "trigger":
          if (trigger !== null) {
            const found = triggerPathProblem(trigger, rest, raw);
            if (found) refProblem(found);
          }
          break;
        case "state":
          if (rest === "") {
            refProblem(`${raw} needs a state key ("state.<key>")`);
          }
          break;
        case "now":
          if (rest !== "") refProblem(`${raw} — "now" takes no path`);
          break;
        default:
          refProblem(
            `${raw} has an unknown head "${head}" — $ref paths start with trigger. / steps.<slug> / state.<key> / item / now`,
          );
          break;
      }
    };

    const tags: { refs: string[]; tpls: string[] } = { refs: [], tpls: [] };
    if (step.kind === "tool") harvestTags(step.args, tags);
    else if (step.kind === "state") harvestTags(step.set, tags);
    else if (step.kind === "for_each") harvestTags(step.items, tags);
    else if (step.kind === "filter") harvestConditionTags(step.where, tags);
    else if (step.kind === "branch") {
      for (const branch of step.branches) harvestConditionTags(branch.when, tags);
    }
    if (step.kind === "infer") checkMarkdown(step.prompt.markdown);
    if (step.kind === "agent") checkMarkdown(step.instructions.markdown);
    for (const tpl of tags.tpls) checkMarkdown(tpl);
    for (const path of tags.refs) checkRefPath(path);
  }

  return problems;
}

/** Conditions hold operands, not template values — but the tag walk matches. */
function harvestConditionTags(
  condition: PipelineCondition,
  out: { refs: string[]; tpls: string[] },
): void {
  harvestTags(condition, out);
}
