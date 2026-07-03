/**
 * TRIGGER focused editor: elegant capsule radio cards for the five trigger
 * types + per-type config forms (form-field designer, webhook token notice,
 * Slack binding, cron with human-readable preview).
 */
import {
  ArrowDown,
  ArrowUp,
  GripVertical,
  Hand,
  Hash,
  KeyRound,
  Plus,
  Timer,
  Trash2,
  Webhook,
} from "lucide-react";
import type { ComponentType } from "react";
import {
  FORM_FIELD_TYPES,
  type FormField,
  type FormFieldType,
  type SlackTriggerBinding,
  type WorkflowDefinition,
} from "@invisible-string/shared";

import { describeCron } from "../../lib/builder/cron";
import {
  FORM_FIELD_TYPE_LABELS,
  TRIGGER_TYPES,
  type BuilderAction,
  type TriggerType,
} from "../../lib/builder/model";
import { cn } from "../../lib/cn";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";
import { StatusChip } from "../ui/StatusChip";
import { Switch } from "../ui/Switch";

const TRIGGER_META: Record<
  TriggerType,
  { label: string; description: string; icon: ComponentType<{ size?: number }> }
> = {
  manual: {
    label: "Manual",
    description: "Start runs from chat or the builder.",
    icon: Hand,
  },
  form: {
    label: "Form",
    description: "A shareable form submits fields to each run.",
    icon: KeyRound,
  },
  webhook: {
    label: "Webhook",
    description: "An HTTP POST with a JSON payload starts a run.",
    icon: Webhook,
  },
  slack: {
    label: "Slack",
    description: "Mentions and messages in Slack trigger runs.",
    icon: Hash,
  },
  schedule: {
    label: "Schedule",
    description: "A cron schedule runs the workflow automatically.",
    icon: Timer,
  },
};

export interface TriggerEditorProps {
  definition: WorkflowDefinition;
  dispatch: (action: BuilderAction) => void;
}

