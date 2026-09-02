/**
 * Template-aware form fields for the step inspectors, plus the pure
 * text ⇄ {@link TemplateValue} codec they share (exported for tests).
 *
 * The tagged-template model stays INVISIBLE to the author: a field shows one
 * line of text, and what they type decides the tag —
 *
 *   `@steps.search.result`        → `{"$ref": …}`   (whole-value, typed)
 *   `Digest for @trigger.channel` → `{"$tpl": …}`   (string interpolation)
 *   anything else                 → a literal (string, or number/boolean
 *                                   when the arg's schema expects one)
 *
 * Values with no faithful one-line text form (objects, arrays, null) render
 * read-only here — the ToolStepForm's raw-JSON toggle is the editing surface
 * for those.
 *
 * The trailing "@" capsule opens {@link RefPicker} — the same option list the
 * Tiptap chips use (`referenceOptions`), filtered to the run-scope roots,
 * so every inspector field accepts references without mounting an editor
 * (the one-Tiptap-inspector-at-a-time invariant stays safe).
 */
import { useId, useMemo, useState } from "react";
import { AtSign } from "lucide-react";
import type { RefValue, TemplateValue } from "@invisible-string/shared";

import {
  referenceOptions,
  scopeRefProblem,
  type ReferenceSources,
} from "../../../lib/builder/references";
import { cn } from "../../../lib/cn";
import { Input } from "../../ui/Input";
import { Popover } from "../../ui/Popover";

// ── Pure codec ──────────────────────────────────────────────────────────────

/** What the arg's (cached) schema says the value should be. */
export type TemplateExpectation = "string" | "number" | "boolean" | "any";

/** Exactly one whole-line `@scope.path` token (→ `$ref`). */
const WHOLE_REF_PATTERN =
  /^@([A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*)$/;

/** Any embedded `@reference` (→ `$tpl`). Mirrors the shared grammar's shape. */
const EMBEDDED_REF_PATTERN =
  /(?<![A-Za-z0-9_.@-])@[A-Za-z][A-Za-z0-9_-]*(?:\.[A-Za-z0-9_-]+)*/;

const NUMBER_PATTERN = /^-?\d+(\.\d+)?$/;

/**
 * One-line text for `value`, or null when it has no faithful text form
 * (object/array/null literals — those stay in the raw-JSON lane).
 */
export function templateValueToText(value: TemplateValue): string | null {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value === null) return null;
  if (Array.isArray(value)) return null;
  if ("$ref" in value && typeof value.$ref === "string" && Object.keys(value).length === 1) {
    return `@${value.$ref}`;
  }
  if ("$tpl" in value && typeof value.$tpl === "string" && Object.keys(value).length === 1) {
    return value.$tpl;
  }
  return null;
}

/** Parse one line of field text into the template value it means. */
export function textToTemplateValue(
  text: string,
  expect: TemplateExpectation = "any",
): TemplateValue {
  const trimmed = text.trim();
  const wholeRef = WHOLE_REF_PATTERN.exec(trimmed);
  if (wholeRef !== null && wholeRef[1] !== undefined) {
    return { $ref: wholeRef[1] };
  }
  if (EMBEDDED_REF_PATTERN.test(text)) {
    return { $tpl: text };
  }
  if (expect === "number" && NUMBER_PATTERN.test(trimmed)) {
    return Number(trimmed);
  }
  if (expect === "boolean" && (trimmed === "true" || trimmed === "false")) {
    return trimmed === "true";
  }
  return text;
}

/** Display tag for the value's current mode (field suffix chip). */
export function templateValueMode(
  value: TemplateValue,
): "ref" | "template" | "literal" | "json" {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    if ("$ref" in value && Object.keys(value).length === 1) return "ref";
    if ("$tpl" in value && Object.keys(value).length === 1) return "template";
    return "json";
  }
  if (Array.isArray(value) || value === null) return "json";
  return "literal";
}

// ── RefPicker ───────────────────────────────────────────────────────────────

/** Reference kinds addressable from a `$ref` scope path (no connection/skill). */
const SCOPE_KINDS = new Set(["trigger", "step", "state", "item", "now"]);

export interface RefPickerProps {
  sources: ReferenceSources;
  /** Called with the token, e.g. "@steps.search.result". */
  onPick: (token: string) => void;
  /** Accessible label for the trigger button. */
  label?: string;
}

/**
 * The "@" capsule + option popover. Scope-rooted options only — connections
 * and skills are prose-level references, structurally unreachable from a
 * pipeline `$ref` (the secrets guarantee), so offering them here would mint
 * tokens the validator immediately rejects.
 */
