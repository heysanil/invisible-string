/**
 * Condition editor for `filter.where` and `branch.branches[].when`.
 *
 * Two lanes, matching how conditions actually occur:
 * - the SIMPLE row (ref picker · operator Select · value field) for a single
 *   leaf comparison — the overwhelmingly common case;
 * - a raw-JSON escape hatch (validated against the shared condition schema)
 *   for `and`/`or`/`not` trees, which have no honest row form.
 *
 * The codec between the two (`toSimpleCondition` / `fromSimpleCondition`) is
 * pure and exported for tests. A condition the row cannot express renders in
 * JSON mode with the row toggle disabled — nothing is ever silently lossy.
 */
import { useState } from "react";
import {
  pipelineConditionSchema,
  type ConditionOperand,
  type PipelineCondition,
  type TemplateValue,
} from "@invisible-string/shared";

import { describeCondition } from "../../../lib/builder/summary";
import type { ReferenceSources } from "../../../lib/builder/references";
import { cn } from "../../../lib/cn";
import { Select } from "../../ui/Select";
import { Textarea } from "../../ui/Textarea";
import { RefPathField, TemplateValueField } from "./fields";

// ── Pure codec ──────────────────────────────────────────────────────────────

const BINARY_OPS = [
  "eq",
  "ne",
  "gt",
  "gte",
  "lt",
  "lte",
  "contains",
  "startsWith",
  "endsWith",
  "in",
] as const;
const UNARY_OPS = ["exists", "truthy", "empty"] as const;

export type BinaryConditionOp = (typeof BINARY_OPS)[number];
export type UnaryConditionOp = (typeof UNARY_OPS)[number];
export type SimpleConditionOp = BinaryConditionOp | UnaryConditionOp;

const OP_LABELS: Record<SimpleConditionOp, string> = {
  eq: "=",
  ne: "≠",
  gt: ">",
  gte: "≥",
  lt: "<",
  lte: "≤",
  contains: "contains",
  startsWith: "starts with",
  endsWith: "ends with",
  in: "is in",
  exists: "exists",
  truthy: "is truthy",
  empty: "is empty",
};

export interface SimpleCondition {
  op: SimpleConditionOp;
  left: ConditionOperand;
  /** Null for unary operators. */
  right: ConditionOperand | null;
}

export function isUnaryOp(op: SimpleConditionOp): op is UnaryConditionOp {
  return (UNARY_OPS as readonly string[]).includes(op);
}

/** The row form of `condition`, or null when only JSON can express it. */
export function toSimpleCondition(
  condition: PipelineCondition,
): SimpleCondition | null {
  for (const op of UNARY_OPS) {
    if (op in condition) {
      return {
        op,
        left: (condition as Record<UnaryConditionOp, ConditionOperand>)[op],
        right: null,
      };
    }
  }
  for (const op of BINARY_OPS) {
    if (op in condition) {
      const pair = (
        condition as Record<BinaryConditionOp, [ConditionOperand, ConditionOperand]>
      )[op];
      return { op, left: pair[0], right: pair[1] };
    }
  }
  return null; // and / or / not
}

export function fromSimpleCondition(simple: SimpleCondition): PipelineCondition {
  if (isUnaryOp(simple.op)) {
    return { [simple.op]: simple.left } as PipelineCondition;
  }
  return {
    [simple.op]: [simple.left, simple.right ?? ""],
  } as PipelineCondition;
}

/** The `$ref` path of an operand, "" when it is not a reference. */
export function operandPath(operand: ConditionOperand): string {
  return operand !== null &&
    typeof operand === "object" &&
    !Array.isArray(operand)
    ? operand.$ref
    : "";
}

// ── Component ───────────────────────────────────────────────────────────────

export interface ConditionEditorProps {
  value: PipelineCondition;
  onChange: (value: PipelineCondition) => void;
  sources: ReferenceSources;
  /** Accessible prefix distinguishing multiple editors in one form. */
  label?: string;
}

