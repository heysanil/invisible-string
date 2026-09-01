/**
 * Pure tests for the inspector codecs: field text ⇄ TemplateValue (fields.tsx),
 * the simple-condition row ⇄ AST (ConditionEditor), schema-aware arg specs
 * (ToolStepForm) and the output-schema rows (InferStepForm). These are the
 * seams where a wrong parse silently changes what the runner sends, so every
 * branch gets a round-trip.
 */
import { describe, expect, test } from "bun:test";
import { outputSchemaSchema, type PipelineCondition } from "@invisible-string/shared";

import {
  templateValueMode,
  templateValueToText,
  textToTemplateValue,
} from "../components/pipeline/inspector/fields";
import {
  fromSimpleCondition,
  operandPath,
  toSimpleCondition,
} from "../components/pipeline/inspector/ConditionEditor";
import { argFieldSpecs } from "../components/pipeline/inspector/ToolStepForm";
import {
  outputRowsOf,
  rowsToSchema,
} from "../components/pipeline/inspector/InferStepForm";

// ── template text codec ─────────────────────────────────────────────────────

describe("textToTemplateValue", () => {
  test("a whole-line @path becomes a $ref (type-preserving)", () => {
    expect(textToTemplateValue("@steps.search.result")).toEqual({
      $ref: "steps.search.result",
    });
    expect(textToTemplateValue("  @trigger.email  ")).toEqual({
      $ref: "trigger.email",
    });
  });

  test("embedded references become a $tpl, text preserved verbatim", () => {
    expect(textToTemplateValue("Digest for @trigger.channel today")).toEqual({
      $tpl: "Digest for @trigger.channel today",
    });
  });

  test("plain text stays a literal string — no coercion by default", () => {
    expect(textToTemplateValue("hello")).toBe("hello");
    expect(textToTemplateValue("42")).toBe("42");
    expect(textToTemplateValue("true")).toBe("true");
    // an email is not a reference (the grammar's boundary guard)
    expect(textToTemplateValue("mail me at hi@sanil.co")).toBe(
      "mail me at hi@sanil.co",
    );
  });

  test("schema expectations coerce typed literals", () => {
    expect(textToTemplateValue("42", "number")).toBe(42);
    expect(textToTemplateValue("-3.5", "number")).toBe(-3.5);
    expect(textToTemplateValue("4.", "number")).toBe("4."); // mid-typing stays text
    expect(textToTemplateValue("true", "boolean")).toBe(true);
    expect(textToTemplateValue("false", "boolean")).toBe(false);
    expect(textToTemplateValue("maybe", "boolean")).toBe("maybe");
  });

  test("round-trips through templateValueToText", () => {
    for (const text of [
      "@steps.search.result",
      "Digest for @state.cursor",
      "plain words",
      "42",
    ]) {
      const value = textToTemplateValue(text);
      expect(templateValueToText(value)).toBe(text);
    }
    expect(templateValueToText(textToTemplateValue("42", "number"))).toBe("42");
  });

  test("structured values have no text form (raw-JSON lane)", () => {
    expect(templateValueToText({ nested: { $ref: "steps.a" } })).toBeNull();
    expect(templateValueToText(["a", "b"])).toBeNull();
    expect(templateValueToText(null)).toBeNull();
    expect(templateValueMode({ nested: "x" })).toBe("json");
    expect(templateValueMode({ $ref: "steps.a" })).toBe("ref");
    expect(templateValueMode({ $tpl: "x @now" })).toBe("template");
    expect(templateValueMode("x")).toBe("literal");
  });
});

// ── condition row codec ─────────────────────────────────────────────────────

