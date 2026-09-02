/**
 * INFER step inspector: workspace preset picker → Tiptap prompt (the existing
 * markdown-document editor with `@reference` chips — placeholder/ariaLabel
 * are module CONSTANTS, per the never-change-after-mount invariant) → the
 * structured-output builder.
 *
 * The output builder edits the COMMON schema shape as flat rows (a root
 * object of scalar / list-of-text fields); anything deeper falls back to the
 * raw-JSON escape hatch, validated by the shared `outputSchemaSchema` so an
 * invalid schema never reaches the draft. The row ⇄ node codec is pure and
 * exported for tests.
 */
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import {
  outputSchemaSchema,
  type InferStep,
  type ModelPresetDto,
  type OutputObjectSchemaNode,
  type OutputSchemaNode,
} from "@invisible-string/shared";

import type { StepParamsPatch } from "../../../lib/builder/model";
import type { ReferenceSources } from "../../../lib/builder/references";
import { shortModelId } from "../../../lib/builder/summary";
import { InstructionsEditor } from "../../builder/InstructionsEditor";
import { Input } from "../../ui/Input";
import { Select } from "../../ui/Select";
import { Switch } from "../../ui/Switch";
import { Textarea } from "../../ui/Textarea";

/** NEVER derive these from state — changing either destroys the draft. */
const PROMPT_PLACEHOLDER =
  "Write the prompt…  Type @ to reference the trigger, earlier steps, or state.";
const PROMPT_ARIA_LABEL = "Prompt editor";

// ── Output rows ⇄ schema (pure; tested) ─────────────────────────────────────

export type OutputRowType = "string" | "number" | "boolean" | "string_list";

export interface OutputFieldRow {
  key: string;
  type: OutputRowType;
  required: boolean;
}

const ROW_TYPE_LABELS: Record<OutputRowType, string> = {
  string: "Text",
  number: "Number",
  boolean: "True / false",
  string_list: "List of text",
};

/** Flat rows for `schema`, or null when only raw JSON can express it. */
export function outputRowsOf(schema: OutputSchemaNode): OutputFieldRow[] | null {
  if (schema.type !== "object") return null;
  const required = new Set(schema.required ?? []);
  const rows: OutputFieldRow[] = [];
  for (const [key, node] of Object.entries(schema.properties)) {
    if (node.type === "string" && node.enum === undefined) {
      rows.push({ key, type: "string", required: required.has(key) });
    } else if (node.type === "number" || node.type === "boolean") {
      rows.push({ key, type: node.type, required: required.has(key) });
    } else if (node.type === "array" && node.items.type === "string" && node.items.enum === undefined) {
      rows.push({ key, type: "string_list", required: required.has(key) });
    } else {
      return null; // nested object / enum / list-of-numbers → raw lane
    }
  }
  return rows;
}

export function rowsToSchema(rows: readonly OutputFieldRow[]): OutputObjectSchemaNode {
  const properties: OutputObjectSchemaNode["properties"] = {};
  const required: string[] = [];
  for (const row of rows) {
    if (row.key === "") continue;
    properties[row.key] =
      row.type === "string_list"
        ? { type: "array", items: { type: "string" } }
        : { type: row.type };
    if (row.required) required.push(row.key);
  }
  return {
    type: "object",
    properties,
    ...(required.length > 0 ? { required } : {}),
  };
}

// ── Component ───────────────────────────────────────────────────────────────

export interface InferStepFormProps {
  step: InferStep;
  /** Workspace presets; null while loading. */
  presets: readonly ModelPresetDto[] | null;
  sources: ReferenceSources;
  onPatch: (patch: StepParamsPatch) => void;
}

