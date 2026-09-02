import { describe, expect, test } from "bun:test";

import {
  MAX_FOR_EACH_ITEMS,
  PIPELINE_STEP_KINDS,
  RUN_STEP_KINDS,
  STEP_ID_PATTERN,
  STEP_SLUG_PATTERN,
  findStep,
  newStepId,
  pipelineConditionSchema,
  pipelineStepSchema,
  stepsBefore,
  templateValueSchema,
  toolStepSchema,
  walkSteps,
  type PipelineStep,
  type PipelineStepInput,
} from "./pipeline-config";

const UUID_A = "6b4d8f6e-3a4e-4f6a-9a0e-2f6a1c9d8e7b";

const id = (n: number): string => `st_${String(n).padStart(16, "0")}`;

// ── Identity ────────────────────────────────────────────────────────────────

describe("step identity", () => {
  test("newStepId mints st_ + 16 lowercase-alnum chars", () => {
    const minted = newStepId();
    expect(minted).toMatch(STEP_ID_PATTERN);
    expect(newStepId()).not.toBe(minted);
  });

  test("slug charset stays a subset of the @reference segment charset", () => {
    for (const good of ["search", "create-issue", "Sum_2"]) {
      expect(STEP_SLUG_PATTERN.test(good)).toBe(true);
    }
    for (const bad of ["1search", "has space", "dot.slug", "@x"]) {
      expect(STEP_SLUG_PATTERN.test(bad)).toBe(false);
    }
  });

  test("steps reject unminted ids; empty slugs stay draft-legal", () => {
    expect(
      pipelineStepSchema.safeParse({ id: "search", slug: "search", kind: "state" })
        .success,
    ).toBe(false);
    const parsed = pipelineStepSchema.parse({ id: id(1), slug: "", kind: "state" });
    expect(parsed.slug).toBe("");
  });

  test("kind lists: config union has 7 kinds, the ledger reserves script", () => {
    expect(PIPELINE_STEP_KINDS).toHaveLength(7);
    expect(RUN_STEP_KINDS).toEqual([...PIPELINE_STEP_KINDS, "script"]);
    // `script` is reserved, NOT parseable as a config step.
    expect(
      pipelineStepSchema.safeParse({ id: id(1), slug: "s", kind: "script" })
        .success,
    ).toBe(false);
  });
});

// ── Template values ─────────────────────────────────────────────────────────

describe("templateValueSchema", () => {
  test("accepts scalars, tags, and nested literals", () => {
    for (const value of [
      "literal",
      42,
      true,
      null,
      { $ref: "steps.search.result" },
      { $tpl: "since @state.cursor" },
      { nested: { list: [1, { $ref: "item.id" }] } },
    ]) {
      expect(templateValueSchema.safeParse(value).success).toBe(true);
    }
  });

  test("a $ref tag must be a lone string key", () => {
    // {$ref: non-string} is not a tag — but IS a legal literal object shape.
    expect(templateValueSchema.safeParse({ $ref: 42 }).success).toBe(true);
    // extra keys beside $ref stay a literal object too (walk treats them so).
    expect(
      templateValueSchema.safeParse({ $ref: "a.b", extra: 1 }).success,
    ).toBe(true);
    expect(templateValueSchema.safeParse(undefined).success).toBe(false);
  });
});

// ── Conditions ──────────────────────────────────────────────────────────────

describe("pipelineConditionSchema", () => {
  test("parses combinators and comparators with literal + $ref operands", () => {
    const condition = {
      and: [
        { eq: [{ $ref: "trigger.kind" }, "mention"] },
        { or: [{ exists: { $ref: "state.cursor" } }, { truthy: true }] },
        { in: [{ $ref: "item.status" }, ["open", "triage"]] },
      ],
    };
    expect(pipelineConditionSchema.safeParse(condition).success).toBe(true);
  });

  test("rejects unknown operators and object literals as operands", () => {
    expect(pipelineConditionSchema.safeParse({ matches: ["a", "b"] }).success).toBe(
      false,
    );
    expect(
      pipelineConditionSchema.safeParse({ eq: [{ deep: { object: 1 } }, "x"] })
        .success,
    ).toBe(false);
  });
});

