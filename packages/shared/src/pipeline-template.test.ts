import { describe, expect, test } from "bun:test";

import type { PipelineCondition } from "./pipeline-config";
import {
  MAX_CONDITION_DEPTH,
  evaluateCondition,
  renderMarkdownTemplate,
  renderTemplateRecord,
  renderTemplateValue,
  resolveScopePath,
  type PipelineScope,
} from "./pipeline-template";

function scope(overrides: Partial<PipelineScope> = {}): PipelineScope {
  return {
    trigger: { email: "ada@example.com", urgent: true, items: ["a", "b"] },
    steps: {
      search: {
        result: { messages: [{ text: "hi", user: "U1" }, { text: "yo" }] },
        isError: false,
      },
    },
    state: { cursor: "1723380000.000000", meta: { runs: 3 } },
    now: "2026-08-31T12:00:00.000Z",
    ...overrides,
  };
}

// ── resolveScopePath ────────────────────────────────────────────────────────

describe("resolveScopePath", () => {
  test("resolves every head, including array indices", () => {
    const s = scope({ item: { text: "hello", tags: ["x"] } });
    expect(resolveScopePath(s, "trigger.email")).toBe("ada@example.com");
    expect(resolveScopePath(s, "steps.search.result.messages.1.text")).toBe("yo");
    expect(resolveScopePath(s, "state.meta.runs")).toBe(3);
    expect(resolveScopePath(s, "item.text")).toBe("hello");
    expect(resolveScopePath(s, "item")).toEqual({ text: "hello", tags: ["x"] });
    expect(resolveScopePath(s, "now")).toBe("2026-08-31T12:00:00.000Z");
  });

  test("bare heads resolve to the whole value", () => {
    expect(resolveScopePath(scope(), "steps.search")).toEqual(
      scope().steps["search"],
    );
    expect(resolveScopePath(scope(), "trigger")).toEqual(scope().trigger);
  });

  test("missing paths, unknown heads, and paths past now are undefined", () => {
    const s = scope();
    expect(resolveScopePath(s, "")).toBeUndefined();
    expect(resolveScopePath(s, "steps.nope.out")).toBeUndefined();
    expect(resolveScopePath(s, "trigger.items.x")).toBeUndefined(); // non-numeric into array
    expect(resolveScopePath(s, "now.date")).toBeUndefined();
    expect(resolveScopePath(s, "secrets.key")).toBeUndefined();
    expect(resolveScopePath(s, "item")).toBeUndefined(); // absent outside loops
  });
});

// ── Markdown surface ────────────────────────────────────────────────────────

describe("renderMarkdownTemplate", () => {
  test("rewrites every scope head; strings verbatim, non-strings JSON", () => {
    const rendered = renderMarkdownTemplate(
      "For @trigger.email since @state.cursor: first is @steps.search.result.messages.0 at @now.",
      scope(),
    );
    expect(rendered).toBe(
      'For ada@example.com since 1723380000.000000: first is {"text":"hi","user":"U1"} at 2026-08-31T12:00:00.000Z.',
    );
  });

  test("missing values read as (not provided); item resolves inside loops", () => {
    expect(renderMarkdownTemplate("Got @steps.missing.out", scope())).toBe(
      "Got (not provided)",
    );
    expect(
      renderMarkdownTemplate("Say @item.text", scope({ item: { text: "hey" } })),
    ).toBe("Say hey");
    expect(renderMarkdownTemplate("Say @item.text", scope())).toBe(
      "Say (not provided)",
    );
  });

  test("connection and skill refs stay prose literals", () => {
    expect(
      renderMarkdownTemplate("File in @linear per @skill.tone", scope()),
    ).toBe('File in the "linear" connection per the "tone" skill');
  });

  test("prose emails and @@ never rewrite", () => {
    const doc = "Mail ada@example.com about @@nothing";
    expect(renderMarkdownTemplate(doc, scope())).toBe(doc);
  });
});

// ── Structured values ───────────────────────────────────────────────────────

