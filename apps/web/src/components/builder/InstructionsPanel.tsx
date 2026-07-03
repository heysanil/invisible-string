/**
 * INSTRUCTIONS focused editor: the CodeMirror surface plus a reference legend.
 * Reference sources come from the live draft so `@` autocomplete and the
 * amber unresolved-underlines stay in lockstep with the other pillars.
 */
import { AtSign } from "lucide-react";
import { lazy, Suspense, useMemo } from "react";
import type { WorkflowDefinition } from "@invisible-string/shared";

import type { ContextResources } from "../../lib/builder/resources";
import type { ReferenceSources } from "../../lib/builder/references";
import { Spinner } from "../ui/Spinner";

// CodeMirror is heavy — only pull it in when the Instructions pillar opens.
const InstructionsEditor = lazy(() =>
  import("./InstructionsEditor").then((module) => ({
    default: module.InstructionsEditor,
  })),
);

export interface InstructionsPanelProps {
  definition: WorkflowDefinition;
  onChange: (markdown: string) => void;
  resources: ContextResources;
}

export function InstructionsPanel({
  definition,
  onChange,
  resources,
}: InstructionsPanelProps) {
  const sources: ReferenceSources = useMemo(() => {
    const connections = definition.context.mcpConnectionIds
      .map((id) => resources.connectionById.get(id))
      .filter((c): c is NonNullable<typeof c> => c !== undefined)
      .map((c) => ({ name: c.name, description: c.description }));
    const skills = definition.context.skillIds
      .map((id) => resources.skillById.get(id))
      .filter((s): s is NonNullable<typeof s> => s !== undefined)
      .map((s) => ({ name: s.name, description: s.description }));
    return { trigger: definition.trigger, connections, skills };
  }, [
    definition.trigger,
    definition.context.mcpConnectionIds,
    definition.context.skillIds,
    resources.connectionById,
    resources.skillById,
  ]);

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
          <code className="mono-chip">@trigger.*</code> fields, connections, and{" "}
          <code className="mono-chip">@skill.*</code>. Unresolved references are
          underlined amber.
        </span>
      </div>
    </div>
  );
}
