/**
 * Pipeline-draft tree mechanics — pure unit coverage for the position
 * resolver, the mutating helpers validate.ts simulates and applies with, the
 * id-strip walk, and the publish-gate-mirroring problem collector. Socket
 * behavior (how these surface to the model) lives in copilot.test.ts.
 */
import { describe, expect, test } from "bun:test";

import {
  pipelineStepSchema,
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
} from "./pipeline-draft";

const CONNECTION_ID = "cn_linear1234567890";
const USER_CONNECTION_ID = "cn_notesuser1234567";
const DISABLED_CONNECTION_ID = "cn_oldcrm1234567890";
const PUBLISHED_AGENT_ID = "dddddddd-1111-4222-8333-444444444444";
const UNPUBLISHED_AGENT_ID = "dddddddd-2222-4222-8333-444444444444";

const inventory: WorkspaceInventory = {
  connections: [
    {
      id: CONNECTION_ID,
      name: "Linear",
      slug: "linear",
      description: "issue tracker",
      enabled: true,
      scope: "workspace",
      health: "ok",
      tools: ["create_issue", "search_issues"],
      toolCount: 2,
      cachedTools: [
        {
          name: "create_issue",
          description: "Create a Linear issue",
          params: ["title", "description"],
        },
        {
          name: "search_issues",
          description: "Search Linear issues",
          params: ["query"],
        },
      ],
    },
    {
      id: USER_CONNECTION_ID,
      name: "Personal Notes",
      slug: "personal-notes",
      description: null,
      enabled: true,
      scope: "user",
      health: "ok",
      tools: ["add_note"],
      toolCount: 1,
      cachedTools: [{ name: "add_note", description: "", params: ["text"] }],
    },
    {
      id: DISABLED_CONNECTION_ID,
      name: "Old CRM",
      slug: "old-crm",
      description: null,
      enabled: false,
      scope: "workspace",
      health: "unknown",
      tools: [],
      toolCount: 0,
      cachedTools: [],
    },
  ],
  skills: [],
  agents: [
    {
      id: PUBLISHED_AGENT_ID,
      name: "Support Agent",
      description: null,
      published: true,
      contextConnectionSlugs: ["linear"],
      contextSkillSlugs: [],
    },
    {
      id: UNPUBLISHED_AGENT_ID,
      name: "Draft Agent",
      description: null,
      published: false,
      contextConnectionSlugs: [],
      contextSkillSlugs: [],
    },
  ],
  modelPresets: [
    { slug: "quick", provider: "openrouter", modelId: "anthropic/claude-haiku-4.5", reasoning: "low" },
  ],
  allowlist: [],
  catalogAvailable: true,
};

const step = (raw: unknown): PipelineStep => pipelineStepSchema.parse(raw);

const toolStep = (id: string, slug: string, overrides: Record<string, unknown> = {}) =>
  step({
    id,
    slug,
    kind: "tool",
    connectionId: CONNECTION_ID,
    tool: "search_issues",
    args: {},
    ...overrides,
  });

const ID_A = "st_aaaaaaaaaaaaaaaa";
const ID_B = "st_bbbbbbbbbbbbbbbb";
const ID_C = "st_cccccccccccccccc";
const ID_LOOP = "st_loopaaaaaaaaaaaa";
const ID_BRANCH = "st_branchaaaaaaaaaa";

const MANUAL: TriggerConfig = { type: "manual" };

function branchFixture(): PipelineStep[] {
  return [
    step({
      id: ID_BRANCH,
      slug: "route",
      kind: "branch",
      branches: [
        { when: { truthy: true }, steps: [toolStep(ID_A, "lane-one")] },
        { when: { truthy: false }, steps: [toolStep(ID_B, "lane-two")] },
      ],
    }),
  ];
}