export function ConditionEditor({
  value,
  onChange,
  sources,
  label = "Condition",
}: ConditionEditorProps) {
  const simple = toSimpleCondition(value);
  // JSON mode is sticky once entered (or forced by an inexpressible AST).
  const [jsonMode, setJsonMode] = useState(simple === null);
  const showRow = !jsonMode && simple !== null;

  return (
    <div className="flex flex-col gap-1.5">
      {showRow ? (
        <div className="grid grid-cols-1 gap-1.5 sm:grid-cols-[1fr_auto_1fr]">
          <RefPathField
            label={`${label} — left operand`}
            srOnlyLabel
            path={operandPath(simple.left)}
            sources={sources}
            placeholder="steps.search.result"
            onChange={(path) =>
              onChange(fromSimpleCondition({ ...simple, left: { $ref: path } }))
            }
          />
          <Select
            label={`${label} — operator`}
            srOnlyLabel
            value={simple.op}
            className="h-9 text-[13px]"
            options={[...UNARY_OPS, ...BINARY_OPS].map((op) => ({
              value: op,
              label: OP_LABELS[op],
            }))}
            onChange={(event) => {
              const op = event.currentTarget.value as SimpleConditionOp;
              onChange(
                fromSimpleCondition({
                  op,
                  left: simple.left,
                  right: isUnaryOp(op) ? null : (simple.right ?? ""),
                }),
              );
            }}
          />
          {isUnaryOp(simple.op) ? (
            <span aria-hidden="true" />
          ) : (
            <TemplateValueField
              label={`${label} — value`}
              value={operandValueForField(simple.right)}
              sources={sources}
              placeholder="value or @reference"
              onChange={(next) =>
                onChange(
                  fromSimpleCondition({
                    ...simple,
                    right: fieldValueToOperand(next),
                  }),
                )
              }
            />
          )}
        </div>
      ) : (
        <ConditionJsonEditor value={value} onChange={onChange} label={label} />
      )}
      <div className="flex items-center justify-between gap-2 px-0.5">
        <p className="truncate text-[11.5px] text-ink-4">
          {describeCondition(value)}
        </p>
        <button
          type="button"
          disabled={!jsonMode && simple === null}
          onClick={() => setJsonMode((mode) => !mode || simple === null)}
          className={cn(
            "shrink-0 rounded-capsule px-2 py-0.5 text-[11px] font-medium text-ink-3 transition-colors duration-150 ease-out hover:bg-black/[0.04] hover:text-ink",
            "focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink",
          )}
        >
          {jsonMode
            ? simple === null
              ? "Only editable as JSON"
              : "Edit as row"
            : "Edit as JSON"}
        </button>
      </div>
    </div>
  );
}

/**
 * Condition operands are a subset of template values (scalars, scalar lists,
 * `$ref`) — bridge them through the shared field. Lists render/parse as JSON
 * text via the field's codec limits, so they surface in JSON mode instead.
 */
function operandValueForField(operand: ConditionOperand | null) {
  return operand ?? "";
}

function fieldValueToOperand(value: TemplateValue): ConditionOperand {
  if (value === null) return null;
  if (
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    // Bare true/false/numbers typed into a condition value mean the literal.
    if (value === "true") return true;
    if (value === "false") return false;
    if (typeof value === "string" && /^-?\d+(\.\d+)?$/.test(value.trim())) {
      return Number(value.trim());
    }
    return value;
  }
  if (!Array.isArray(value) && "$ref" in value && typeof value.$ref === "string") {
    return { $ref: value.$ref };
  }
  if (!Array.isArray(value) && "$tpl" in value && typeof value.$tpl === "string") {
    // Conditions have no string-interpolation operand — keep the text literal.
    return value.$tpl;
  }
  // Structured values never come out of the line field; degrade to prose.
  return JSON.stringify(value);
}

function ConditionJsonEditor({
  value,
  onChange,
  label,
}: {
  value: PipelineCondition;
  onChange: (value: PipelineCondition) => void;
  label: string;
}) {
  const [text, setText] = useState(() => JSON.stringify(value, null, 2));
  const [error, setError] = useState<string | null>(null);
  return (
    <Textarea
      label={`${label} (JSON)`}
      srOnlyLabel
      value={text}
      rows={5}
      error={error}
      className="font-mono text-[12px]"
      onChange={(event) => {
        const next = event.currentTarget.value;
        setText(next);
        try {
          const parsed: unknown = JSON.parse(next);
          const result = pipelineConditionSchema.safeParse(parsed);
          if (!result.success) {
            setError(result.error.issues[0]?.message ?? "Not a valid condition.");
            return;
          }
          setError(null);
          onChange(result.data);
        } catch {
          setError("Not valid JSON yet.");
        }
      }}
    />
  );
}
