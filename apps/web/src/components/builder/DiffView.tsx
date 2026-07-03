/**
 * Inline instructions diff — monospace lines with a +/− gutter glyph
 * (add/del/same get a non-color, non-background cue), additions as ink on
 * 8%-black, removals struck through, unchanged runs collapsed to a
 * "⋯ n unchanged" spacer. Purpose-built for suggestion-card previews (no
 * heavy dep).
 */
import { useMemo } from "react";

import { collapseContext, diffLines } from "../../lib/copilot/diff";
import { cn } from "../../lib/cn";

const GUTTER: Record<"add" | "del" | "same", string> = {
  add: "+",
  del: "−",
  same: " ",
};

export function DiffView({ before, after }: { before: string; after: string }) {
  const rows = useMemo(
    () => collapseContext(diffLines(before, after)),
    [before, after],
  );

  return (
    <div
      data-testid="diff-view"
      className="thin-scroll max-h-56 overflow-auto rounded-card border border-black/[0.07] bg-white/45 p-2 font-mono text-[11.5px] leading-relaxed"
    >
      {rows.map((row, index) =>
        row.kind === "gap" ? (
          <div
            key={index}
            aria-hidden="true"
            className="select-none px-1.5 py-0.5 text-[11px] text-ink-3"
          >
            ⋯ {row.count} unchanged line{row.count === 1 ? "" : "s"}
          </div>
        ) : (
          <div
            key={index}
            data-diff={row.kind}
            className={cn(
              "flex items-start rounded-[4px] px-1.5",
              row.kind === "add" && "bg-black/[0.08] text-ink",
              row.kind === "del" && "text-ink-3",
              row.kind === "same" && "text-ink-2",
            )}
          >
            <span
              aria-hidden="true"
              className="w-3 shrink-0 select-none whitespace-pre"
            >
              {GUTTER[row.kind]}
            </span>
            <span
              className={cn(
                "min-w-0 flex-1 whitespace-pre-wrap break-words",
                row.kind === "del" && "line-through decoration-ink-3/60",
              )}
            >
              {row.text === "" ? " " : row.text}
            </span>
          </div>
        ),
      )}
    </div>
  );
}
