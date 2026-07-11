/**
 * Header "Run" affordance — fires the workflow through the REAL trigger path
 * (`POST /workspaces/:id/workflows/:wfId/run` → dispatchTriggerRun, same as
 * live ingress) so a test run proves exactly what production dispatch does.
 *
 * The popover body adapts to the draft's trigger type:
 * - manual / slack → a message textarea;
 * - form           → the designed field schema rendered as real inputs;
 * - webhook        → a JSON payload textarea;
 * - schedule       → "Fire now" only (schedules carry no payload).
 *
 * Runs dispatch the PUBLISHED snapshot — a dirty or never-published draft
 * gets an inline "Publish first" note with a publish capsule instead of a
 * submit that would silently run stale config.
 */
import { Link } from "@tanstack/react-router";
import { Check, ExternalLink, Play, Rocket } from "lucide-react";
import { useState } from "react";
import { z } from "zod";
import type { FormField, TriggerConfig } from "@invisible-string/shared";

import { api, ApiError } from "../../lib/api-client";
import { cn } from "../../lib/cn";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Popover } from "../ui/Popover";
import { Select } from "../ui/Select";
import { Spinner } from "../ui/Spinner";
import { Switch } from "../ui/Switch";
import { Textarea } from "../ui/Textarea";
import { useToast } from "../ui/Toast";

// ── endpoint (Stage-3 route: POST .../workflows/:wfId/run) ──────────────────

const runWorkflowResponseSchema = z.object({
  runId: z.string().min(1),
  sessionId: z.string().min(1),
});
export type RunWorkflowResponse = z.infer<typeof runWorkflowResponseSchema>;

export interface RunWorkflowBody {
  message?: string;
  data?: Record<string, unknown>;
}

export function runWorkflow(
  workspaceId: string,
  workflowId: string,
  body: RunWorkflowBody,
): Promise<RunWorkflowResponse> {
  return api.post(
    `/workspaces/${workspaceId}/workflows/${workflowId}/run`,
    runWorkflowResponseSchema,
    { body },
  );
}

// ── component ────────────────────────────────────────────────────────────────

export interface TestRunPopoverProps {
  workspaceId: string;
  workflowId: string;
  /** The DRAFT trigger config (shapes the popover body). */
  trigger: TriggerConfig;
  /** Whether a published snapshot exists (runs dispatch that snapshot). */
  isPublished: boolean;
  /** Unsaved/unpublished edits — offer publish-first instead of a stale run. */
  isDirty: boolean;
  canPublish: boolean;
  publishPending: boolean;
  onPublish: () => void | Promise<unknown>;
  /** Test seam — defaults to the real endpoint call. */
  runFn?: typeof runWorkflow;
}

export function TestRunPopover(props: TestRunPopoverProps) {
  return (
    <Popover
      label="Run this workflow"
      align="end"
      className="w-80"
      trigger={
        <Button variant="ghost" size="sm">
          <Play size={14} aria-hidden="true" /> Run
        </Button>
      }
    >
      <TestRunBody {...props} />
    </Popover>
  );
}

