/**
 * Restricted structured-output schema for `infer` and `agent` pipeline steps
 * (pipeline redesign spec). A deliberate SUBSET of JSON Schema — object /
 * array / string / number / boolean, string `enum`, object `required` — with
 * no `$ref`, no `oneOf`/`anyOf`, no pattern/format keywords, and nesting
 * capped at {@link MAX_OUTPUT_SCHEMA_DEPTH}. Node shapes are strict objects,
 * so unsupported keywords are REJECTED at parse rather than silently ignored.
 *
 * `compileOutputSchema` turns a parsed node into a validator both sides use:
 * the control plane to enforce a step's declared output at execution, the SPA
 * to preview validation without a round-trip. Hand-rolled walk — deliberately
 * no JSON-Schema dependency, and pure (SPA-importable via the barrel).
 */
import { z } from "zod";

/** Maximum nesting depth of an output schema (the root node is depth 1). */
export const MAX_OUTPUT_SCHEMA_DEPTH = 5;

// ── Node types (manual — the schema below is recursive) ─────────────────────

export interface OutputStringSchemaNode {
  type: "string";
  /** Closed set of allowed values. */
  enum?: string[];
  description?: string;
}

export interface OutputNumberSchemaNode {
  type: "number";
  description?: string;
}

export interface OutputBooleanSchemaNode {
  type: "boolean";
  description?: string;
}

export interface OutputArraySchemaNode {
  type: "array";
  items: OutputSchemaNode;
  description?: string;
}

export interface OutputObjectSchemaNode {
  type: "object";
  properties: Record<string, OutputSchemaNode>;
  /** Property names that must be present (each must also be declared). */
  required?: string[];
  description?: string;
}

export type OutputSchemaNode =
  | OutputStringSchemaNode
  | OutputNumberSchemaNode
  | OutputBooleanSchemaNode
  | OutputArraySchemaNode
  | OutputObjectSchemaNode;

// ── Zod shape ───────────────────────────────────────────────────────────────

/**
 * One node of the subset. Recursive, so the type is authored manually above
 * and the schema is annotated (zod cannot infer through the cycle).
 */
export const outputSchemaNodeSchema: z.ZodType<OutputSchemaNode, OutputSchemaNode> =
  z.lazy(() =>
    z.discriminatedUnion("type", [
      outputStringNodeSchema,
      outputNumberNodeSchema,
      outputBooleanNodeSchema,
      outputArrayNodeSchema,
      outputObjectNodeSchema,
    ]),
  );

const outputStringNodeSchema = z.strictObject({
  type: z.literal("string"),
  enum: z.array(z.string().min(1)).min(1).optional(),
  description: z.string().optional(),
});

const outputNumberNodeSchema = z.strictObject({
  type: z.literal("number"),
  description: z.string().optional(),
});

const outputBooleanNodeSchema = z.strictObject({
  type: z.literal("boolean"),
  description: z.string().optional(),
});

const outputArrayNodeSchema = z.strictObject({
  type: z.literal("array"),
  items: outputSchemaNodeSchema,
  description: z.string().optional(),
});

const outputObjectNodeSchema = z.strictObject({
  type: z.literal("object"),
  properties: z.record(z.string(), outputSchemaNodeSchema),
  required: z.array(z.string()).optional(),
  description: z.string().optional(),
});

/** Nesting depth of a node tree (root = 1). */
export function outputSchemaDepth(node: OutputSchemaNode): number {
  switch (node.type) {
    case "array":
      return 1 + outputSchemaDepth(node.items);
    case "object": {
      let deepest = 0;
      for (const child of Object.values(node.properties)) {
        deepest = Math.max(deepest, outputSchemaDepth(child));
      }
      return 1 + deepest;
    }
    default:
      return 1;
  }
}

/**
 * A ROOT output schema — what `output.schema` on infer/agent steps parses
 * with. Adds the depth cap and requires `required` names to be declared,
 * neither of which is expressible per-node.
 */