describe("renderTemplateValue", () => {
  test("$ref is whole-value and type-preserving", () => {
    expect(
      renderTemplateValue({ $ref: "steps.search.result.messages" }, scope()),
    ).toEqual([{ text: "hi", user: "U1" }, { text: "yo" }]);
    expect(renderTemplateValue({ $ref: "trigger.urgent" }, scope())).toBe(true);
    expect(renderTemplateValue({ $ref: "state.meta.runs" }, scope())).toBe(3);
  });

  test("$tpl interpolates with markdown semantics", () => {
    expect(
      renderTemplateValue({ $tpl: "after @state.cursor" }, scope()),
    ).toBe("after 1723380000.000000");
  });

  test("bare strings stay literal — interpolation is opt-in", () => {
    expect(renderTemplateValue("uses @state.cursor", scope())).toBe(
      "uses @state.cursor",
    );
  });

  test("missing $refs drop object keys and null array slots (JSON.stringify parity)", () => {
    const rendered = renderTemplateRecord(
      {
        channel: "C123",
        oldest: { $ref: "state.unset" },
        list: [{ $ref: "state.unset" }, 1],
      },
      scope(),
    );
    expect(rendered).toEqual({ channel: "C123", list: [null, 1] });
    expect("oldest" in rendered).toBe(false);
  });

  test("recursive literals render inside; tag objects with extra keys stay literal", () => {
    expect(
      renderTemplateValue(
        {
          title: { $tpl: "mention by @item.user" },
          labels: ["team-exec", { $ref: "state.cursor" }],
          meta: { $ref: "not.a.tag", extra: 1 },
        },
        scope({ item: { user: "U1" } }),
      ),
    ).toEqual({
      title: "mention by U1",
      labels: ["team-exec", "1723380000.000000"],
      meta: { $ref: "not.a.tag", extra: 1 },
    });
  });
});

// ── Conditions ──────────────────────────────────────────────────────────────

describe("evaluateCondition", () => {
  const evaluate = (condition: PipelineCondition, s = scope()): boolean =>
    evaluateCondition(condition, s);

  test("comparators over literals and refs", () => {
    expect(evaluate({ eq: [{ $ref: "trigger.email" }, "ada@example.com"] })).toBe(true);
    expect(evaluate({ ne: [{ $ref: "trigger.email" }, "x"] })).toBe(true);
    expect(evaluate({ gt: [{ $ref: "state.meta.runs" }, 2] })).toBe(true);
    expect(evaluate({ gte: [3, { $ref: "state.meta.runs" }] })).toBe(true);
    expect(evaluate({ lt: [{ $ref: "state.meta.runs" }, 2] })).toBe(false);
    expect(evaluate({ lte: ["a", "b"] })).toBe(true);
    // mixed types never coerce
    expect(evaluate({ gt: ["3", 2] })).toBe(false);
  });

  test("eq is structural", () => {
    expect(
      evaluate({
        eq: [{ $ref: "steps.search.result.messages.1" }, { $ref: "steps.search.result.messages.1" }],
      }),
    ).toBe(true);
  });

  test("contains, in, startsWith, endsWith", () => {
    expect(evaluate({ contains: [{ $ref: "trigger.email" }, "@example"] })).toBe(true);
    expect(evaluate({ contains: [{ $ref: "trigger.items" }, "b"] })).toBe(true);
    expect(evaluate({ in: ["b", { $ref: "trigger.items" }] })).toBe(true);
    expect(evaluate({ in: ["z", { $ref: "trigger.items" }] })).toBe(false);
    expect(evaluate({ in: ["b", "abc"] })).toBe(false); // strings are not lists
    expect(evaluate({ startsWith: [{ $ref: "trigger.email" }, "ada"] })).toBe(true);
    expect(evaluate({ endsWith: [{ $ref: "trigger.email" }, ".com"] })).toBe(true);
    expect(evaluate({ startsWith: [42, "4"] })).toBe(false);
  });

  test("exists treats missing refs as null; truthy and empty behave as documented", () => {
    expect(evaluate({ exists: { $ref: "state.cursor" } })).toBe(true);
    expect(evaluate({ exists: { $ref: "state.unset" } })).toBe(false);
    expect(evaluate({ eq: [{ $ref: "state.unset" }, null] })).toBe(true);
    expect(evaluate({ truthy: { $ref: "trigger.urgent" } })).toBe(true);
    expect(evaluate({ truthy: "" })).toBe(false);
    expect(evaluate({ empty: [] })).toBe(true);
    expect(evaluate({ empty: { $ref: "state.unset" } })).toBe(true);
    expect(evaluate({ empty: { $ref: "trigger.items" } })).toBe(false);
  });

  test("combinators: and [] is true, or [] is false, not negates", () => {
    expect(evaluate({ and: [] })).toBe(true);
    expect(evaluate({ or: [] })).toBe(false);
    expect(
      evaluate({
        and: [{ truthy: true }, { not: { truthy: false } }],
      }),
    ).toBe(true);
  });

  test("throws past the depth cap; passes at the cap", () => {
    let atCap: PipelineCondition = { truthy: true };
    for (let i = 1; i < MAX_CONDITION_DEPTH; i++) atCap = { not: atCap };
    // MAX-1 nots around `truthy: true` — root sits exactly at the cap.
    expect(evaluateCondition(atCap, scope())).toBe(
      (MAX_CONDITION_DEPTH - 1) % 2 === 0,
    );
    expect(() => evaluateCondition({ not: atCap }, scope())).toThrow(
      /depth cap/,
    );
  });
});