describe("condition row codec", () => {
  test("binary and unary leaves round-trip", () => {
    const eq: PipelineCondition = {
      eq: [{ $ref: "trigger.channel" }, "C123"],
    };
    const simple = toSimpleCondition(eq);
    expect(simple).toEqual({
      op: "eq",
      left: { $ref: "trigger.channel" },
      right: "C123",
    });
    expect(fromSimpleCondition(simple!)).toEqual(eq);

    const exists: PipelineCondition = { exists: { $ref: "item.id" } };
    const unary = toSimpleCondition(exists);
    expect(unary).toEqual({ op: "exists", left: { $ref: "item.id" }, right: null });
    expect(fromSimpleCondition(unary!)).toEqual(exists);
  });

  test("boolean trees are row-inexpressible (JSON lane)", () => {
    expect(
      toSimpleCondition({ and: [{ truthy: { $ref: "state.on" } }] }),
    ).toBeNull();
    expect(toSimpleCondition({ not: { empty: { $ref: "item" } } })).toBeNull();
  });

  test("operandPath reads only $ref operands", () => {
    expect(operandPath({ $ref: "steps.a.result" })).toBe("steps.a.result");
    expect(operandPath("literal")).toBe("");
    expect(operandPath(null)).toBe("");
  });
});

// ── schema-aware arg specs ──────────────────────────────────────────────────

describe("argFieldSpecs", () => {
  test("walks top-level properties, required first, types mapped", () => {
    const specs = argFieldSpecs({
      type: "object",
      properties: {
        query: { type: "string", description: "Search text." },
        limit: { type: "integer" },
        exact: { type: "boolean" },
        filters: { type: "object" },
      },
      required: ["query"],
    });
    expect(specs).not.toBeNull();
    expect(specs!.map((spec) => spec.key)).toEqual([
      "query",
      "limit",
      "exact",
      "filters",
    ]);
    expect(specs![0]).toEqual({
      key: "query",
      expect: "string",
      description: "Search text.",
      required: true,
    });
    expect(specs![1]!.expect).toBe("number");
    expect(specs![2]!.expect).toBe("boolean");
    expect(specs![3]!.expect).toBe("any");
  });

  test("enum values fold into the hint", () => {
    const specs = argFieldSpecs({
      properties: { level: { type: "string", enum: ["low", "high"] } },
    });
    expect(specs![0]!.description).toContain("One of: low, high.");
  });

  test("no walkable properties → null (name-keyed lane)", () => {
    expect(argFieldSpecs(undefined)).toBeNull();
    expect(argFieldSpecs({ type: "object" })).toBeNull();
    expect(argFieldSpecs({ properties: "nope" })).toBeNull();
  });
});

// ── output schema rows ──────────────────────────────────────────────────────

describe("output schema rows", () => {
  test("flat object schemas round-trip through rows", () => {
    const schema = {
      type: "object" as const,
      properties: {
        title: { type: "string" as const },
        count: { type: "number" as const },
        urgent: { type: "boolean" as const },
        tags: { type: "array" as const, items: { type: "string" as const } },
      },
      required: ["title"],
    };
    const rows = outputRowsOf(schema);
    expect(rows).toEqual([
      { key: "title", type: "string", required: true },
      { key: "count", type: "number", required: false },
      { key: "urgent", type: "boolean", required: false },
      { key: "tags", type: "string_list", required: false },
    ]);
    const rebuilt = rowsToSchema(rows!);
    expect(rebuilt).toEqual(schema);
    // and the shared validator accepts what the rows build
    expect(outputSchemaSchema.safeParse(rebuilt).success).toBe(true);
  });

  test("nested / enum shapes are row-inexpressible", () => {
    expect(
      outputRowsOf({
        type: "object",
        properties: { deep: { type: "object", properties: {} } },
      }),
    ).toBeNull();
    expect(
      outputRowsOf({
        type: "object",
        properties: { level: { type: "string", enum: ["a"] } },
      }),
    ).toBeNull();
    expect(outputRowsOf({ type: "string" })).toBeNull();
  });

  test("rows with empty names are dropped on rebuild", () => {
    expect(
      rowsToSchema([{ key: "", type: "string", required: true }]),
    ).toEqual({ type: "object", properties: {} });
  });
});
