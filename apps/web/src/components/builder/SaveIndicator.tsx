/**
 * Autosave status line shared by the workflow and agent editor headers:
 * Saving… spinner → Saved (with issue count when the validator flagged the
 * draft) → Save failed. Pure presentation — both controllers feed it the
 * same `SaveStatus` + dirty/issue signals.
 */
import { Check, CircleAlert } from "lucide-react";

import type { SaveStatus } from "../../lib/builder/useBuilderController";
import { Spinner } from "../ui/Spinner";
import { cn } from "../../lib/cn";

export interface SaveIndicatorProps {
  status: SaveStatus;
  issueCount: number;
  isDirty: boolean;
}

export function SaveIndicator({ status, issueCount, isDirty }: SaveIndicatorProps) {
  if (status === "saving" || (isDirty && status !== "error")) {
    return (
      <span className="flex items-center gap-1.5 text-[12.5px] text-ink-3">
        <Spinner size={12} /> Saving…
      </span>
    );
  }
  if (status === "error") {
    return (
      <span className="flex items-center gap-1.5 text-[12.5px] text-err">
        <CircleAlert size={13} aria-hidden="true" /> Save failed
      </span>
    );
  }
  if (status === "saved") {
    return issueCount > 0 ? (
      <span className="flex items-center gap-1.5 text-[12.5px] text-warn">
        <CircleAlert size={13} aria-hidden="true" />
        {issueCount} issue{issueCount === 1 ? "" : "s"}
      </span>
    ) : (
      <span className="flex items-center gap-1.5 text-[12.5px] text-ink-3">
        <Check size={13} className="text-ok" aria-hidden="true" /> Saved
      </span>
    );
  }
  return <span className={cn("text-[12.5px] text-ink-4")}>All changes saved</span>;
}
