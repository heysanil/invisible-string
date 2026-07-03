import { AlertTriangle, Info } from "lucide-react";

import type { PillarDiagnostic } from "../../lib/builder/diagnostics";
import { cn } from "../../lib/cn";

/** Inline list of a pillar's diagnostics, shown atop its focused editor. */
export function DiagnosticsList({
  diagnostics,
}: {
  diagnostics: readonly PillarDiagnostic[];
}) {
  if (diagnostics.length === 0) return null;
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
    </ul>
  );
}