export function InferStepForm({
  step,
  presets,
  sources,
  onPatch,
}: InferStepFormProps) {
  const schema = step.output?.schema;
  const rows = schema !== undefined ? outputRowsOf(schema) : [];
  const [rawSchema, setRawSchema] = useState(schema !== undefined && rows === null);

  const presetOptions =
    presets === null
      ? [{ value: step.preset, label: step.preset }]
      : presets.map((preset) => ({
          value: preset.slug,
          label: `${preset.slug} · ${shortModelId(preset.modelId)}`,
        }));
  if (
    presets !== null &&
    !presets.some((preset) => preset.slug === step.preset)
  ) {
    presetOptions.push({ value: step.preset, label: step.preset });
  }

  return (
    <div className="flex flex-col gap-4">
      <Select
        label="Model preset"
        value={step.preset}
        disabled={presets === null}
        options={presetOptions}
        onChange={(event) => onPatch({ preset: event.currentTarget.value })}
      />

      <div className="flex flex-col gap-1.5">
        <span className="px-1 text-[13px] font-medium text-ink-2">Prompt</span>
        <InstructionsEditor
          value={step.prompt.markdown}
          onChange={(markdown) => onPatch({ prompt: { markdown } })}
          sources={sources}
          placeholder={PROMPT_PLACEHOLDER}
          ariaLabel={PROMPT_ARIA_LABEL}
        />
      </div>

      <div className="flex flex-col gap-2.5">
        <label className="flex items-center justify-between gap-4 px-1">
          <span className="flex min-w-0 flex-col">
            <span className="text-[13px] font-medium text-ink">
              Structured output
            </span>
            <span className="text-[11.5px] leading-snug text-ink-3">
              Declare fields and later steps can reference them by name.
            </span>
          </span>
          <Switch
            label="Structured output"
            checked={schema !== undefined}
            onChange={(checked) => {
              onPatch({
                output: checked
                  ? { schema: { type: "object", properties: {} } }
                  : undefined,
              });
              setRawSchema(false);
            }}
          />
        </label>

        {schema !== undefined ? (
          <>
            <div className="flex justify-end px-1">
              <button
                type="button"
                disabled={rawSchema && rows === null}
                onClick={() => setRawSchema((mode) => !mode)}
                className="rounded-capsule px-2 py-0.5 text-[11px] font-medium text-ink-3 transition-colors duration-150 ease-out hover:bg-black/[0.04] hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink disabled:pointer-events-none disabled:opacity-40"
              >
                {rawSchema
                  ? rows === null
                    ? "Only editable as JSON"
                    : "Edit as fields"
                  : "Edit as JSON Schema"}
              </button>
            </div>
            {rawSchema || rows === null ? (
              <SchemaJsonEditor
                schema={schema}
                onChange={(next) => onPatch({ output: { schema: next } })}
              />
            ) : (
              <OutputFieldRows
                rows={rows}
                onChange={(next) =>
                  onPatch({ output: { schema: rowsToSchema(next) } })
                }
              />
            )}
          </>
        ) : null}
      </div>
    </div>
  );
}

function OutputFieldRows({
  rows,
  onChange,
}: {
  rows: readonly OutputFieldRow[];
  onChange: (rows: OutputFieldRow[]) => void;
}) {
  const update = (index: number, patch: Partial<OutputFieldRow>) => {
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  };
  return (
    <div className="flex flex-col gap-2">
      {rows.length === 0 ? (
        <p className="rounded-card border border-dashed border-black/15 px-3 py-3 text-center text-[12px] text-ink-4">
          No fields yet — add the first one.
        </p>
      ) : (
        rows.map((row, index) => (
          <div key={index} className="flex items-center gap-1.5">
            <Input
              label={`Field ${index + 1} name`}
              srOnlyLabel
              placeholder="field_name"
              value={row.key}
              className="h-8 font-mono text-[12px]"
              onChange={(event) => update(index, { key: event.currentTarget.value })}
            />
            <Select
              label={`Field ${index + 1} type`}
              srOnlyLabel
              value={row.type}
              className="h-8 w-32 text-[12px]"
              options={(Object.keys(ROW_TYPE_LABELS) as OutputRowType[]).map(
                (type) => ({ value: type, label: ROW_TYPE_LABELS[type] }),
              )}
              onChange={(event) =>
                update(index, { type: event.currentTarget.value as OutputRowType })
              }
            />
            <label className="flex shrink-0 items-center gap-1.5 text-[11.5px] text-ink-3">
              <Switch
                label={`Field ${index + 1} required`}
                checked={row.required}
                onChange={(checked) => update(index, { required: checked })}
              />
              req
            </label>
            <button
              type="button"
              aria-label={`Remove field ${row.key === "" ? index + 1 : row.key}`}
              onClick={() => onChange(rows.filter((_row, i) => i !== index))}
              className="lift flex size-7 shrink-0 items-center justify-center rounded-full text-ink-4 hover:bg-err/10 hover:text-err"
            >
              <Trash2 size={12} aria-hidden="true" />
            </button>
          </div>
        ))
      )}
      <button
        type="button"
        onClick={() =>
          onChange([...rows, { key: "", type: "string", required: false }])
        }
        className="lift flex w-fit items-center gap-1.5 rounded-capsule border border-black/10 bg-white/50 px-2.5 py-1 text-[11.5px] font-medium text-ink-2 hover:text-ink"
      >
        <Plus size={11} aria-hidden="true" />
        Add field
      </button>
    </div>
  );
}

function SchemaJsonEditor({
  schema,
  onChange,
}: {
  schema: OutputSchemaNode;
  onChange: (schema: OutputSchemaNode) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(schema, null, 2));
  const [error, setError] = useState<string | null>(null);
  return (
    <Textarea
      label="Output schema (JSON)"
      srOnlyLabel
      value={text}
      rows={8}
      error={error}
      hint="A restricted JSON-Schema subset: object / array / string / number / boolean, string enum, required. Depth ≤ 5."
      className="font-mono text-[12px]"
      onChange={(event) => {
        const next = event.currentTarget.value;
        setText(next);
        try {
          const parsed: unknown = JSON.parse(next);
          const result = outputSchemaSchema.safeParse(parsed);
          if (!result.success) {
            setError(result.error.issues[0]?.message ?? "Not a valid schema.");
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
