import { describe, expect, test } from "bun:test";

import {
  formatTriggerValue,
  renderTaskMessage,
  resolveTriggerPath,
} from "./render";

// ── resolveTriggerPath ──────────────────────────────────────────────────────

describe("resolveTriggerPath", () => {
  test("resolves top-level and nested dot paths", () => {
    const data = { email: "a@b.co", customer: { name: "Ada", plan: { tier: 2 } } };
    expect(resolveTriggerPath(data, "email")).toBe("a@b.co");
    expect(resolveTriggerPath(data, "customer.name")).toBe("Ada");
    expect(resolveTriggerPath(data, "customer.plan.tier")).toBe(2);
  });

  test("missing paths and non-record intermediates resolve to undefined", () => {
    const data = { customer: { name: "Ada" }, tags: ["a", "b"], n: 5 };
    expect(resolveTriggerPath(data, "nope")).toBeUndefined();
    expect(resolveTriggerPath(data, "customer.email")).toBeUndefined();
    expect(resolveTriggerPath(data, "n.deep")).toBeUndefined();
    // Arrays are not records — numeric segments do not index into them.
    expect(resolveTriggerPath(data, "tags.0")).toBeUndefined();
  });
});

// ── formatTriggerValue ──────────────────────────────────────────────────────

describe("formatTriggerValue", () => {
  test("strings pass through verbatim; missing reads as prose", () => {
    expect(formatTriggerValue("hello")).toBe("hello");
    expect(formatTriggerValue(undefined)).toBe("(not provided)");
  });

  test("non-strings serialize as JSON", () => {
    expect(formatTriggerValue(42)).toBe("42");
    expect(formatTriggerValue(true)).toBe("true");
    expect(formatTriggerValue(null)).toBe("null");
    expect(formatTriggerValue({ a: 1 })).toBe('{"a":1}');
    expect(formatTriggerValue(["x"])).toBe('["x"]');
  });
});

// ── renderTaskMessage ───────────────────────────────────────────────────────

describe("renderTaskMessage", () => {
  test("exact output shape: task block + trigger context", () => {
    const rendered = renderTaskMessage(
      "Reply to @trigger.email about their issue.",
      { message: "New support ticket", data: { email: "ada@example.com" } },
    );
    expect(rendered).toBe(
      [
        "<workflow-task>",
        "Reply to ada@example.com about their issue.",
        "</workflow-task>",
        "",
        "<trigger-context>",
        "New support ticket",
        "trigger.email: ada@example.com",
        "</trigger-context>",
      ].join("\n"),
    );
  });

  test("@trigger refs inline resolved values; missing paths read as (not provided)", () => {
    const rendered = renderTaskMessage(
      "Severity @trigger.severity, owner @trigger.owner.",
      { message: "", data: { severity: "high" } },
    );
    expect(rendered).toContain("Severity high, owner (not provided).");
    expect(rendered).toContain("trigger.severity: high");
    expect(rendered).toContain("trigger.owner: (not provided)");
  });

  test("non-string trigger values are JSON in both the body and the context", () => {
    const rendered = renderTaskMessage("Handle @trigger.payload now", {
      message: "",
      data: { payload: { id: 7, tags: ["a"] } },
    });
    expect(rendered).toContain('Handle {"id":7,"tags":["a"]} now');
    expect(rendered).toContain('trigger.payload: {"id":7,"tags":["a"]}');
  });

  test("@connection and @skill refs become prose literals (no data lines)", () => {
    const rendered = renderTaskMessage(
      "File it in @linear following @skill.brand-voice.",
      { message: "New report", data: {} },
    );
    expect(rendered).toContain(
      'File it in the "linear" connection following the "brand-voice" skill.',
    );
    expect(rendered).not.toContain("trigger.");
  });

  test("context lines land after the trigger data lines", () => {
    const rendered = renderTaskMessage("Use @trigger.id.", {
      message: "fire",
      data: { id: "run-9" },
      context: ["Requested by U123", "Channel C9"],
    });
    expect(rendered).toBe(
      [
        "<workflow-task>",
        "Use run-9.",
        "</workflow-task>",
        "",
        "<trigger-context>",
        "fire",
        "trigger.id: run-9",
        "Requested by U123",
        "Channel C9",
        "</trigger-context>",
      ].join("\n"),
    );
  });

  test("duplicate trigger paths list once, in document order", () => {
    const rendered = renderTaskMessage(
      "Ping @trigger.b then @trigger.a then @trigger.b again",
      { message: "", data: { a: "1", b: "2" } },
    );
    const lines = rendered.split("\n");
    const dataLines = lines.filter((line) => line.startsWith("trigger."));
    expect(dataLines).toEqual(["trigger.b: 2", "trigger.a: 1"]);
  });

  test("empty message contributes no line", () => {
    const rendered = renderTaskMessage("Do @trigger.thing", {
      message: "",
      data: { thing: "x" },
    });
    expect(rendered).toContain("<trigger-context>\ntrigger.thing: x\n</trigger-context>");
  });

  test("no message, no refs, no context → the trigger-context block is omitted", () => {
    const rendered = renderTaskMessage("Summarize the weekly numbers.", {
      message: "",
      data: { ignored: true },
    });
    expect(rendered).toBe(
      "<workflow-task>\nSummarize the weekly numbers.\n</workflow-task>",
    );
  });

  test("instructions whitespace is trimmed inside the task block", () => {
    const rendered = renderTaskMessage("\n\n  Do the thing.  \n", {
      message: "",
      data: {},
    });
    expect(rendered).toBe("<workflow-task>\nDo the thing.\n</workflow-task>");
  });

  test("prose emails and @@ never rewrite (reference grammar guard)", () => {
    const rendered = renderTaskMessage("Mail ada@example.com about @@nothing", {
      message: "",
      data: {},
    });
    expect(rendered).toContain("Mail ada@example.com about @@nothing");
  });

  test("multi-line instructions render inside one task block", () => {
    const rendered = renderTaskMessage(
      "1. Read @trigger.report\n2. Summarize it\n3. Post via @slack-alerts",
      { message: "Weekly run", data: { report: "Q3.pdf" } },
    );
    expect(rendered).toBe(
      [
        "<workflow-task>",
        "1. Read Q3.pdf",
        "2. Summarize it",
        '3. Post via the "slack-alerts" connection',
        "</workflow-task>",
        "",
        "<trigger-context>",
        "Weekly run",
        "trigger.report: Q3.pdf",
        "</trigger-context>",
      ].join("\n"),
    );
  });
});
