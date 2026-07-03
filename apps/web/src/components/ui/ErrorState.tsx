import { AlertCircle } from "lucide-react";

import { Button } from "./Button";

export interface ErrorStateProps {
  title?: string;
  message: string;
  onRetry?: () => void;
  /** Compact inline variant (fits inside a card/list). */
  compact?: boolean;
}

/** Designed error surface — never a blank pane when a query fails. */
export function ErrorState({ title, message, onRetry, compact = false }: ErrorStateProps) {
  return (
    <div
      role="alert"
      className={
        compact
          ? "flex flex-col items-center gap-2 px-4 py-6 text-center"
          : "flex h-full min-h-56 flex-col items-center justify-center gap-4 p-10 text-center"
      }
    >
      <div className="flex size-11 items-center justify-center rounded-full bg-err/10 text-err">
        <AlertCircle size={20} strokeWidth={1.9} aria-hidden="true" />
      </div>
      <div className="flex max-w-sm flex-col gap-1">
        <p className="text-[14px] font-semibold text-ink">
          {title ?? "Something went wrong"}
        </p>
        <p className="text-[13px] leading-relaxed text-ink-3">{message}</p>
      </div>
      {onRetry ? (
        <Button variant="ghost" size="sm" onClick={onRetry}>
          Try again
        </Button>
      ) : null}
    </div>
  );
}
