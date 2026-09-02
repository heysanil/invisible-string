/**
 * Inspectors for the control verbs. The step BODIES (a loop's steps, a
 * branch's lanes) are edited on the STRIP — these forms own only the verbs'
 * own parameters: the items reference, conditions, error policy, lane
 * add/remove and the else toggle.
 */
import { Plus, Trash2 } from "lucide-react";
import {
  MAX_FOR_EACH_ITEMS,
  type BranchStep,
  type FilterStep,
  type ForEachStep,
} from "@invisible-string/shared";

import type { StepParamsPatch } from "../../../lib/builder/model";
import type { ReferenceSources } from "../../../lib/builder/references";
import { Input } from "../../ui/Input";
import { Select } from "../../ui/Select";
import { Switch } from "../../ui/Switch";
import { ConditionEditor } from "./ConditionEditor";
import { RefPathField } from "./fields";

// ── for_each ────────────────────────────────────────────────────────────────

export interface ForEachStepFormProps {
  step: ForEachStep;
  sources: ReferenceSources;
  onPatch: (patch: StepParamsPatch) => void;
}

export function ForEachStepForm({ step, sources, onPatch }: ForEachStepFormProps) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1">
        <span className="px-1 text-[13px] font-medium text-ink-2">Items</span>
        <RefPathField
          label="Items reference"
          srOnlyLabel
          path={step.items.$ref}
          sources={sources}
          placeholder="steps.search.result.messages"
          onChange={(path) => onPatch({ items: { $ref: path } })}
        />
        <p className="px-1 text-[11px] leading-snug text-ink-4">
          Must resolve to a list at run time; the steps inside run once per
          item, in order, and each sees it as <code className="mono-chip">@item</code>.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <Input
          label="Max items"
          type="number"
          min={1}
          max={MAX_FOR_EACH_ITEMS}
          value={String(step.maxItems)}
          onChange={(event) => {
            const parsed = Number(event.currentTarget.value);
            if (!Number.isInteger(parsed)) return;
            onPatch({
              maxItems: Math.max(1, Math.min(MAX_FOR_EACH_ITEMS, parsed)),
            });
          }}
        />
        <Select
          label="If an item fails"
          value={step.onItemError}
          options={[
            { value: "halt", label: "Halt the run" },
            { value: "continue", label: "Continue with the rest" },
          ]}
          onChange={(event) =>
            onPatch({
              onItemError: event.currentTarget.value as ForEachStep["onItemError"],
            })
          }
        />
      </div>
      <p className="px-1 text-[11px] leading-snug text-ink-4">
        More items than the cap fails the loop — nothing is silently dropped.
        The loop's steps live on the strip, under this card.
      </p>
    </div>
  );
}

// ── branch ──────────────────────────────────────────────────────────────────

export interface BranchStepFormProps {
  step: BranchStep;
  sources: ReferenceSources;
  onPatch: (patch: StepParamsPatch) => void;
}

export function BranchStepForm({ step, sources, onPatch }: BranchStepFormProps) {
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-3">
        {step.branches.map((branch, index) => (
          <div
            key={index}
            className="flex flex-col gap-2 rounded-card border border-black/[0.07] bg-white/40 p-3"
          >
            <div className="flex items-center justify-between">
              <span className="rounded-capsule bg-black/[0.05] px-2 py-0.5 text-[10.5px] font-medium uppercase tracking-wide text-ink-3">
                {index === 0 ? "When" : `Or when`}
              </span>
              {step.branches.length > 1 ? (
                <button
                  type="button"
                  aria-label={`Remove branch ${index + 1}`}
                  onClick={() =>
                    onPatch({
                      branches: step.branches.filter((_lane, i) => i !== index),
                    })
                  }
                  className="lift flex size-6 items-center justify-center rounded-full text-ink-4 hover:bg-err/10 hover:text-err"
                >
                  <Trash2 size={11} aria-hidden="true" />
                </button>
              ) : null}
            </div>
            <ConditionEditor
              label={`Branch ${index + 1} condition`}
              value={branch.when}
              sources={sources}
              onChange={(when) =>
                onPatch({
                  branches: step.branches.map((lane, i) =>
                    i === index ? { ...lane, when } : lane,
                  ),
                })
              }
            />
          </div>
        ))}
        <button
          type="button"
          onClick={() =>
            onPatch({
              branches: [
                ...step.branches,
                { when: { truthy: { $ref: "" } }, steps: [] },
              ],
            })
          }
          className="lift flex w-fit items-center gap-1.5 rounded-capsule border border-black/10 bg-white/50 px-2.5 py-1 text-[11.5px] font-medium text-ink-2 hover:text-ink"
        >
          <Plus size={11} aria-hidden="true" />
          Add branch
        </button>
      </div>

      <label className="flex items-start justify-between gap-4 rounded-card border border-black/[0.07] bg-white/40 px-3.5 py-3">
        <span className="flex min-w-0 flex-col">
          <span className="text-[13px] font-medium text-ink">Else lane</span>
          <span className="text-[11.5px] leading-snug text-ink-3">
            Steps to run when no condition holds. Removing it discards its
            steps.
          </span>
        </span>
        <Switch
          label="Else lane"
          checked={step.else !== undefined}
          onChange={(checked) =>
            // StepParamsPatch merges shallowly, so `else: undefined` clears it
            // (the config serializer drops undefined keys).
            onPatch(checked ? { else: [] } : { else: undefined })
          }
        />
      </label>
      <p className="px-1 text-[11px] leading-snug text-ink-4">
        The first matching lane runs. Lane steps live on the strip, under this
        card.
      </p>
    </div>
  );
}

// ── filter ──────────────────────────────────────────────────────────────────

export interface FilterStepFormProps {
  step: FilterStep;
  sources: ReferenceSources;
  onPatch: (patch: StepParamsPatch) => void;
}

export function FilterStepForm({ step, sources, onPatch }: FilterStepFormProps) {
  return (
    <div className="flex flex-col gap-2">
      <span className="px-1 text-[13px] font-medium text-ink-2">
        Continue when
      </span>
      <ConditionEditor
        label="Filter condition"
        value={step.where}
        sources={sources}
        onChange={(where) => onPatch({ where })}
      />
      <p className="px-1 text-[11px] leading-snug text-ink-4">
        False at the top level skips every remaining step (the run still
        succeeds); inside a loop it drops the current item.
      </p>
    </div>
  );
}
