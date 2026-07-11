/**
 * INSTRUCTIONS section editor: the CodeMirror surface plus a reference
 * legend. Reference sources arrive from the builder controller — trigger
 * fields from the live draft, connections/skills from the SELECTED AGENT's
 * attached context — so `@` autocomplete and the amber unresolved-underlines
 * reflect exactly what dispatch will resolve.
 */
import { AtSign } from "lucide-react";
import { lazy, Suspense } from "react";
import type { WorkflowConfig } from "@invisible-string/shared";

import type { ReferenceSources } from "../../lib/builder/references";
import { Spinner } from "../ui/Spinner";

// CodeMirror is heavy — only pull it in when the editor actually renders.
const InstructionsEditor = lazy(() =>
  import("./InstructionsEditor").then((module) => ({
    default: module.InstructionsEditor,
  })),
);

export interface InstructionsPanelProps {
  definition: WorkflowConfig;
  onChange: (markdown: string) => void;
  /** Resolved by the controller (trigger draft + selected agent's context). */
  sources: ReferenceSources;
}

export function InstructionsPanel({
  definition,
  onChange,
  sources,
}: InstructionsPanelProps) {
  return (
    <div className="flex flex-col gap-3">
      <Suspense
        fallback={
          <div className="flex min-h-72 items-center justify-center rounded-card border border-black/10 bg-white/45">
            <Spinner size={18} className="text-ink-4" />
          </div>
        }
      >
        <InstructionsEditor
          value={definition.instructions.markdown}
          onChange={onChange}
          sources={sources}
        />
      </Suspense>
      <div className="flex items-center gap-2 px-0.5 text-[12px] text-ink-3">
        <AtSign size={13} aria-hidden="true" />
        <span>
          Type <code className="mono-chip">@</code> to reference{" "}
          <code className="mono-chip">@trigger.*</code> fields plus the
          selected agent&apos;s connections and{" "}
          <code className="mono-chip">@skill.*</code>. Unresolved references
          are underlined amber.
        </span>
      </div>
    </div>
  );
}
