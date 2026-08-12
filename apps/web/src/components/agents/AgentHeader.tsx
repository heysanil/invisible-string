/**
 * Agent editor header panel: back arrow, inline-editable name
 * (commit-on-blur/Enter, Escape restores), save indicator, and the
 * admin-gated Delete affordance. Presentational — the live screen persists
 * renames through the agent PATCH; the fixture editor commits locally.
 *
 * The input is stateful but NOT independent of the row: this is not the only
 * writer of `agents.name`. The copilot's `setName` card commits through the
 * same PATCH seam (spec D7.3), so the prop can move underneath a mounted
 * header — and a header that ignored that would go on displaying the old name
 * and offer it back as the baseline for the next edit. Every observed CHANGE
 * of the prop is therefore adopted; an unchanged prop (a refetch of the same
 * row) never disturbs what the user is typing.
 */
import { Link } from "@tanstack/react-router";
import { ArrowLeft, Trash2 } from "lucide-react";
import { useRef, useState } from "react";

import type { SaveStatus } from "../../lib/agents/useAgentController";
import { SaveIndicator } from "../builder/SaveIndicator";
import { Button } from "../ui/Button";
import { Panel } from "../ui/Panel";

// Satisfies React's controlled-input contract; the real handler rides
// onInput, matching the shared Input primitive (React's onChange for text
// inputs never fires under happy-dom).
function noopChange() {}

export interface AgentHeaderProps {
  name: string;
  /**
   * Persist a committed rename; resolve false to roll the input back (e.g.
   * the PATCH failed).
   */
  onCommitName: (name: string) => boolean | Promise<boolean>;
  saveStatus: SaveStatus;
  issueCount: number;
  isDirty: boolean;
  /** Present only for admins/owners — renders the Delete affordance. */
  onRequestDelete?: (() => void) | undefined;
}

export function AgentHeader({
  name: initialName,
  onCommitName,
  saveStatus,
  issueCount,
  isDirty,
  onRequestDelete,
}: AgentHeaderProps) {
  const [name, setName] = useState(initialName);
  const committed = useRef(initialName);
  // Escape restores THEN blurs, and React dispatches the blur handler
  // synchronously — before the queued setState flushes. The commit must read
  // the restored value, so the live value rides a ref updated in the same
  // tick as every setName.
  const liveName = useRef(initialName);
  // The last prop value we adopted (see the module header). Compared during
  // render rather than in an effect so the input never paints a stale name
  // for a frame.
  const adoptedProp = useRef(initialName);

  if (initialName !== adoptedProp.current) {
    adoptedProp.current = initialName;
    committed.current = initialName;
    liveName.current = initialName;
    setName(initialName);
  }

  function updateName(next: string) {
    liveName.current = next;
    setName(next);
  }

  async function commitName() {
    const trimmed = liveName.current.trim();
    if (trimmed === "" || trimmed === committed.current) {
      updateName(committed.current);
      return;
    }
    const previous = committed.current;
    committed.current = trimmed;
    updateName(trimmed);
    const ok = await onCommitName(trimmed);
    if (!ok) {
      committed.current = previous;
      updateName(previous);
    }
  }

  return (
    <Panel className="panel-enter flex items-center gap-3 px-4 py-2.5">
      <Link
        to="/agents"
        aria-label="Back to agents"
        className="lift flex size-8 shrink-0 items-center justify-center rounded-full text-ink-3 hover:bg-black/[0.05] hover:text-ink"
      >
        <ArrowLeft size={16} aria-hidden="true" />
      </Link>
      <input
        value={name}
        aria-label="Agent name"
        onChange={noopChange}
        onInput={(event) => updateName((event.target as HTMLInputElement).value)}
        onBlur={commitName}
        onKeyDown={(event) => {
          if (event.key === "Enter") event.currentTarget.blur();
          if (event.key === "Escape") {
            updateName(committed.current);
            event.currentTarget.blur();
          }
        }}
        className="min-w-0 flex-1 rounded-card bg-transparent px-2 py-1 text-[15px] font-semibold text-ink outline-none hover:bg-black/[0.03] focus-visible:bg-white/70"
      />
      <SaveIndicator status={saveStatus} issueCount={issueCount} isDirty={isDirty} />
      {onRequestDelete ? (
        <Button
          variant="quiet"
          size="sm"
          onClick={onRequestDelete}
          aria-label="Delete agent"
        >
          <Trash2 size={14} aria-hidden="true" />
          Delete
        </Button>
      ) : null}
    </Panel>
  );
}