export function TriggerEditor({ definition, dispatch }: TriggerEditorProps) {
  const trigger = definition.trigger;
  return (
    <div className="flex flex-col gap-6">
      <fieldset>
        <legend className="mb-3 px-0.5 text-[13px] font-medium text-ink-2">
          Trigger type
        </legend>
        <div
          role="radiogroup"
          aria-label="Trigger type"
          className="grid grid-cols-1 gap-2.5 sm:grid-cols-2"
        >
          {TRIGGER_TYPES.map((type) => {
            const meta = TRIGGER_META[type];
            const Icon = meta.icon;
            const selected = trigger.type === type;
            return (
              <button
                key={type}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() =>
                  dispatch({ type: "setTriggerType", triggerType: type })
                }
                className={cn(
                  "lift flex items-start gap-3 rounded-card-lg border p-3.5 text-left",
                  selected
                    ? "border-ink/80 bg-white shadow-[0_2px_10px_rgba(0,0,0,0.06)]"
                    : "border-black/10 bg-white/40 hover:border-black/20 hover:bg-white/60",
                )}
              >
                <span
                  className={cn(
                    "flex size-9 shrink-0 items-center justify-center rounded-full",
                    selected ? "bg-ink text-white" : "bg-black/[0.05] text-ink-3",
                  )}
                >
                  <Icon size={17} />
                </span>
                <span className="flex min-w-0 flex-col gap-0.5">
                  <span className="text-[13.5px] font-semibold text-ink">
                    {meta.label}
                  </span>
                  <span className="text-[12px] leading-snug text-ink-3">
                    {meta.description}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      </fieldset>

      {trigger.type === "manual" ? (
        <p className="rounded-card border border-black/[0.07] bg-white/40 px-4 py-3 text-[13px] text-ink-3">
          Manual workflows are started from a chat session — no extra
          configuration needed.
        </p>
      ) : null}

      {trigger.type === "form" ? (
        <FormFieldDesigner fields={trigger.fields} dispatch={dispatch} />
      ) : null}

      {trigger.type === "webhook" ? (
        <div className="rounded-card border border-black/[0.07] bg-white/40 px-4 py-3.5">
          <div className="mb-1.5 flex items-center gap-2">
            <KeyRound size={15} className="text-ink-3" aria-hidden="true" />
            <h3 className="text-[13.5px] font-semibold text-ink">
              A signing token is generated at publish
            </h3>
          </div>
          <p className="text-[13px] leading-relaxed text-ink-3">
            Publishing mints a secret webhook URL. The token is shown once and
            stored only as a hash — POST a JSON payload to it and every field is
            addressable as{" "}
            <code className="mono-chip">@trigger.&lt;key&gt;</code> in your
            instructions.
          </p>
        </div>
      ) : null}

      {trigger.type === "slack" ? (
        <SlackBindingForm binding={trigger.binding} dispatch={dispatch} />
      ) : null}

      {trigger.type === "schedule" ? (
        <CronForm cron={trigger.cron} dispatch={dispatch} />
      ) : null}
    </div>
  );
}

// ── Form-field designer ─────────────────────────────────────────────────────

function FormFieldDesigner({
  fields,
  dispatch,
}: {
  fields: readonly FormField[];
  dispatch: (action: BuilderAction) => void;
}) {
  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between px-0.5">
        <h3 className="text-[13px] font-medium text-ink-2">Form fields</h3>
        <Button
          variant="ghost"
          size="sm"
          onClick={() => dispatch({ type: "addFormField" })}
        >
          <Plus size={14} aria-hidden="true" />
          Add field
        </Button>
      </div>

      {fields.length === 0 ? (
        <p className="rounded-card border border-dashed border-black/15 px-4 py-6 text-center text-[13px] text-ink-4">
          Add at least one field so the form can collect input.
        </p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {fields.map((field, index) => (
            <FormFieldRow
              key={index}
              field={field}
              index={index}
              count={fields.length}
              dispatch={dispatch}
            />
          ))}
        </ul>
      )}
    </div>
  );
}

function FormFieldRow({
  field,
  index,
  count,
  dispatch,
}: {
  field: FormField;
  index: number;
  count: number;
  dispatch: (action: BuilderAction) => void;
}) {
  return (
    <li className="rounded-card border border-black/10 bg-white/45 p-3">
      <div className="flex items-start gap-2">
        <span className="mt-2.5 text-ink-4" aria-hidden="true">
          <GripVertical size={15} />
        </span>
        <div className="grid min-w-0 flex-1 grid-cols-1 gap-2.5 sm:grid-cols-[1fr_1fr_auto]">
          <Input
            label="Label"
            srOnlyLabel
            placeholder="Label (e.g. Customer email)"
            value={field.label}
            onChange={(event) =>
              dispatch({
                type: "updateFormField",
                index,
                patch: { label: event.currentTarget.value },
              })
            }
          />
          <Input
            label="Key"
            srOnlyLabel
            placeholder="key"
            value={field.key}
            aria-describedby={`field-${index}-keyhint`}
            className="font-mono text-[12.5px]"
            onChange={(event) =>
              dispatch({
                type: "updateFormField",
                index,
                patch: { key: event.currentTarget.value },
              })
            }
          />
          <Select
            label="Type"
            srOnlyLabel
            value={field.type}
            options={FORM_FIELD_TYPES.map((type: FormFieldType) => ({
              value: type,
              label: FORM_FIELD_TYPE_LABELS[type],
            }))}
            onChange={(event) =>
              dispatch({
                type: "updateFormField",
                index,
                patch: { type: event.currentTarget.value as FormFieldType },
              })
            }
          />
        </div>
      </div>

      {field.type === "select" ? (
        <div className="mt-2.5 pl-7">
          <Input
            label="Options"
            srOnlyLabel
            placeholder="Comma-separated options (e.g. bug, idea, question)"
            value={(field.options ?? []).join(", ")}
            onChange={(event) =>
              dispatch({
                type: "updateFormField",
                index,
                patch: {
                  options: event.currentTarget.value
                    .split(",")
                    .map((option) => option.trim())
                    .filter((option) => option.length > 0),
                },
              })
            }
          />
        </div>
      ) : null}

      <div className="mt-2.5 flex items-center justify-between pl-7">
        <label className="flex items-center gap-2 text-[12.5px] text-ink-2">
          <Switch
            label="Required field"
            checked={field.required}
            onChange={(checked) =>
              dispatch({
                type: "updateFormField",
                index,
                patch: { required: checked },
              })
            }
          />
          Required
        </label>
        <div className="flex items-center gap-0.5">
          <IconButton
            label="Move field up"
            disabled={index === 0}
            onClick={() =>
              dispatch({ type: "moveFormField", index, direction: -1 })
            }
          >
            <ArrowUp size={14} />
          </IconButton>
          <IconButton
            label="Move field down"
            disabled={index === count - 1}
            onClick={() =>
              dispatch({ type: "moveFormField", index, direction: 1 })
            }
          >
            <ArrowDown size={14} />
          </IconButton>
          <IconButton
            label="Remove field"
            tone="danger"
            onClick={() => dispatch({ type: "removeFormField", index })}
          >
            <Trash2 size={14} />
          </IconButton>
        </div>
      </div>
    </li>
  );
}

// ── Slack ───────────────────────────────────────────────────────────────────

function SlackBindingForm({
  binding,
  dispatch,
}: {
  binding: SlackTriggerBinding;
  dispatch: (action: BuilderAction) => void;
}) {
  return (
    <div className="flex flex-col gap-3.5">
      <Input
        label="Channel id (optional)"
        placeholder="C0123456789 — leave blank for any channel"
        value={binding.channelId ?? ""}
        onChange={(event) =>
          dispatch({
            type: "setSlackBinding",
            patch: { channelId: event.currentTarget.value || undefined },
          })
        }
      />
      <ToggleRow
        label="Only @mentions of the app"
        hint="Thread replies always continue the same session."
        checked={binding.mentionOnly}
        onChange={(checked) =>
          dispatch({ type: "setSlackBinding", patch: { mentionOnly: checked } })
        }
      />
      <ToggleRow
        label="Include direct messages"
        hint="Also trigger on DMs sent to the app."
        checked={binding.includeDirectMessages}
        onChange={(checked) =>
          dispatch({
            type: "setSlackBinding",
            patch: { includeDirectMessages: checked },
          })
        }
      />
    </div>
  );
}

// ── Cron ────────────────────────────────────────────────────────────────────

function CronForm({
  cron,
  dispatch,
}: {
  cron: string;
  dispatch: (action: BuilderAction) => void;
}) {
  const human = describeCron(cron);
  return (
    <div className="flex flex-col gap-2.5">
      <Input
        label="Cron expression"
        placeholder="minute hour day-of-month month day-of-week"
        value={cron}
        className="font-mono text-[12.5px]"
        onChange={(event) =>
          dispatch({ type: "setCron", cron: event.currentTarget.value })
        }
      />
      <div className="flex items-center gap-2 px-0.5">
        <StatusChip tone={human ? "success" : "warning"} dot>
          {human ? "Valid" : "Unrecognized"}
        </StatusChip>
        <p className="text-[13px] text-ink-3">
          {human ?? "Five fields expected, e.g. 0 9 * * 1 (09:00 every Monday)."}
        </p>
      </div>
      <p className="px-0.5 text-[12px] text-ink-4">
        Schedules run on the platform clock (UTC). eve validates the exact
        expression at publish.
      </p>
    </div>
  );
}

// ── small shared bits ───────────────────────────────────────────────────────

function ToggleRow({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <div className="flex items-start justify-between gap-4 rounded-card border border-black/[0.07] bg-white/40 px-3.5 py-3">
      <div className="flex min-w-0 flex-col">
        <span className="text-[13.5px] font-medium text-ink">{label}</span>
        <span className="text-[12px] text-ink-3">{hint}</span>
      </div>
      <Switch label={label} checked={checked} onChange={onChange} />
    </div>
  );
}

function IconButton({
  label,
  onClick,
  disabled,
  tone = "default",
  children,
}: {
  label: string;
  onClick: () => void;
  disabled?: boolean;
  tone?: "default" | "danger";
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        "lift flex size-7 items-center justify-center rounded-full text-ink-3",
        "disabled:pointer-events-none disabled:opacity-40",
        tone === "danger"
          ? "hover:bg-err/10 hover:text-err"
          : "hover:bg-black/[0.05] hover:text-ink",
      )}
    >
      {children}
    </button>
  );
}
