/**
 * Workflow-surface copilot adapter (pipelines redesign): proposal →
 * builder-action mapping (1:1 with the copilot param shapes), apply targets,
 * step-card descriptions (stepPreview: position phrases, args diff table,
 * markdown diff), prompt chips (empty / non-empty / convert), and the
 * adapter factory.
 */
import { describe, expect, test } from "bun:test";
import type {
  AgentSummaryDto,
  CopilotProposal,
  PipelineStep,
  WorkflowConfig,
} from "@invisible-string/shared";

import type { WorkflowCopilotProposal } from "../lib/copilot/mutations";
import {
  applyTargetOfProposal,
  argsDiffRows,
  CONVERT_PROMPT,
  describeStepPosition,
  describeWorkflowProposal,
  displayTemplateValue,
  isWorkflowProposal,
  proposalToActions,
  stepCardData,
  stepDisplayTitle,
  unsupportedProposalDescription,
  workflowCopilotAdapter,
  type WorkflowBuilderStepAction,
} from "../lib/copilot/mutations";

const AGENT_ID = "a1111111-1111-4111-8111-111111111111";
const WORKFLOW_ID = "wf-1";
const CONNECTION_ID = "cn_slack12345678";

/** Minted-shaped step id from a mnemonic (charset [0-9a-z], length 16). */
function sid(mnemonic: string): string {
  return `st_${mnemonic.padEnd(16, "0").slice(0, 16)}`;
}

const searchStep: PipelineStep = {
  id: sid("search"),
  slug: "search",
  name: "Search Slack",
  kind: "tool",
  connectionId: CONNECTION_ID,
  tool: "search_messages",
  args: { query: { $tpl: "@trigger.text" }, limit: 20 },
  sideEffect: "at_least_once",
};

const summarizeStep: PipelineStep = {
  id: sid("summarize"),
  slug: "summarize",
  kind: "infer",
  preset: "quick",
  prompt: { markdown: "Summarize @item in one line." },
};

const loopStep: PipelineStep = {
  id: sid("loop"),
  slug: "each-message",
  kind: "for_each",
  items: { $ref: "steps.search.result.messages" },
  steps: [summarizeStep],
  maxItems: 50,
  onItemError: "continue",
};

const definition: WorkflowConfig = {
  version: 2,
  trigger: { type: "manual" },
  steps: [searchStep, loopStep],
  overlap: "skip",
};

function agentSummary(id: string, name: string): AgentSummaryDto {
  return {
    id,
    name,
    description: null,
    runAsUserId: "user-1",
    publishedVersionId: "v-1",
    publishedAt: "2026-07-01T00:00:00.000Z",
    buildStatus: "succeeded",
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
  };
}

const lookups = {
  agents: [agentSummary(AGENT_ID, "General assistant")],
  connections: [{ id: CONNECTION_ID, name: "Slack" }],
};

function proposal<T extends CopilotProposal["tool"]>(
  tool: T,
  params: Extract<CopilotProposal, { tool: T }>["params"],
): CopilotProposal {
  return { id: "p-1", tool, params, rationale: "" } as CopilotProposal;
}

function workflowProposal<T extends WorkflowCopilotProposal["tool"]>(
  tool: T,
  params: Extract<CopilotProposal, { tool: T }>["params"],
): WorkflowCopilotProposal {
  const p = { id: "p-1", tool, params, rationale: "" } as unknown as CopilotProposal;
  if (!isWorkflowProposal(p)) throw new Error("expected workflow proposal");
  return p;
}

// ── mapping ─────────────────────────────────────────────────────────────────