export function RefPicker({ sources, onPick, label = "Insert a reference" }: RefPickerProps) {
  const [query, setQuery] = useState("");
  const options = useMemo(
    () =>
      referenceOptions(sources).filter((option) => SCOPE_KINDS.has(option.kind)),
    [sources],
  );
  const filtered =
    query.trim() === ""
      ? options
      : options.filter((option) =>
          option.label.toLowerCase().includes(query.trim().toLowerCase()),
        );
  return (
    <Popover
      label={label}
      align="end"
      trigger={
        <button
          type="button"
          aria-label={label}
          title={label}
          className="lift flex size-7 shrink-0 items-center justify-center rounded-full border border-black/10 bg-white/60 text-ink-3 hover:text-ink"
        >
          <AtSign size={12} aria-hidden="true" />
        </button>
      }
    >
      {({ close }) => (
        <div className="flex max-h-72 w-64 flex-col gap-1.5">
          <Input
            label="Filter references"
            srOnlyLabel
            placeholder="Filter…"
            value={query}
            className="h-8 text-[12.5px]"
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
          <div className="flex flex-col gap-0.5 overflow-y-auto" role="listbox" aria-label="References">
            {filtered.length === 0 ? (
              <p className="px-2 py-1.5 text-[12px] text-ink-4">
                Nothing to reference here yet.
              </p>
            ) : (
              filtered.map((option) => (
                <button
                  key={option.label}
                  type="button"
                  role="option"
                  aria-selected={false}
                  onClick={() => {
                    close();
                    setQuery("");
                    onPick(option.label);
                  }}
                  className="flex items-baseline justify-between gap-2 rounded-card px-2 py-1.5 text-left transition-colors duration-150 ease-out hover:bg-black/[0.05] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"
                >
                  <span className="truncate font-mono text-[12px] text-ink">
                    {option.label}
                  </span>
                  <span className="shrink-0 text-[10.5px] text-ink-4">
                    {option.detail}
                  </span>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </Popover>
  );
}

// ── TemplateValueField ──────────────────────────────────────────────────────

const MODE_LABEL: Record<ReturnType<typeof templateValueMode>, string | null> = {
  ref: "ref",
  template: "template",
  literal: null,
  json: "json",
};

export interface TemplateValueFieldProps {
  label: string;
  value: TemplateValue;
  onChange: (value: TemplateValue) => void;
  sources: ReferenceSources;
  expect?: TemplateExpectation;
  placeholder?: string;
  /** Muted line under the field (a schema description, say). */
  hint?: string | undefined;
  required?: boolean;
}

/** One template-aware line field (see the module doc for the typing rules). */
export function TemplateValueField({
  label,
  value,
  onChange,
  sources,
  expect = "any",
  placeholder,
  hint,
  required = false,
}: TemplateValueFieldProps) {
  const hintId = useId();
  const text = templateValueToText(value);
  const mode = templateValueMode(value);
  const modeLabel = MODE_LABEL[mode];

  // Unrepresentable values (nested JSON) are read-only here; the raw-JSON
  // toggle on the form is their editor.
  if (text === null) {
    return (
      <div className="flex flex-col gap-1">
        <FieldLabel label={label} required={required} mode={modeLabel} />
        <p className="truncate rounded-capsule border border-black/10 bg-black/[0.03] px-3 py-2 font-mono text-[12px] text-ink-3">
          {JSON.stringify(value)}
        </p>
        <p className="px-1 text-[11px] text-ink-4">
          Structured value — edit it in the JSON view.
        </p>
      </div>
    );
  }

  const problem =
    mode === "ref" ? scopeRefProblem((value as RefValue).$ref, sources) : null;

  return (
    <div className="flex flex-col gap-1">
      <FieldLabel label={label} required={required} mode={modeLabel} />
      <div className="flex items-center gap-1.5">
        <Input
          label={label}
          srOnlyLabel
          value={text}
          placeholder={placeholder ?? (expect === "any" ? "Value or @reference" : `${expect} or @reference`)}
          error={problem}
          aria-describedby={hint !== undefined ? hintId : undefined}
          className={cn("h-9 text-[13px]", mode !== "literal" && "font-mono text-[12.5px]")}
          onChange={(event) =>
            onChange(textToTemplateValue(event.currentTarget.value, expect))
          }
        />
        <RefPicker
          sources={sources}
          label={`Insert a reference into ${label}`}
          onPick={(token) => onChange(textToTemplateValue(token, expect))}
        />
      </div>
      {hint !== undefined && hint !== "" ? (
        <p id={hintId} className="px-1 text-[11px] leading-snug text-ink-4">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

function FieldLabel({
  label,
  required,
  mode,
}: {
  label: string;
  required: boolean;
  mode: string | null;
}) {
  return (
    <span className="flex items-baseline gap-1.5 px-1">
      <span className="font-mono text-[12px] font-medium text-ink-2">{label}</span>
      {required ? (
        <span className="text-[10.5px] uppercase tracking-wide text-ink-4">
          required
        </span>
      ) : null}
      {mode !== null ? (
        <span className="rounded-capsule bg-black/[0.05] px-1.5 text-[10px] font-medium text-ink-3">
          {mode}
        </span>
      ) : null}
    </span>
  );
}

// ── RefPathField ────────────────────────────────────────────────────────────

export interface RefPathFieldProps {
  label: string;
  /** The bare scope path (no leading "@"). */
  path: string;
  onChange: (path: string) => void;
  sources: ReferenceSources;
  placeholder?: string;
  srOnlyLabel?: boolean;
}

/**
 * A `$ref`-only field (for_each items, condition operands): a mono path input
 * with the same picker, plus instant `scopeRefProblem` feedback.
 */
export function RefPathField({
  label,
  path,
  onChange,
  sources,
  placeholder = "steps.search.result",
  srOnlyLabel = false,
}: RefPathFieldProps) {
  const problem = path.trim() === "" ? null : scopeRefProblem(path, sources);
  return (
    <div className="flex items-start gap-1.5">
      <Input
        label={label}
        srOnlyLabel={srOnlyLabel}
        value={path}
        placeholder={placeholder}
        error={problem}
        className="h-9 font-mono text-[12.5px]"
        onChange={(event) => onChange(event.currentTarget.value.replace(/^@/, ""))}
      />
      <span className={cn("shrink-0", !srOnlyLabel && "mt-[26px]")}>
        <RefPicker
          sources={sources}
          label={`Pick a reference for ${label}`}
          onPick={(token) => onChange(token.replace(/^@/, ""))}
        />
      </span>
    </div>
  );
}