export const outputSchemaSchema = outputSchemaNodeSchema.superRefine(
  (node, ctx) => {
    if (outputSchemaDepth(node) > MAX_OUTPUT_SCHEMA_DEPTH) {
      ctx.addIssue({
        code: "custom",
        message: `output schema nesting exceeds the depth cap of ${MAX_OUTPUT_SCHEMA_DEPTH}`,
      });
    }
    const checkRequired = (
      current: OutputSchemaNode,
      path: (string | number)[],
    ): void => {
      if (current.type === "object") {
        for (const name of current.required ?? []) {
          if (!(name in current.properties)) {
            ctx.addIssue({
              code: "custom",
              path: [...path, "required"],
              message: `required property "${name}" is not declared in properties`,
            });
          }
        }
        for (const [key, child] of Object.entries(current.properties)) {
          checkRequired(child, [...path, "properties", key]);
        }
      } else if (current.type === "array") {
        checkRequired(current.items, [...path, "items"]);
      }
    };
    checkRequired(node, []);
  },
);

// ── Validator compilation ───────────────────────────────────────────────────

export type OutputSchemaValidationResult =
  | { ok: true; value: unknown }
  | { ok: false; errors: string[] };

export type OutputSchemaValidator = (
  value: unknown,
) => OutputSchemaValidationResult;

/** Errors reported per validation before the walk gives up (bounds messages). */
const MAX_VALIDATION_ERRORS = 25;

/**
 * Compile a parsed output schema into a pure validator.
 *
 * Strict on declared shape, lenient at the edges: extra object properties are
 * ALLOWED and passed through untouched (model outputs routinely carry
 * incidental keys), no coercion is performed, and `value` is returned as-is
 * on success. Numbers must be finite (JSON reality — NaN/Infinity never
 * arrive in a parsed payload but a caller could hand them in). Error strings
 * are dot-paths ("items.0.title: expected string"), capped at 25.
 */
export function compileOutputSchema(
  schema: OutputSchemaNode,
): OutputSchemaValidator {
  return (value) => {
    const errors: string[] = [];
    validateNode(schema, value, "", errors);
    return errors.length === 0 ? { ok: true, value } : { ok: false, errors };
  };
}

function validateNode(
  node: OutputSchemaNode,
  value: unknown,
  path: string,
  errors: string[],
): void {
  if (errors.length >= MAX_VALIDATION_ERRORS) return;
  const at = path === "" ? "(root)" : path;
  switch (node.type) {
    case "string": {
      if (typeof value !== "string") {
        errors.push(`${at}: expected string, got ${describe(value)}`);
        return;
      }
      if (node.enum && !node.enum.includes(value)) {
        errors.push(
          `${at}: expected one of ${node.enum.map((option) => JSON.stringify(option)).join(", ")}, got ${JSON.stringify(value)}`,
        );
      }
      return;
    }
    case "number": {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        errors.push(`${at}: expected number, got ${describe(value)}`);
      }
      return;
    }
    case "boolean": {
      if (typeof value !== "boolean") {
        errors.push(`${at}: expected boolean, got ${describe(value)}`);
      }
      return;
    }
    case "array": {
      if (!Array.isArray(value)) {
        errors.push(`${at}: expected array, got ${describe(value)}`);
        return;
      }
      value.forEach((entry, index) => {
        validateNode(node.items, entry, joinPath(path, String(index)), errors);
      });
      return;
    }
    case "object": {
      if (typeof value !== "object" || value === null || Array.isArray(value)) {
        errors.push(`${at}: expected object, got ${describe(value)}`);
        return;
      }
      const record = value as Record<string, unknown>;
      for (const name of node.required ?? []) {
        if (record[name] === undefined) {
          errors.push(`${at}: missing required property "${name}"`);
        }
      }
      for (const [key, child] of Object.entries(node.properties)) {
        if (record[key] === undefined) continue; // absent optionals are fine
        validateNode(child, record[key], joinPath(path, key), errors);
      }
      return;
    }
  }
}

function joinPath(path: string, segment: string): string {
  return path === "" ? segment : `${path}.${segment}`;
}

function describe(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}