describe("proposalToActions", () => {
  test("every tool maps 1:1 onto the decreed builder action shapes", () => {
    const slack = {
      type: "slack",
      binding: { mentionOnly: true, includeDirectMessages: false },
    } as const;
    const cases: [CopilotProposal, WorkflowBuilderStepAction[]][] = [
      [
        workflowProposal("setTrigger", { trigger: slack }),
        [{ type: "setTrigger", trigger: slack }],
      ],
      [
        workflowProposal("addStep", { step: summarizeStep, position: { after: null } }),
        [{ type: "addStep", step: summarizeStep, position: { after: null } }],
      ],
      [
        workflowProposal("updateStep", { stepId: sid("search"), step: searchStep }),
        [{ type: "updateStep", stepId: sid("search"), step: searchStep }],
      ],
      [
        workflowProposal("removeStep", { stepId: sid("loop") }),
        [{ type: "removeStep", stepId: sid("loop") }],
      ],
      [
        workflowProposal("moveStep", {
          stepId: sid("summarize"),
          position: { after: sid("search") },
        }),
        [
          {
            type: "moveStep",
            stepId: sid("summarize"),
            position: { after: sid("search") },
          },
        ],
      ],
    ];
    for (const [p, actions] of cases) {
      if (!isWorkflowProposal(p)) throw new Error("expected workflow proposal");
      expect(proposalToActions(p)).toEqual(actions);
    }
  });

  test("applyTargetOfProposal routes to the trigger card or the step id", () => {
    expect(
      applyTargetOfProposal(
        workflowProposal("setTrigger", { trigger: { type: "manual" } }),
      ),
    ).toEqual({ kind: "trigger" });
    // addStep targets the MINTED id on the step itself (the strip's key).
    expect(
      applyTargetOfProposal(
        workflowProposal("addStep", {
          step: summarizeStep,
          position: { after: null },
        }),
      ),
    ).toEqual({ kind: "step", stepId: sid("summarize") });
    expect(
      applyTargetOfProposal(
        workflowProposal("removeStep", { stepId: sid("loop") }),
      ),
    ).toEqual({ kind: "step", stepId: sid("loop") });
  });

  test("isWorkflowProposal rejects agent-surface and retired memo tools", () => {
    expect(isWorkflowProposal(proposal("setPersona", { markdown: "x" }))).toBe(
      false,
    );
    // The memo-era tools no longer exist on any surface.
    expect(
      isWorkflowProposal({
        id: "p-x",
        tool: "setInstructions",
        params: { markdown: "x" },
        rationale: "",
      } as unknown as CopilotProposal),
    ).toBe(false);
    expect(
      isWorkflowProposal({
        id: "p-y",
        tool: "setAgent",
        params: { agentId: AGENT_ID },
        rationale: "",
      } as unknown as CopilotProposal),
    ).toBe(false);
  });
});

// ── display helpers ─────────────────────────────────────────────────────────

describe("display helpers", () => {
  test("stepDisplayTitle prefers name → slug → kind label", () => {
    expect(stepDisplayTitle(searchStep)).toBe("Search Slack");
    expect(stepDisplayTitle(summarizeStep)).toBe("summarize");
    expect(
      stepDisplayTitle({ ...summarizeStep, slug: "", name: undefined } as PipelineStep),
    ).toBe("Infer step");
  });

  test("stepCardData reuses the builder summary vocabulary (one grammar with the strip)", () => {
    // The summary line and the chip are lib/builder/summary.ts's stepSummary /
    // stepChipSummary — a proposal preview and the strip card it becomes must
    // never describe the same step in two dialects.
    expect(stepCardData(searchStep, lookups)).toEqual({
      kind: "tool",
      title: "Search Slack",
      summary: "search_messages · 2 args",
      chip: "Slack",
    });
    expect(stepCardData(summarizeStep, lookups)).toEqual({
      kind: "infer",
      title: "summarize",
      summary: "Summarize @item in one line.",
      chip: "quick",
    });
    expect(stepCardData(loopStep, lookups).chip).toBeNull();
    expect(
      stepCardData(
        {
          id: sid("gate"),
          slug: "gate",
          kind: "filter",
          where: { gt: [{ $ref: "steps.search.result.count" }, 0] },
        },
        lookups,
      ).summary,
    ).toBe("Continue when @steps.search.result.count > 0");
  });

  test("displayTemplateValue renders refs/tpls/literals for the args table", () => {
    expect(displayTemplateValue({ $ref: "steps.search.result" })).toBe(
      "@steps.search.result",
    );
    expect(displayTemplateValue({ $tpl: "since @state.cursor" })).toBe(
      "since @state.cursor",
    );
    expect(displayTemplateValue("literal")).toBe('"literal"');
    expect(displayTemplateValue(20)).toBe("20");
  });

  test("describeStepPosition phrases head/sibling/nested positions", () => {
    expect(describeStepPosition({ after: null }, definition.steps)).toBe(
      "at the start",
    );
    expect(
      describeStepPosition({ after: sid("search") }, definition.steps),
    ).toBe("after “Search Slack”");
    expect(
      describeStepPosition(
        { after: null, parent: { stepId: sid("loop"), slot: "body" } },
        definition.steps,
      ),
    ).toBe("at the start, inside “each-message”");
  });

  test("argsDiffRows unions keys and flags changes", () => {
    const rows = argsDiffRows(
      { query: { $tpl: "old" }, limit: 20 },
      { query: { $tpl: "new" }, limit: 20, channel: "C1" },
    );
    expect(rows).toEqual([
      { key: "query", before: "old", after: "new", changed: true },
      { key: "limit", before: "20", after: "20", changed: false },
      { key: "channel", before: null, after: '"C1"', changed: true },
    ]);
  });
});

