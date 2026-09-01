/**
 * Per-step "Test step" affordance (tool + infer kinds only — the two the
 * backend's `POST …/steps/:stepId/test` route accepts). Runs the SAVED draft
 * step against a server-completed empty scope and shows the executor's own
 * outcome: a failed EXECUTION is the 200 payload's `failed` arm, rendered
 * inline — only an unattemptable step (invalid draft, untestable kind) is an
 * HTTP error.
 *
 * Side effects are REAL (a tool step calls the live MCP server); the copy
 * owns saying so. `beforeTest` lets the editor flush a pending autosave first
 * so the server tests what the user sees, not the previous save.
 */
import { FlaskConical, Play } from "lucide-react";
import { useState } from "react";
import type { TestWorkflowStepResponse } from "@invisible-string/shared";

import { testWorkflowStep } from "../../lib/pipeline/queries";
import { ApiError } from "../../lib/api-client";
import { cn } from "../../lib/cn";
import { Button } from "../ui/Button";
import { Popover } from "../ui/Popover";
import { Spinner } from "../ui/Spinner";

export interface StepTestPopoverProps {
  workspaceId: string;
  workflowId: string;
  stepId: string;
  /** "tool" | "infer" — shapes the disclaimer copy. */
  kind: "tool" | "infer";
  /** Flush pending autosave so the server tests the on-screen draft. */
  beforeTest?: (() => Promise<void>) | undefined;
  /** Test seam — defaults to the real endpoint call. */
  testFn?: typeof testWorkflowStep;
}

function previewJson(value: unknown): string {
  try {
    const json = JSON.stringify(value, null, 2) ?? "null";
    return json.length > 4000 ? `${json.slice(0, 4000)}\n…` : json;
  } catch {
    return "(unserializable)";
  }
}

export function StepTestPopover(props: StepTestPopoverProps) {
  return (
    <Popover
      label="Test this step"
      align="end"
      className="w-96"
      trigger={
        <Button variant="ghost" size="sm">
          <FlaskConical size={13} aria-hidden="true" /> Test step
        </Button>
      }
    >
      <StepTestBody {...props} />
    </Popover>
  );
}

function StepTestBody({
  workspaceId,
  workflowId,
  stepId,
  kind,
  beforeTest,
  testFn = testWorkflowStep,
}: StepTestPopoverProps) {
  const [pending, setPending] = useState(false);
  const [requestError, setRequestError] = useState<string | null>(null);
  const [result, setResult] = useState<TestWorkflowStepResponse | null>(null);

  async function run() {
    setPending(true);
    setRequestError(null);
    setResult(null);
    try {
      await beforeTest?.();
      setResult(await testFn(workspaceId, workflowId, stepId, {}));
    } catch (cause) {
      setRequestError(
        cause instanceof ApiError
          ? cause.message
          : "Could not test this step. Try again.",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <div className="flex flex-col gap-2.5" data-testid="step-test">
      <p className="text-[13px] font-semibold text-ink">Test this step</p>
      <p className="text-[12px] leading-relaxed text-ink-3">
        {kind === "tool"
          ? "Calls the real tool on the live connection — side effects actually happen."
          : "Runs the prompt against the real model on the workspace preset."}{" "}
        Earlier steps aren't run: their <code className="mono-chip">@steps</code>{" "}
        outputs resolve empty.
      </p>

      {requestError !== null ? (
        <p role="alert" className="text-[12px] leading-snug text-err">
          {requestError}
        </p>
      ) : null}

      {result !== null ? (
        <div
          data-testid="step-test-result"
          className={cn(
            "flex flex-col gap-1.5 rounded-card border px-3 py-2.5",
            result.status === "succeeded"
              ? "border-ok/30 bg-ok/[0.05]"
              : "border-err/30 bg-err/[0.05]",
          )}
        >
          <p className="text-[12.5px] font-medium text-ink">
            {result.status === "succeeded"
              ? `Succeeded in ${result.durationMs}ms`
              : `Failed (${result.errorClass}) in ${result.durationMs}ms`}
          </p>
          {result.status === "failed" ? (
            <p className="text-[12px] leading-snug text-ink-2">{result.error}</p>
          ) : (
            <pre className="thin-scroll max-h-56 overflow-auto rounded-card bg-black/[0.04] p-2 font-mono text-[11px] leading-snug text-ink-2">
              {previewJson(result.output)}
            </pre>
          )}
        </div>
      ) : null}

      <Button
        size="sm"
        className="self-end"
        disabled={pending}
        onClick={() => void run()}
      >
        {pending ? <Spinner size={13} /> : <Play size={13} aria-hidden="true" />}
        Run test
      </Button>
    </div>
  );
}
