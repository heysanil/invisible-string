/**
 * @ autocomplete token source + unresolved-reference detection. Every emitted
 * option label must round-trip through the shared parseReferences grammar to
 * exactly one reference of the intended kind (the editor inserts these
 * verbatim, the validators parse them at publish — they must agree). Also the
 * per-position source derivation: prior steps only, `@item` only in loops.
 */
import { expect, test } from "bun:test";
import {
  newStepId,
  parseReferences,
  type PipelineStep,
  type TriggerConfig,
} from "@invisible-string/shared";

import {
  isInsideForEach,
  referenceOptions,
  referenceProblem,
  referenceSourcesForStep,
  scopeRefProblem,
  slugifyName,
  stateKeysOf,
  stepOutputHints,
  unresolvedReferences,
  type ReferenceSources,
} from "../lib/builder/references";

const formTrigger: TriggerConfig = {
  type: "form",
  fields: [
    { key: "email", label: "Email", type: "text", required: true },
    { key: "topic", label: "Topic", type: "text", required: false },
  ],
};

const sources: ReferenceSources = {
  trigger: formTrigger,
  steps: [
    { slug: "search", name: "Search Slack", kind: "tool", outputHints: ["result", "text"] },
    { slug: "summarize", name: null, kind: "infer", outputHints: ["text"] },
  ],
  stateKeys: ["cursor"],
  item: true,
  connections: [
    { name: "Linear", description: "Issue tracker" },
    { name: "Google Drive" },
  ],
  skills: [{ name: "Release Notes", description: "Draft notes" }],
};

test("referenceOptions emits trigger, steps, state, item, now, connections, skills", () => {
  const options = referenceOptions(sources);
  const labels = options.map((o) => o.label);
  expect(labels).toEqual([
    "@trigger.email",
    "@trigger.topic",
    "@steps.search",
    "@steps.search.result",
    "@steps.search.text",
    "@steps.summarize",
    "@steps.summarize.text",
    "@state.cursor",
    "@item",
    "@now",
    "@linear",
    "@google-drive",
    "@skill.release-notes",
  ]);
});

test("every emitted option parses back to one reference of its kind", () => {
  for (const option of referenceOptions(sources)) {
    const refs = parseReferences(option.label);
    expect(refs.length).toBe(1);
    expect(refs[0]!.kind).toBe(option.kind);
    // The grammar consumed the whole label (a truncated span would insert a
    // chip that serializes differently than it reads).
    expect(refs[0]!.raw).toBe(option.label);
  }
});

test("@item is only offered inside a for_each body", () => {
  const outside = referenceOptions({ ...sources, item: false });
  expect(outside.some((o) => o.kind === "item")).toBe(false);
});

test("connection slug matches the compiler's slugify (kebab, trimmed)", () => {
  expect(slugifyName("Google Drive")).toBe("google-drive");
  expect(slugifyName("  Weird__Name!! ")).toBe("weird-name");
  expect(slugifyName("linear")).toBe("linear");
});

test("manual triggers contribute no @trigger options (no dispatch data)", () => {
  const manual = referenceOptions({ ...sources, trigger: { type: "manual" } });
  expect(manual.some((o) => o.kind === "trigger")).toBe(false);
});

test("slack triggers offer the adapter's FIXED data keys", () => {
  const slack = referenceOptions({
    ...sources,
    trigger: {
      type: "slack",
      binding: { mentionOnly: true, includeDirectMessages: false },
    },
  });
  const labels = slack.filter((o) => o.kind === "trigger").map((o) => o.label);
  expect(labels).toEqual([
    "@trigger.text",
    "@trigger.user",
    "@trigger.channel",
    "@trigger.ts",
    "@trigger.thread_ts",
    "@trigger.team",
    "@trigger.eventType",
    "@trigger.channelType",
  ]);
});

test("resources whose names slugify to empty are omitted", () => {
  const options = referenceOptions({
    ...sources,
    connections: [{ name: "!!!" }, { name: "OK" }],
  });
  expect(options.filter((o) => o.kind === "connection").map((o) => o.label)).toEqual(
    ["@ok"],
  );
});

// ── referenceProblem ────────────────────────────────────────────────────────