// ── Step union ──────────────────────────────────────────────────────────────

describe("pipelineStepSchema", () => {
  test("tool step applies defaults and stays draft-lenient", () => {
    const parsed = toolStepSchema.parse({ id: id(1), slug: "search", kind: "tool" });
    expect(parsed.connectionId).toBe("");
    expect(parsed.tool).toBe("");
    expect(parsed.args).toEqual({});
    expect(parsed.sideEffect).toBe("at_least_once");
  });

  test("tool step caps timeout and retry attempts", () => {
    expect(
      toolStepSchema.safeParse({
        id: id(1),
        slug: "s",
        kind: "tool",
        timeoutMs: 600_000,
      }).success,
    ).toBe(false);
    expect(
      toolStepSchema.safeParse({
        id: id(1),
        slug: "s",
        kind: "tool",
        retry: { maxAttempts: 9 },
      }).success,
    ).toBe(false);
  });

  test("infer step defaults preset to quick and takes an output schema", () => {
    const parsed = pipelineStepSchema.parse({
      id: id(1),
      slug: "summarize",
      kind: "infer",
      prompt: { markdown: "Summarize @item.text" },
      output: {
        schema: {
          type: "object",
          properties: { title: { type: "string" } },
          required: ["title"],
        },
      },
    });
    if (parsed.kind !== "infer") throw new Error("expected infer");
    expect(parsed.preset).toBe("quick");
    expect(parsed.output?.schema.type).toBe("object");
  });

  test("agent step: null agentId parses (draft), session defaults fresh", () => {
    const parsed = pipelineStepSchema.parse({
      id: id(1),
      slug: "triage",
      kind: "agent",
      instructions: { markdown: "" },
    });
    if (parsed.kind !== "agent") throw new Error("expected agent");
    expect(parsed.agentId).toBeNull();
    expect(parsed.session).toBe("fresh");
    expect(
      pipelineStepSchema.safeParse({
        id: id(1),
        slug: "triage",
        kind: "agent",
        agentId: "not-a-uuid",
        instructions: { markdown: "" },
      }).success,
    ).toBe(false);
  });

  test("for_each requires a $ref items source and caps maxItems", () => {
    const parsed = pipelineStepSchema.parse({
      id: id(1),
      slug: "loop",
      kind: "for_each",
      items: { $ref: "steps.search.result.messages" },
      steps: [{ id: id(2), slug: "mark", kind: "state" }],
    });
    if (parsed.kind !== "for_each") throw new Error("expected for_each");
    expect(parsed.maxItems).toBe(MAX_FOR_EACH_ITEMS);
    expect(parsed.onItemError).toBe("halt");
    expect(parsed.steps[0]?.kind).toBe("state");
    expect(
      pipelineStepSchema.safeParse({
        id: id(1),
        slug: "loop",
        kind: "for_each",
        items: "steps.search.result", // must be a {$ref} tag, not a bare string
        steps: [],
      }).success,
    ).toBe(false);
  });

  test("branch nests lanes + else; state keys share the slug charset", () => {
    const parsed = pipelineStepSchema.parse({
      id: id(1),
      slug: "route",
      kind: "branch",
      branches: [
        {
          when: { truthy: { $ref: "trigger.urgent" } },
          steps: [{ id: id(2), slug: "mark", kind: "state", set: { cursor: { $ref: "now" } } }],
        },
      ],
      else: [{ id: id(3), slug: "skip", kind: "filter", where: { truthy: false } }],
    });
    if (parsed.kind !== "branch") throw new Error("expected branch");
    expect(parsed.branches[0]?.steps[0]?.kind).toBe("state");
    expect(parsed.else?.[0]?.kind).toBe("filter");
    expect(
      pipelineStepSchema.safeParse({
        id: id(1),
        slug: "bad",
        kind: "state",
        set: { "dot.key": 1 },
      }).success,
    ).toBe(false);
  });
});