// ── descriptions ────────────────────────────────────────────────────────────

describe("describeWorkflowProposal", () => {
  test("setTrigger names the new trigger and shows before→after", () => {
    const p = workflowProposal("setTrigger", {
      trigger: {
        type: "slack",
        binding: {
          mentionOnly: true,
          includeDirectMessages: false,
          channelId: "support",
        },
      },
    });
    const d = describeWorkflowProposal(p, definition, lookups);
    expect(d.title).toContain("Slack");
    expect(d.title).toContain("#support");
    expect(d.before).toContain("Manual");
    expect(d.stepPreview).toBeUndefined();
  });

  test("addStep builds a ghost card with position, args table and chip", () => {
    const p = workflowProposal("addStep", {
      step: searchStep,
      position: { after: null },
    });
    const d = describeWorkflowProposal(
      p,
      { ...definition, steps: [loopStep] },
      lookups,
    );
    expect(d.title).toBe("Add step: Search Slack");
    const preview = d.stepPreview!;
    expect(preview.mode).toBe("add");
    expect(preview.before).toBeNull();
    expect(preview.after).toEqual({
      kind: "tool",
      title: "Search Slack",
      summary: "search_messages · 2 args",
      chip: "Slack",
    });
    expect(preview.position).toBe("at the start");
    expect(preview.argsDiff).toEqual([
      { key: "query", before: null, after: "@trigger.text", changed: true },
      { key: "limit", before: null, after: "20", changed: true },
    ]);
  });

  test("updateStep diffs the current step: markdown via markdownDiff", () => {
    const p = workflowProposal("updateStep", {
      stepId: sid("summarize"),
      step: { ...summarizeStep, prompt: { markdown: "Summarize tersely." } },
    });
    const d = describeWorkflowProposal(p, definition, lookups);
    expect(d.title).toBe("Update step: summarize");
    expect(d.stepPreview?.mode).toBe("update");
    expect(d.stepPreview?.markdownDiff).toEqual({
      before: "Summarize @item in one line.",
      after: "Summarize tersely.",
    });
  });

  test("updateStep diffs tool args as key-value rows", () => {
    const p = workflowProposal("updateStep", {
      stepId: sid("search"),
      step: { ...searchStep, args: { ...searchStep.args, limit: 50 } },
    });
    const d = describeWorkflowProposal(p, definition, lookups);
    const rows = d.stepPreview?.argsDiff ?? [];
    expect(rows.find((row) => row.key === "limit")).toEqual({
      key: "limit",
      before: "20",
      after: "50",
      changed: true,
    });
    expect(rows.find((row) => row.key === "query")?.changed).toBe(false);
  });

  test("removeStep freezes the current card; unknown ids degrade to the raw id", () => {
    const known = describeWorkflowProposal(
      workflowProposal("removeStep", { stepId: sid("search") }),
      definition,
      lookups,
    );
    expect(known.title).toBe("Remove step: Search Slack");
    expect(known.stepPreview?.mode).toBe("remove");
    expect(known.stepPreview?.before?.title).toBe("Search Slack");
    expect(known.stepPreview?.after).toBeNull();

    const unknown = describeWorkflowProposal(
      workflowProposal("removeStep", { stepId: sid("ghost") }),
      definition,
      lookups,
    );
    expect(unknown.title).toBe(`Remove step: ${sid("ghost")}`);
    expect(unknown.stepPreview?.before).toBeNull();
  });

  test("moveStep phrases where the step sits and where it goes", () => {
    const p = workflowProposal("moveStep", {
      stepId: sid("summarize"),
      position: { after: sid("search") },
    });
    const d = describeWorkflowProposal(p, definition, lookups);
    expect(d.title).toBe("Move step: summarize");
    expect(d.before).toBe("at the start, inside “each-message”");
    expect(d.after).toBe("after “Search Slack”");
    expect(d.stepPreview?.position).toBe("after “Search Slack”");
  });

  test("off-surface proposals get the unsupported fallback", () => {
    const d = unsupportedProposalDescription(
      proposal("setPersona", { markdown: "x" }),
    );
    expect(d.title).toContain("setPersona");
    expect(d.before).toBeNull();
  });
});

