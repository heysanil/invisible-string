/**
 * A hairline "something happened to this thread's memory" marker, rendered
 * between runs. Used for the eve 0.31 context controls: Clear drops the
 * agent's durable model history, Compact summarizes it. Neither is an error
 * and neither removes anything the user can see, so it is pure neutral ink —
 * a rule with a caption, never a banner.
 */
import { Eraser, Layers } from "lucide-react";

export type ContextMarkerKind = "cleared" | "compacted";

const MARKER: Record<
  ContextMarkerKind,
  { icon: typeof Eraser; label: string; detail: string }
> = {
  cleared: {
    icon: Eraser,
    label: "Context cleared",
    detail: "The agent no longer remembers the messages above.",
  },
  compacted: {
    icon: Layers,
    label: "Context compacted",
    detail: "Earlier messages were summarized to free up room.",
  },
};

export function ContextDivider({ kind }: { kind: ContextMarkerKind }) {
  const { icon: Icon, label, detail } = MARKER[kind];
  return (
    <div className="my-2 flex items-center gap-2.5" role="note">
      <span className="h-px flex-1 bg-black/[0.08]" aria-hidden="true" />
      <span className="inline-flex items-center gap-1.5 whitespace-nowrap text-[11.5px] text-ink-4">
        <Icon size={12} strokeWidth={2} aria-hidden="true" />
        <span className="font-medium text-ink-3">{label}</span>
        <span className="hidden sm:inline">· {detail}</span>
      </span>
      <span className="h-px flex-1 bg-black/[0.08]" aria-hidden="true" />
    </div>
  );
}
