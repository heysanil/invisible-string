import { describe, expect, test } from "bun:test";

import {
  MAX_OUTPUT_SCHEMA_DEPTH,
  compileOutputSchema,
  outputSchemaDepth,
  outputSchemaSchema,
  type OutputSchemaNode,
} from "./pipeline-output-schema";

const issueSchema: OutputSchemaNode = {
  type: "object",
  properties: {
    title: { type: "string" },
    priority: { type: "string", enum: ["low", "high"] },
    points: { type: "number" },
    urgent: { type: "boolean" },
    labels: { type: "array", items: { type: "string" } },
  },
  required: ["title", "priority"],
};

// ── Schema shape ────────────────────────────────────────────────────────────

describe("outputSchemaSchema", () => {
  test("parses the restricted subset", () => {
    expect(outputSchemaSchema.safeParse(issueSchema).success).toBe(true);
  });

  test("rejects unsupported keywords loudly (strict nodes)", () => {
    expect(
      outputSchemaSchema.safeParse({ type: "string", pattern: "^a" }).success,
    ).toBe(false);
    expect(
      outputSchemaSchema.safeParse({ $ref: "#/defs/x" }).success,
    ).toBe(false);
    expect(
      outputSchemaSchema.safeParse({ oneOf: [{ type: "string" }] }).success,
    ).toBe(false);
    expect(outputSchemaSchema.safeParse({ type: "integer" }).success).toBe(false);
  });

  test("enum only on strings, and required names must be declared", () => {
    expect(
      outputSchemaSchema.safeParse({ type: "number", enum: [1] }).success,
    ).toBe(false);
    const undeclared = outputSchemaSchema.safeParse({
      type: "object",
      properties: { a: { type: "string" } },
      required: ["a", "ghost"],
    });
    expect(undeclared.success).toBe(false);
  });

  test("enforces the depth cap", () => {
    let node: OutputSchemaNode = { type: "string" };
    for (let i = 1; i < MAX_OUTPUT_SCHEMA_DEPTH; i++) {
      node = { type: "array", items: node };
    }
    expect(outputSchemaDepth(node)).toBe(MAX_OUTPUT_SCHEMA_DEPTH);
    expect(outputSchemaSchema.safeParse(node).success).toBe(true);
    expect(
      outputSchemaSchema.safeParse({ type: "array", items: node }).success,
    ).toBe(false);
  });
});

// ── Compiled validator ──────────────────────────────────────────────────────

describe("compileOutputSchema", () => {
  const validate = compileOutputSchema(issueSchema);

  test("accepts conforming values and returns them untouched", () => {
    const value = {
      title: "Exec mention",
      priority: "high",
      labels: ["team-exec"],
      extra: "passes through", // undeclared keys are allowed
    };
    const result = validate(value);
    expect(result).toEqual({ ok: true, value });
  });

  test("reports missing required and type mismatches with dot paths", () => {
    const result = validate({ priority: "urgent", points: "3", labels: ["a", 1] });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors).toEqual([
        '(root): missing required property "title"',
        'priority: expected one of "low", "high", got "urgent"',
        "points: expected number, got string",
        "labels.1: expected string, got number",
      ]);
    }
  });

  test("rejects non-objects, non-finite numbers, and arrays-for-objects", () => {
    expect(validate(null).ok).toBe(false);
    expect(validate([]).ok).toBe(false);
    const numeric = compileOutputSchema({ type: "number" });
    expect(numeric(3.5).ok).toBe(true);
    expect(numeric(Number.NaN).ok).toBe(false);
    expect(numeric(Infinity).ok).toBe(false);
  });

  test("absent optional properties are fine; null is not absent", () => {
    const optional = compileOutputSchema({
      type: "object",
      properties: { note: { type: "string" } },
    });
    expect(optional({}).ok).toBe(true);
    expect(optional({ note: null }).ok).toBe(false);
  });
});