describe("insertStep — position resolution", () => {
  test("after: null inserts at the head of the top level", () => {
    const steps = [toolStep(ID_A, "search")];
    const error = insertStep(steps, toolStep(ID_B, "first"), { after: null });
    expect(error).toBeNull();
    expect(steps.map((s) => s.slug)).toEqual(["first", "search"]);
  });

  test("after a top-level sibling inserts directly after it", () => {
    const steps = [toolStep(ID_A, "one"), toolStep(ID_B, "three")];
    const error = insertStep(steps, toolStep(ID_C, "two"), { after: ID_A });
    expect(error).toBeNull();
    expect(steps.map((s) => s.slug)).toEqual(["one", "two", "three"]);
  });

  test("an unknown `after` reports the target list's direct children", () => {
    const steps = [toolStep(ID_A, "one")];
    const error = insertStep(steps, toolStep(ID_B, "two"), {
      after: "st_zzzzzzzzzzzzzzzz",
    });
    expect(error).toContain("not a direct child");
    expect(error).toContain(ID_A);
  });

  test("slot body targets a for_each's steps and rejects other parents", () => {
    const steps = [
      step({
        id: ID_LOOP,
        slug: "each",
        kind: "for_each",
        items: { $ref: "trigger.items" },
        steps: [],
      }),
    ];
    const ok = insertStep(steps, toolStep(ID_A, "inner"), {
      after: null,
      parent: { stepId: ID_LOOP, slot: "body" },
    });
    expect(ok).toBeNull();
    const loop = steps[0]!;
    expect(loop.kind === "for_each" && loop.steps.map((s) => s.slug)).toEqual([
      "inner",
    ]);

    const wrongKind = insertStep([toolStep(ID_B, "flat")], toolStep(ID_C, "x"), {
      after: null,
      parent: { stepId: ID_B, slot: "body" },
    });
    expect(wrongKind).toContain('slot "body" requires a for_each parent');
  });

  test("slot then resolves the LANE from `after`; after: null targets the first lane", () => {
    const steps = branchFixture();
    expect(
      insertStep(steps, toolStep(ID_C, "head-of-first"), {
        after: null,
        parent: { stepId: ID_BRANCH, slot: "then" },
      }),
    ).toBeNull();
    const secondLane = insertStep(steps, toolStep("st_dddddddddddddddd", "after-two"), {
      after: ID_B,
      parent: { stepId: ID_BRANCH, slot: "then" },
    });
    expect(secondLane).toBeNull();
    const branch = steps[0]!;
    if (branch.kind !== "branch") throw new Error("fixture");
    expect(branch.branches[0]!.steps.map((s) => s.slug)).toEqual([
      "head-of-first",
      "lane-one",
    ]);
    expect(branch.branches[1]!.steps.map((s) => s.slug)).toEqual([
      "lane-two",
      "after-two",
    ]);
  });

  test("slot else CREATES the else list when the branch has none", () => {
    const steps = branchFixture();
    const error = insertStep(steps, toolStep(ID_C, "fallback"), {
      after: null,
      parent: { stepId: ID_BRANCH, slot: "else" },
    });
    expect(error).toBeNull();
    const branch = steps[0]!;
    expect(branch.kind === "branch" && branch.else?.map((s) => s.slug)).toEqual([
      "fallback",
    ]);
  });

  test("an unknown parent id reports the draft's known-step roster", () => {
    const steps = [toolStep(ID_A, "one")];
    const error = insertStep(steps, toolStep(ID_B, "x"), {
      after: null,
      parent: { stepId: "st_zzzzzzzzzzzzzzzz", slot: "body" },
    });
    expect(error).toContain("does not exist");
    expect(error).toContain(ID_A);
  });
});

describe("remove/replace/subtree helpers", () => {
  test("removeStepById detaches a nested subtree", () => {
    const steps = branchFixture();
    const removed = removeStepById(steps, ID_B);
    expect(removed?.slug).toBe("lane-two");
    const branch = steps[0]!;
    expect(branch.kind === "branch" && branch.branches[1]!.steps).toEqual([]);
    expect(removeStepById(steps, "st_zzzzzzzzzzzzzzzz")).toBeNull();
  });

  test("replaceStepById swaps in place, subtree position preserved", () => {
    const steps = branchFixture();
    expect(
      replaceStepById(steps, ID_A, toolStep(ID_A, "renamed-lane-one")),
    ).toBe(true);
    const branch = steps[0]!;
    expect(
      branch.kind === "branch" && branch.branches[0]!.steps[0]!.slug,
    ).toBe("renamed-lane-one");
  });

  test("allStepIds/subtreeStepIds cover containers; describeKnownSteps names slugs", () => {
    const steps = branchFixture();
    expect(allStepIds(steps)).toEqual(new Set([ID_BRANCH, ID_A, ID_B]));
    expect(subtreeStepIds(steps[0]!)).toEqual(new Set([ID_BRANCH, ID_A, ID_B]));
    expect(describeKnownSteps(steps)).toContain(`${ID_A} (tool "lane-one")`);
  });
});

describe("stripStepIds", () => {
  test("removes ids at every tree depth and touches nothing else", () => {
    const raw = {
      id: ID_BRANCH,
      kind: "branch",
      slug: "route",
      branches: [
        {
          when: { truthy: true },
          steps: [
            {
              id: ID_A,
              kind: "tool",
              slug: "inner",
              args: { title: { $ref: "steps.search.text" } },
            },
          ],
        },
      ],
      else: [{ id: ID_B, kind: "filter", slug: "gate", where: { truthy: true } }],
    };
    const stripped = stripStepIds(raw) as Record<string, unknown>;
    expect(JSON.stringify(stripped)).not.toContain('"id"');
    // Args survive byte-for-byte — the walk only ever REMOVES ids.
    expect(stripped.branches).toMatchObject([
      { steps: [{ args: { title: { $ref: "steps.search.text" } } }] },
    ]);
  });
});

