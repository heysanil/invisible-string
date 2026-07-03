/**
 * Copilot dock placeholder — collapsed pill reserving the right-rail pattern
 * the Phase-4 copilot will occupy. Expands to a preview of the suggestion
 * surface (non-interactive) so the builder layout already breathes the way
 * the mockups do.
 */
import { ChevronRight, Sparkles } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/cn";

export function CopilotDock() {
  const [expanded, setExpanded] = useState(false);

  if (!expanded) {
    return (
      <button
        type="button"
        onClick={() => setExpanded(true)}
        aria-label="Open Copilot (coming soon)"
        className="glass-panel lift flex h-full w-12 shrink-0 flex-col items-center gap-3 rounded-panel py-4"
      >
        <span className="flex size-8 items-center justify-center rounded-full bg-ink text-white">
          <Sparkles size={15} aria-hidden="true" />
        </span>
        <span
          className="text-[12px] font-medium tracking-tight text-ink-3"
          style={{ writingMode: "vertical-rl" }}
        >
          Copilot · soon
        </span>
      </button>
    );
  }

  return (
    <aside
      aria-label="Copilot"
      className="glass-panel panel-enter flex h-full w-72 shrink-0 flex-col overflow-hidden"
    >
      <header className="flex items-center gap-2 px-4 pb-3 pt-4">
        <span className="flex size-7 items-center justify-center rounded-full bg-ink text-white">
          <Sparkles size={14} aria-hidden="true" />
        </span>
        <h2 className="flex-1 text-[14px] font-semibold">Copilot</h2>
        <button
          type="button"
          onClick={() => setExpanded(false)}
          aria-label="Collapse Copilot"
          className="lift flex size-7 items-center justify-center rounded-full text-ink-3 hover:bg-black/[0.05] hover:text-ink"
        >
          <ChevronRight size={15} aria-hidden="true" />
        </button>
      </header>
      <div aria-hidden="true" className="mx-4 h-px bg-black/[0.06]" />
      <div className="flex flex-1 flex-col items-center justify-center gap-3 p-5 text-center">
        <span className="flex size-11 items-center justify-center rounded-full bg-black/[0.04] text-ink-3">
          <Sparkles size={18} aria-hidden="true" />
        </span>
        <p className="text-[13px] font-medium text-ink">Coming in this build soon</p>
        <p className="text-[12px] leading-relaxed text-ink-3">
          The copilot will scaffold and edit this workflow from a description —
          proposing changes as Apply / Preview cards right here.
        </p>
      </div>
      <div className="p-3">
        <div
          aria-hidden="true"
          className={cn(
            "rounded-card border border-dashed border-black/12 bg-white/30 px-3 py-2.5",
            "text-[12px] text-ink-4",
          )}
        >
          Ask Copilot to change a pillar…
        </div>
      </div>
    </aside>
  );
}