test("resolved refs of every kind return null", () => {
  for (const raw of [
    "@trigger.email",
    "@steps.search",
    "@steps.search.result.messages",
    "@state.cursor",
    "@item",
    "@item.id",
    "@now",
    "@linear",
    "@skill.release-notes",
  ]) {
    const ref = parseReferences(raw)[0]!;
    expect(referenceProblem(ref, sources)).toBeNull();
  }
});

test("unknown step / state / out-of-loop item / bare refs are flagged", () => {
  const unknownStep = parseReferences("@steps.missing.text")[0]!;
  expect(referenceProblem(unknownStep, sources)).toContain('slugged "missing"');

  const bareSteps = parseReferences("@steps")[0]!;
  expect(referenceProblem(bareSteps, sources)).toContain("Bare @steps");

  const unknownState = parseReferences("@state.nope")[0]!;
  expect(referenceProblem(unknownState, sources)).toContain('"nope"');

  const bareState = parseReferences("@state")[0]!;
  expect(referenceProblem(bareState, sources)).toContain("Bare @state");

  const item = parseReferences("@item")[0]!;
  expect(referenceProblem(item, { ...sources, item: false })).toContain(
    "for_each",
  );

  const unknownField = parseReferences("@trigger.nope")[0]!;
  expect(referenceProblem(unknownField, sources)).toContain('keyed "nope"');

  const unknownConn = parseReferences("@github")[0]!;
  expect(referenceProblem(unknownConn, sources)).toContain("No attached connection");

  const unknownSkill = parseReferences("@skill.missing")[0]!;
  expect(referenceProblem(unknownSkill, sources)).toContain("No attached skill");
});

test("@state.<key>.<deeper> validates the head key only", () => {
  const deep = parseReferences("@state.cursor.lastTs")[0]!;
  expect(referenceProblem(deep, sources)).toBeNull();
});

test("unresolvedReferences returns only the failing refs, in order", () => {
  const markdown =
    "Use @trigger.email then @steps.search.text and @steps.missing plus @github.";
  const problems = unresolvedReferences(markdown, sources);
  expect(problems.map((p) => p.ref.raw)).toEqual(["@steps.missing", "@github"]);
});

// ── scopeRefProblem ($ref paths) ────────────────────────────────────────────

test("scopeRefProblem accepts the five scope roots and rejects the rest", () => {
  expect(scopeRefProblem("trigger.email", sources)).toBeNull();
  expect(scopeRefProblem("steps.search.result.messages", sources)).toBeNull();
  expect(scopeRefProblem("state.cursor", sources)).toBeNull();
  expect(scopeRefProblem("item.id", sources)).toBeNull();
  expect(scopeRefProblem("now", sources)).toBeNull();

  expect(scopeRefProblem("", sources)).toContain("Empty $ref");
  expect(scopeRefProblem("steps.missing", sources)).toContain('"missing"');
  expect(scopeRefProblem("state.nope", sources)).toContain('"nope"');
  expect(scopeRefProblem("item", { ...sources, item: false })).toContain(
    "for_each",
  );
  // Connections are structurally unreachable from a $ref scope path.
  expect(scopeRefProblem("linear.issues", sources)).toContain("not a scope root");
  expect(scopeRefProblem("secrets.token", sources)).toContain("not a scope root");
});

// ── per-position source derivation ──────────────────────────────────────────

function step(partial: Partial<PipelineStep> & { slug: string }): PipelineStep {
  return {
    id: newStepId(),
    kind: "tool",
    connectionId: "cn_aaaaaaaaaaaaaa",
    tool: "t",
    args: {},
    sideEffect: "at_least_once",
    ...partial,
  } as PipelineStep;
}

