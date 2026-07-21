import { AlertTriangle, Info } from "lucide-react";

import type { BuilderDiagnostic } from "../../lib/builder/diagnostics";
import { cn } from "../../lib/cn";

/**
 * Inline list of a section's diagnostics, shown atop its editor body.
 * When `onAskCopilot` is provided, a subtle "✦ ask copilot to fix" affordance
 * pre-fills the copilot composer with the issue list.
 */
export function DiagnosticsList({
  diagnostics,
  onAskCopilot,
}: {
  diagnostics: readonly BuilderDiagnostic[];
  onAskCopilot?: (prompt: string) => void;
}) {
  if (diagnostics.length === 0) return null;
  const count = diagnostics.length;
  return (
    <ul className="flex flex-col gap-1.5">
      {diagnostics.map((diagnostic, index) => {
        const isError = diagnostic.severity === "error";
        const Icon = isError ? AlertTriangle : Info;
        return (
          <li
            key={index}
            className={cn(
              "flex items-start gap-2 rounded-card border px-3 py-2 text-[12.5px] leading-snug",
              isError
                ? "border-err/25 bg-err/[0.05] text-ink-2"
                : "border-warn/30 bg-warn/[0.06] text-ink-2",
            )}
          >
            <Icon
              size={14}
              aria-hidden="true"
              className={cn("mt-0.5 shrink-0", isError ? "text-err" : "text-warn")}
            />
            <span>{diagnostic.message}</span>
          </li>
        );
      })}
      {onAskCopilot ? (
        <li className="flex justify-end">
          <button
            type="button"
            onClick={() =>
              onAskCopilot(
                `Fix ${count === 1 ? "this issue" : `these ${count} issues`}: ${diagnostics
                  .map((d) => d.message)
                  .join("; ")}`,
              )
            }
            className="lift inline-flex items-center gap-1 rounded-capsule px-2 py-1 text-[11.5px] font-medium text-ink-3 hover:bg-black/[0.04] hover:text-ink"
          >
            ✦ {count} issue{count === 1 ? "" : "s"} — ask copilot to fix
          </button>
        </li>
      ) : null}
    </ul>
  );
}