// ── Tree helpers ────────────────────────────────────────────────────────────

/** search → loop(filter → infer) → route(then: create / else: log) → done */
function tree(): PipelineStep[] {
  const input: PipelineStepInput[] = [
    { id: id(1), slug: "search", kind: "tool" },
    {
      id: id(2),
      slug: "loop",
      kind: "for_each",
      items: { $ref: "steps.search.result.messages" },
      steps: [
        { id: id(3), slug: "fresh", kind: "filter", where: { truthy: true } },
        { id: id(4), slug: "summarize", kind: "infer", prompt: { markdown: "" } },
      ],
    },
    {
      id: id(5),
      slug: "route",
      kind: "branch",
      branches: [
        {
          when: { truthy: true },
          steps: [
            {
              id: id(6),
              slug: "create",
              kind: "agent",
              agentId: UUID_A,
              instructions: { markdown: "" },
            },
          ],
        },
      ],
      else: [{ id: id(7), slug: "log", kind: "state" }],
    },
    { id: id(8), slug: "done", kind: "state" },
  ];
  return input.map((step) => pipelineStepSchema.parse(step));
}

describe("walkSteps", () => {
  test("pre-order walk with ancestors, slots, and config paths", () => {
    const entries = walkSteps(tree());
    expect(entries.map((e) => e.step.slug)).toEqual([
      "search",
      "loop",
      "fresh",
      "summarize",
      "route",
      "create",
      "log",
      "done",
    ]);
    const summarize = entries[3];
    expect(summarize?.ancestors.map((a) => a.slug)).toEqual(["loop"]);
    expect(summarize?.slot).toBe("body");
    expect(summarize?.configPath).toEqual([1, "steps", 1]);
    const create = entries[5];
    expect(create?.slot).toBe("then");
    expect(create?.branchIndex).toBe(0);
    expect(create?.configPath).toEqual([2, "branches", 0, "steps", 0]);
    const log = entries[6];
    expect(log?.slot).toBe("else");
    expect(log?.configPath).toEqual([2, "else", 0]);
  });
});

describe("findStep", () => {
  test("finds nested steps by id; null when absent", () => {
    const steps = tree();
    expect(findStep(steps, id(4))?.slug).toBe("summarize");
    expect(findStep(steps, id(6))?.slug).toBe("create");
    expect(findStep(steps, "st_ffffffffffffffff")).toBeNull();
  });
});

describe("stepsBefore", () => {
  test("document-order predecessors, minus the step's own ancestors", () => {
    const steps = tree();
    // From inside the loop: search precedes, and earlier steps of the SAME
    // body (same iteration) are addressable; the loop container itself is not.
    expect(stepsBefore(steps, id(4)).map((s) => s.slug)).toEqual([
      "search",
      "fresh",
    ]);
    expect(stepsBefore(steps, id(1))).toEqual([]);
    expect(stepsBefore(steps, "st_ffffffffffffffff")).toEqual([]);
  });

  test("for_each body slugs are iteration-scoped: invisible after the loop", () => {
    const steps = tree();
    // After the loop closes the runner keeps only the loop's AGGREGATE —
    // body outputs ("fresh", "summarize") died with their iterations, so
    // they are not addressable from any later position.
    expect(stepsBefore(steps, id(8)).map((s) => s.slug)).toEqual([
      "search",
      "loop",
      "route",
      "create",
      "log",
    ]);
    // Same rule from inside a later container (a branch lane after the loop).
    expect(stepsBefore(steps, id(6)).map((s) => s.slug)).toEqual([
      "search",
      "loop",
    ]);
  });
});