test("referenceSourcesForStep offers prior steps only (no forward refs)", () => {
  const a = step({ slug: "a" });
  const inner = step({ slug: "inner" });
  const loop: PipelineStep = {
    id: newStepId(),
    slug: "loop",
    kind: "for_each",
    items: { $ref: "steps.a.result" },
    steps: [inner],
    maxItems: 100,
    onItemError: "halt",
  };
  const later = step({ slug: "later" });
  const steps = [a, loop, later];
  const base = { trigger: formTrigger, connections: [], skills: [] };

  // From the first step: nothing before it.
  expect(referenceSourcesForStep(steps, a.id, base).steps).toEqual([]);

  // Inside the loop: `a` is addressable, the enclosing loop is not (it has
  // no output while you are inside it), `later` is a forward ref.
  const insideLoop = referenceSourcesForStep(steps, inner.id, base);
  expect(insideLoop.steps.map((s) => s.slug)).toEqual(["a"]);
  expect(insideLoop.item).toBe(true);

  // After the loop: `a` and the loop's aggregate only — the runner discards
  // body outputs when the loop finishes, so `inner` must NOT be offered —
  // and no @item.
  const afterLoop = referenceSourcesForStep(steps, later.id, base);
  expect(afterLoop.steps.map((s) => s.slug)).toEqual(["a", "loop"]);
  expect(afterLoop.item).toBe(false);
});

test("for_each body slugs are iteration-scoped: offered to later SAME-body steps, never after the loop", () => {
  const fetch = step({ slug: "fetch" });
  const summarize = step({ slug: "summarize" });
  const loop: PipelineStep = {
    id: newStepId(),
    slug: "loop",
    kind: "for_each",
    items: { $ref: "trigger.email" },
    steps: [fetch, summarize],
    maxItems: 100,
    onItemError: "halt",
  };
  const later = step({ slug: "later" });
  const steps = [loop, later];
  const base = { trigger: formTrigger, connections: [], skills: [] };

  // Same iteration: an earlier body step's output is live in the item scope.
  const sameBody = referenceSourcesForStep(steps, summarize.id, base);
  expect(sameBody.steps.map((s) => s.slug)).toEqual(["fetch"]);

  // After the loop only the aggregate survives — a body ref here would
  // always resolve missing at run time, so autocomplete must not offer it.
  const afterLoop = referenceSourcesForStep(steps, later.id, base);
  expect(afterLoop.steps.map((s) => s.slug)).toEqual(["loop"]);
});

test("slugless steps are omitted from sources (no handle to offer)", () => {
  const anonymous = step({ slug: "" });
  const target = step({ slug: "target" });
  const derived = referenceSourcesForStep([anonymous, target], target.id, {
    trigger: formTrigger,
    connections: [],
    skills: [],
  });
  expect(derived.steps).toEqual([]);
});

test("stateKeysOf collects keys from every state step, deduped in order", () => {
  const s1: PipelineStep = {
    id: newStepId(),
    slug: "remember",
    kind: "state",
    set: { cursor: { $ref: "steps.search.result.latestTs" }, count: 1 },
  };
  const s2: PipelineStep = {
    id: newStepId(),
    slug: "remember-2",
    kind: "state",
    set: { cursor: "again" },
  };
  expect(stateKeysOf([s1, s2])).toEqual(["cursor", "count"]);
});

test("isInsideForEach sees through branch nesting", () => {
  const deep = step({ slug: "deep" });
  const fork: PipelineStep = {
    id: newStepId(),
    slug: "fork",
    kind: "branch",
    branches: [{ when: { truthy: { $ref: "item" } }, steps: [deep] }],
  };
  const loop: PipelineStep = {
    id: newStepId(),
    slug: "loop",
    kind: "for_each",
    items: { $ref: "steps.a.result" },
    steps: [fork],
    maxItems: 100,
    onItemError: "halt",
  };
  expect(isInsideForEach([loop], deep.id)).toBe(true);
  expect(isInsideForEach([loop], loop.id)).toBe(false);
});

test("stepOutputHints reflect each kind's persisted envelope", () => {
  expect(stepOutputHints(step({ slug: "t" }))).toEqual(["result", "text"]);
  const infer: PipelineStep = {
    id: newStepId(),
    slug: "i",
    kind: "infer",
    preset: "quick",
    prompt: { markdown: "x" },
    output: {
      schema: {
        type: "object",
        properties: { title: { type: "string" }, done: { type: "boolean" } },
      },
    },
  };
  expect(stepOutputHints(infer)).toEqual(["result", "result.title", "result.done"]);
  const plain: PipelineStep = { ...infer, output: undefined };
  expect(stepOutputHints(plain)).toEqual(["text"]);
});