function TestRunBody({
  workspaceId,
  workflowId,
  trigger,
  isPublished,
  isDirty,
  canPublish,
  publishPending,
  onPublish,
  runFn = runWorkflow,
}: TestRunPopoverProps) {
  const { toast } = useToast();
  const [message, setMessage] = useState("");
  const [jsonBody, setJsonBody] = useState("{\n}");
  const [fieldValues, setFieldValues] = useState<Record<string, unknown>>({});
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<RunWorkflowResponse | null>(null);

  const needsPublish = !isPublished || isDirty;

  async function submit() {
    setError(null);
    let body: RunWorkflowBody;
    if (trigger.type === "webhook") {
      let data: unknown;
      try {
        data = JSON.parse(jsonBody);
      } catch {
        setError("The payload must be valid JSON.");
        return;
      }
      if (data === null || typeof data !== "object" || Array.isArray(data)) {
        setError("The payload must be a JSON object.");
        return;
      }
      body = { data: data as Record<string, unknown> };
    } else if (trigger.type === "form") {
      body = { data: collectFormData(trigger.fields, fieldValues) };
    } else if (trigger.type === "schedule") {
      body = {};
    } else {
      // manual / slack — a plain message, like chat or a Slack mention.
      const trimmed = message.trim();
      if (trimmed.length === 0) {
        setError("Write a message to start the run with.");
        return;
      }
      body = { message: trimmed };
    }

    setPending(true);
    try {
      const response = await runFn(workspaceId, workflowId, body);
      setStarted(response);
      toast({ variant: "success", message: "Run started — it streams in Chat." });
    } catch (cause) {
      setError(
        cause instanceof ApiError
          ? cause.message
          : "Could not start the run. Try again.",
      );
    } finally {
      setPending(false);
    }
  }

  if (started) {
    return (
      <div className="flex flex-col gap-2.5" data-testid="run-started">
        <div className="flex items-center gap-2">
          <Check size={14} className="text-ok" aria-hidden="true" />
          <p className="text-[13px] font-medium text-ink">Run started</p>
        </div>
        <p className="text-[12.5px] leading-relaxed text-ink-3">
          It's dispatching through the real trigger path — follow it live in
          Chat.
        </p>
        <Link
          to="/chat"
          className="lift inline-flex items-center justify-center gap-1.5 rounded-capsule bg-ink px-4 py-2 text-[13px] font-medium text-white"
        >
          View in Chat <ExternalLink size={12} aria-hidden="true" />
        </Link>
      </div>
    );
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p className="text-[13px] font-semibold text-ink">{runTitle(trigger.type)}</p>

      {needsPublish ? (
        <div
          data-testid="publish-first"
          className="flex flex-col gap-2 rounded-card border border-warn/30 bg-warn/[0.06] px-3 py-2.5"
        >
          <p className="text-[12.5px] leading-snug text-ink-2">
            {isPublished
              ? "You have unpublished changes — runs dispatch the published version."
              : "Publish this workflow first — runs dispatch the published version."}
          </p>
          <Button
            variant="ghost"
            size="sm"
            className="self-start"
            disabled={!canPublish}
            loading={publishPending}
            onClick={() => void onPublish()}
          >
            {!publishPending ? <Rocket size={13} aria-hidden="true" /> : null}
            Publish now
          </Button>
        </div>
      ) : null}

      {trigger.type === "manual" || trigger.type === "slack" ? (
        <Textarea
          label="Message"
          rows={3}
          placeholder={
            trigger.type === "slack"
              ? "The message a Slack mention would carry…"
              : "What should this run work on?"
          }
          value={message}
          onChange={(event) => setMessage(event.currentTarget.value)}
        />
      ) : null}

      {trigger.type === "form" ? (
        <div className="flex flex-col gap-2.5">
          {trigger.fields.length === 0 ? (
            <p className="rounded-card border border-dashed border-black/15 px-3 py-4 text-center text-[12.5px] text-ink-4">
              The form has no fields yet — add some in the Trigger section.
            </p>
          ) : (
            trigger.fields.map((field) => (
              <FormFieldInput
                key={field.key}
                field={field}
                value={fieldValues[field.key]}
                onChange={(value) =>
                  setFieldValues((current) => ({ ...current, [field.key]: value }))
                }
              />
            ))
          )}
        </div>
      ) : null}

      {trigger.type === "webhook" ? (
        <Textarea
          label="JSON payload"
          rows={5}
          className="font-mono text-[12px]"
          value={jsonBody}
          onChange={(event) => setJsonBody(event.currentTarget.value)}
          hint="Every top-level field is addressable as @trigger.<key>."
        />
      ) : null}

      {trigger.type === "schedule" ? (
        <p className="text-[12.5px] leading-relaxed text-ink-3">
          Schedules carry no payload — firing now runs the instructions exactly
          as the ticker would.
        </p>
      ) : null}

      {error ? (
        <p role="alert" className="text-[12px] leading-snug text-err">
          {error}
        </p>
      ) : null}

      <Button
        type="submit"
        size="sm"
        disabled={needsPublish || pending}
        className={cn("self-end", pending && "opacity-70")}
      >
        {pending ? <Spinner size={13} /> : <Play size={13} aria-hidden="true" />}
        {trigger.type === "schedule" ? "Fire now" : "Start run"}
      </Button>
    </form>
  );
}

// ── helpers ──────────────────────────────────────────────────────────────────

function runTitle(type: TriggerConfig["type"]): string {
  switch (type) {
    case "manual":
      return "Start a run";
    case "form":
      return "Submit the form";
    case "webhook":
      return "Send a test payload";
    case "slack":
      return "Simulate a Slack message";
    case "schedule":
      return "Fire the schedule";
  }
}

/** Coerce the field inputs into the trigger-data record dispatch renders. */
export function collectFormData(
  fields: readonly FormField[],
  values: Record<string, unknown>,
): Record<string, unknown> {
  const data: Record<string, unknown> = {};
  for (const field of fields) {
    const raw = values[field.key];
    if (field.type === "checkbox") {
      data[field.key] = raw === true;
      continue;
    }
    if (raw === undefined || raw === "") continue;
    data[field.key] = field.type === "number" ? Number(raw) : raw;
  }
  return data;
}

function FormFieldInput({
  field,
  value,
  onChange,
}: {
  field: FormField;
  value: unknown;
  onChange: (value: unknown) => void;
}) {
  const label = field.label.trim().length > 0 ? field.label : field.key;
  switch (field.type) {
    case "textarea":
      return (
        <Textarea
          label={label}
          rows={3}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      );
    case "select":
      return (
        <Select
          label={label}
          value={typeof value === "string" ? value : ""}
          options={[
            { value: "", label: "Choose…" },
            ...(field.options ?? []).map((option) => ({
              value: option,
              label: option,
            })),
          ]}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      );
    case "checkbox":
      return (
        <label className="flex items-center justify-between gap-3 rounded-card border border-black/[0.07] bg-white/40 px-3 py-2.5 text-[13px] text-ink-2">
          {label}
          <Switch
            label={label}
            checked={value === true}
            onChange={(checked) => onChange(checked)}
          />
        </label>
      );
    case "number":
      return (
        <Input
          label={label}
          type="number"
          value={typeof value === "string" || typeof value === "number" ? String(value) : ""}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      );
    case "date":
      return (
        <Input
          label={label}
          type="date"
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      );
    default:
      return (
        <Input
          label={label}
          value={typeof value === "string" ? value : ""}
          onChange={(event) => onChange(event.currentTarget.value)}
        />
      );
  }
}