describe("collectPipelineProblems", () => {
  const problems = (
    steps: PipelineStep[],
    trigger: TriggerConfig | null = MANUAL,
  ) => collectPipelineProblems(steps, trigger, inventory);

  test("a clean pipeline reports nothing", () => {
    const steps = [
      toolStep(ID_A, "search"),
      step({
        id: ID_B,
        slug: "summarize",
        kind: "infer",
        preset: "quick",
        prompt: { markdown: "Summarize @steps.search.text at @now." },
      }),
    ];
    expect(problems(steps)).toEqual([]);
  });

  test("duplicate slugs are flagged on EVERY occurrence", () => {
    const steps = [toolStep(ID_A, "search"), toolStep(ID_B, "search")];
    const found = problems(steps).filter((p) =>
      p.message.includes("duplicate step slug"),
    );
    expect(found.map((p) => p.stepId).sort()).toEqual([ID_A, ID_B]);
    expect(found[0]!.severity).toBe("error");
  });

  test("empty slugs and nested for_each are errors", () => {
    const steps = [
      step({
        id: ID_LOOP,
        slug: "outer",
        kind: "for_each",
        items: { $ref: "trigger.items" },
        steps: [
          step({
            id: ID_A,
            slug: "",
            kind: "for_each",
            items: { $ref: "item.rows" },
            steps: [],
          }),
        ],
      }),
    ];
    const messages = problems(steps).map((p) => p.message);
    expect(messages.some((m) => m.includes("needs a slug"))).toBe(true);
    expect(messages.some((m) => m.includes("cannot nest"))).toBe(true);
  });

  test("tool steps: unknown, user-scoped and disabled connections are errors", () => {
    const unknown = problems([
      toolStep(ID_A, "a", { connectionId: "cn_zzzzzzzzzzzzzzzz" }),
    ]);
    expect(unknown[0]!.message).toContain("does not exist");
    expect(unknown[0]!.message).toContain(CONNECTION_ID);

    const userScoped = problems([
      toolStep(ID_A, "a", { connectionId: USER_CONNECTION_ID, tool: "add_note" }),
    ]);
    expect(userScoped[0]!.message).toContain("user-scoped");

    const disabled = problems([
      toolStep(ID_A, "a", { connectionId: DISABLED_CONNECTION_ID }),
    ]);
    expect(disabled[0]!.message).toContain("disabled");
  });

  test("a tool name missing from the cache is a WARNING, never an error", () => {
    const found = problems([toolStep(ID_A, "a", { tool: "close_issue" })]);
    expect(found).toHaveLength(1);
    expect(found[0]!.severity).toBe("warning");
    expect(found[0]!.message).toContain("not in connection");
    expect(found[0]!.message).toContain("create_issue");
  });

  test("infer preset must be a workspace preset", () => {
    const found = problems([
      step({
        id: ID_A,
        slug: "sum",
        kind: "infer",
        preset: "turbo",
        prompt: { markdown: "hi" },
      }),
    ]);
    expect(found[0]!.message).toContain('preset "turbo"');
    expect(found[0]!.message).toContain("quick");
  });

  test("agent steps demand a PUBLISHED agent and legal thread sessions", () => {
    const missing = problems([
      step({ id: ID_A, slug: "a", kind: "agent", agentId: null, instructions: { markdown: "" } }),
    ]);
    expect(missing[0]!.message).toContain("PUBLISHED agent");

    const unpublished = problems([
      step({
        id: ID_A,
        slug: "a",
        kind: "agent",
        agentId: UNPUBLISHED_AGENT_ID,
        instructions: { markdown: "" },
      }),
    ]);
    expect(unpublished[0]!.message).toContain("no published version");

    const threadOnManual = problems([
      step({
        id: ID_A,
        slug: "a",
        kind: "agent",
        agentId: PUBLISHED_AGENT_ID,
        instructions: { markdown: "" },
        session: "thread",
      }),
    ]);
    expect(
      threadOnManual.some((p) => p.message.includes("slack trigger")),
    ).toBe(true);

    const threadWithSchema = problems(
      [
        step({
          id: ID_A,
          slug: "a",
          kind: "agent",
          agentId: PUBLISHED_AGENT_ID,
          instructions: { markdown: "" },
          session: "thread",
          output: { schema: { type: "object", properties: {} } },
        }),
      ],
      { type: "slack", binding: { mentionOnly: true, includeDirectMessages: false } },
    );
    expect(
      threadWithSchema.some((p) => p.message.includes("output schema")),
    ).toBe(true);
  });

  test("agent instructions check @connection refs against the BOUND agent's published context", () => {
    const outside = problems([
      step({
        id: ID_A,
        slug: "a",
        kind: "agent",
        agentId: PUBLISHED_AGENT_ID,
        instructions: { markdown: "Use @github to file issues." },
      }),
    ]);
    expect(outside[0]!.message).toContain("published context");
    const inside = problems([
      step({
        id: ID_A,
        slug: "a",
        kind: "agent",
        agentId: PUBLISHED_AGENT_ID,
        instructions: { markdown: "Use @linear to file issues." },
      }),
    ]);
    expect(inside).toEqual([]);
  });

  test("@steps refs must name a PRECEDING step; @item only inside loops", () => {
    const forward = problems([
      step({
        id: ID_A,
        slug: "sum",
        kind: "infer",
        preset: "quick",
        prompt: { markdown: "Summarize @steps.search.text" },
      }),
      toolStep(ID_B, "search"),
    ]);
    expect(forward.some((p) => p.message.includes("PRECEDING"))).toBe(true);

    const item = problems([
      step({
        id: ID_A,
        slug: "sum",
        kind: "infer",
        preset: "quick",
        prompt: { markdown: "Summarize @item.text" },
      }),
    ]);
    expect(item.some((p) => p.message.includes("for_each body"))).toBe(true);
  });

  test("for_each body slugs are iteration-scoped: a post-loop ref to one is an error (only the loop's aggregate survives)", () => {
    const withLoop = (markdown: string) => [
      toolStep(ID_A, "search"),
      step({
        id: ID_LOOP,
        slug: "loop",
        kind: "for_each",
        items: { $ref: "steps.search.result" },
        steps: [
          toolStep(ID_B, "fetch"),
          step({
            id: "st_dddddddddddddddd",
            slug: "summarize",
            kind: "infer",
            preset: "quick",
            // Same-iteration ref to an EARLIER step of the same body: legal.
            prompt: { markdown: "Summarize @item using @steps.fetch.text" },
          }),
        ],
      }),
      step({
        id: ID_C,
        slug: "report",
        kind: "infer",
        preset: "quick",
        prompt: { markdown },
      }),
    ];

    // The loop's aggregate is addressable after the loop (and the
    // same-iteration body ref above never flags)…
    expect(problems(withLoop("Report on @steps.loop.items"))).toEqual([]);

    // …a discarded body slug is not, and the offered roster excludes body
    // slugs (this is the problem that rejects an addStep carrying such a
    // ref).
    const found = problems(withLoop("Report on @steps.summarize.text"));
    const message = found.find((p) => p.stepId === ID_C)?.message ?? "";
    expect(message).toContain("PRECEDING");
    expect(message).toContain("available here: @steps.search, @steps.loop");
  });

  test("$ref paths are head-checked in args, conditions and items", () => {
    const badHead = problems([
      toolStep(ID_A, "a", { args: { title: { $ref: "outputs.search.text" } } }),
    ]);
    expect(badHead.some((p) => p.message.includes("unknown head"))).toBe(true);

    const badCondition = problems([
      step({
        id: ID_A,
        slug: "gate",
        kind: "filter",
        where: { eq: [{ $ref: "steps.missing.text" }, "x"] },
      }),
    ]);
    expect(badCondition.some((p) => p.message.includes("PRECEDING"))).toBe(true);

    const badItems = problems([
      step({
        id: ID_A,
        slug: "each",
        kind: "for_each",
        items: { $ref: "item" },
        steps: [],
      }),
    ]);
    expect(
      badItems.some((p) => p.message.includes("for_each body")),
    ).toBe(true);
  });

  test("@trigger paths follow the trigger's own rules (form keys, no-data types)", () => {
    const form: TriggerConfig = {
      type: "form",
      fields: [{ key: "subject", label: "Subject", type: "text", required: true }],
    };
    const infer = (markdown: string) =>
      step({ id: ID_A, slug: "sum", kind: "infer", preset: "quick", prompt: { markdown } });

    expect(
      problems([infer("Read @trigger.subject")], form),
    ).toEqual([]);
    expect(
      problems([infer("Read @trigger.body")], form).some((p) =>
        p.message.includes("form field key"),
      ),
    ).toBe(true);
    expect(
      problems([infer("Read @trigger.subject")], MANUAL).some((p) =>
        p.message.includes("carries no dispatch data"),
      ),
    ).toBe(true);
    // Unparseable draft trigger: lenient — trigger refs pass through.
    expect(problems([infer("Read @trigger.subject")], null)).toEqual([]);
  });

  test("$ref state needs a key and now takes no path", () => {
    const found = problems([
      toolStep(ID_A, "a", {
        args: { cursor: { $ref: "state" }, at: { $ref: "now.date" } },
      }),
    ]);
    const messages = found.map((p) => p.message);
    expect(messages.some((m) => m.includes("needs a state key"))).toBe(true);
    expect(messages.some((m) => m.includes('"now" takes no path'))).toBe(true);
  });
});
