/**
 * STATE step inspector: the `set` record as key → value rows. Values are
 * template-aware (`@state.cursor`-style refs and templates — fields.tsx);
 * keys share the slug charset (they become `@state.<key>` handles). Writes
 * are write-only by design — reading back is a `$ref`, and that asymmetry is
 * spelled out in the footer copy.
 */
import { useState } from "react";
import { Plus, Trash2 } from "lucide-react";
import { STEP_SLUG_PATTERN, type StateStep, type TemplateValue } from "@invisible-string/shared";

import type { StepParamsPatch } from "../../../lib/builder/model";
import type { ReferenceSources } from "../../../lib/builder/references";
import { Input } from "../../ui/Input";
import { TemplateValueField } from "./fields";

export interface StateStepFormProps {
  step: StateStep;
  sources: ReferenceSources;
  onPatch: (patch: StepParamsPatch) => void;
}

export function StateStepForm({ step, sources, onPatch }: StateStepFormProps) {
  const [newKey, setNewKey] = useState("");
  const keys = Object.keys(step.set);
  const trimmed = newKey.trim();
  const newKeyProblem =
    trimmed === ""
      ? null
      : !STEP_SLUG_PATTERN.test(trimmed)
        ? "Keys start with a letter and use letters, digits, _ or -."
        : trimmed in step.set
          ? "That key is already set."
          : null;

  const setValue = (key: string, value: TemplateValue) => {
    onPatch({ set: { ...step.set, [key]: value } });
  };

  return (
    <div className="flex flex-col gap-3">
      {keys.length === 0 ? (
        <p className="rounded-card border border-dashed border-black/15 px-3 py-3 text-center text-[12px] text-ink-4">
          No keys yet — add one, e.g. <code className="mono-chip">cursor</code>.
        </p>
      ) : (
        <div className="flex flex-col gap-2.5">
          {keys.map((key) => (
            <div key={key} className="flex items-end gap-1.5">
              <div className="min-w-0 flex-1">
                <TemplateValueField
                  label={key}
                  value={step.set[key] ?? ""}
                  sources={sources}
                  placeholder="value or @reference"
                  onChange={(value) => setValue(key, value)}
                />
              </div>
              <button
                type="button"
                aria-label={`Remove key ${key}`}
                onClick={() => {
                  const { [key]: _removed, ...rest } = step.set;
                  onPatch({ set: rest });
                }}
                className="lift mb-1 flex size-7 shrink-0 items-center justify-center rounded-full text-ink-4 hover:bg-err/10 hover:text-err"
              >
                <Trash2 size={12} aria-hidden="true" />
              </button>
            </div>
          ))}
        </div>
      )}

      <form
        className="flex items-start gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          if (trimmed === "" || newKeyProblem !== null) return;
          setValue(trimmed, "");
          setNewKey("");
        }}
      >
        <div className="min-w-0 flex-1">
          <Input
            label="New key"
            srOnlyLabel
            placeholder="Add a key… (e.g. cursor)"
            value={newKey}
            error={newKeyProblem}
            className="h-8 font-mono text-[12px]"
            onChange={(event) => setNewKey(event.currentTarget.value)}
          />
        </div>
        <button
          type="submit"
          disabled={trimmed === "" || newKeyProblem !== null}
          className="lift flex h-8 shrink-0 items-center gap-1 rounded-capsule border border-black/10 bg-white/60 px-2.5 text-[11.5px] font-medium text-ink-2 hover:text-ink disabled:pointer-events-none disabled:opacity-40"
        >
          <Plus size={11} aria-hidden="true" />
          Add
        </button>
      </form>

      <p className="px-1 text-[11px] leading-snug text-ink-4">
        Keys persist across runs (cursors, dedupe marks). Writing is this step;
        reading back is <code className="mono-chip">@state.&lt;key&gt;</code>{" "}
        anywhere after it.
      </p>
    </div>
  );
}