// ── the adapter ─────────────────────────────────────────────────────────────

describe("workflowCopilotAdapter", () => {
  function makeAdapter(draft: WorkflowConfig = definition) {
    const dispatched: WorkflowBuilderStepAction[] = [];
    const applied: unknown[] = [];
    const adapter = workflowCopilotAdapter({
      workflowId: WORKFLOW_ID,
      getDraft: () => draft,
      dispatch: (action) => dispatched.push(action),
      agents: lookups.agents,
      connections: lookups.connections,
      onApplied: (target) => applied.push(target),
    });
    return { adapter, dispatched, applied };
  }

  test("entityRef names the workflow surface", () => {
    const { adapter } = makeAdapter();
    expect(adapter.entityRef).toEqual({
      surface: "workflow",
      entityId: WORKFLOW_ID,
    });
  });

  test("applyProposal dispatches reducer actions and reports the step target", () => {
    const { adapter, dispatched, applied } = makeAdapter();
    adapter.applyProposal(
      workflowProposal("removeStep", { stepId: sid("loop") }),
    );
    expect(dispatched).toEqual([{ type: "removeStep", stepId: sid("loop") }]);
    expect(applied).toEqual([{ kind: "step", stepId: sid("loop") }]);
  });

  test("applyProposal ignores off-surface proposals (server bug)", () => {
    const { adapter, dispatched, applied } = makeAdapter();
    adapter.applyProposal(proposal("setPersona", { markdown: "x" }));
    expect(dispatched).toEqual([]);
    expect(applied).toEqual([]);
  });

  test("promptChips: scaffold on empty, refine on multi-step, convert on single agent step", () => {
    const empty = makeAdapter({ ...definition, steps: [] });
    expect(empty.adapter.promptChips().length).toBeGreaterThan(0);
    expect(empty.adapter.promptChips()).not.toContain(CONVERT_PROMPT);

    const multi = makeAdapter();
    expect(multi.adapter.promptChips()).not.toEqual(empty.adapter.promptChips());
    expect(multi.adapter.promptChips()).not.toContain(CONVERT_PROMPT);

    const single = makeAdapter({
      ...definition,
      steps: [
        {
          id: sid("delegate"),
          slug: "delegate",
          kind: "agent",
          agentId: AGENT_ID,
          instructions: { markdown: "Do the thing." },
          session: "fresh",
        },
      ],
    });
    expect(single.adapter.promptChips()[0]).toBe(CONVERT_PROMPT);
  });

  test("describeProposal reads the LIVE draft via getDraft", () => {
    const { adapter } = makeAdapter();
    const d = adapter.describeProposal(
      workflowProposal("updateStep", {
        stepId: sid("summarize"),
        step: { ...summarizeStep, prompt: { markdown: "New prompt." } },
      }),
    );
    expect(d.stepPreview?.markdownDiff?.before).toBe(
      "Summarize @item in one line.",
    );
  });
});
