/**
 * ComposerPane — the WORKFLOW editor's primary pane (pipelines redesign):
 * the copilot conversation as a first-class panel, not a collapsible rail.
 * Same shared {@link CopilotThread} + {@link CopilotComposer} pair as the
 * dock, at panel width, with NO collapse pill and the allow-edits switch in
 * the header row. The route places it beside the PipelinePane and owns the
 * narrow-viewport "Compose | Pipeline" segmentation.
 *
 * Allow-edits here is surface-aware in its INITIAL value only
 * (`defaultAllowEdits`: ON for never-published drafts, OFF once published —
 * the route decides); it stays session-scoped and unpersisted, exactly like
 * the dock's.
 */
import { Sparkles } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import type { CopilotSurfaceAdapter } from "../../lib/copilot/adapter";
import type { WebSocketFactory } from "../../lib/copilot/socket";
import { useCopilot } from "../../lib/copilot/useCopilot";
import { cn } from "../../lib/cn";
import {
  AllowEditsSwitch,
  AutoApplyBanner,
  CopilotComposer,
  ReconnectingBanner,
  type CopilotComposerHandle,
  type CopilotPrefill,
} from "./CopilotComposer";
import { CopilotThread } from "./CopilotThread";

export interface ComposerPaneProps {
  workspaceId: string;
  /** The workflow surface adapter (rebuild per render freely — ref-read). */
  adapter: CopilotSurfaceAdapter;
  /** Set by "ask copilot to fix" / "Describe it instead" — seeds the composer. */
  prefill?: CopilotPrefill | null;
  /**
   * Initial allow-edits value: ON for never-published drafts, OFF once
   * published (the route passes it). Session-scoped after that — never
   * persisted, and later prop changes deliberately do NOT move the toggle.
   */
  defaultAllowEdits?: boolean;
  className?: string;
  /** Test seam — scripted fake WS. */
  createWebSocket?: WebSocketFactory;
  backoffBaseMs?: number;
}

export function ComposerPane(props: ComposerPaneProps) {
  const {
    workspaceId,
    adapter,
    prefill,
    defaultAllowEdits = false,
    className,
    createWebSocket,
    backoffBaseMs,
  } = props;

  // Initial value only (lazy init ignores later prop changes on purpose —
  // publishing mid-session must not silently flip a toggle the user set).
  const [allowEdits, setAllowEdits] = useState(defaultAllowEdits);
  const [composer, setComposer] = useState("");
  const composerRef = useRef<CopilotComposerHandle | null>(null);

  const copilot = useCopilot({
    workspaceId,
    adapter,
    // The pane cannot collapse — the socket lives as long as the editor.
    enabled: true,
    allowEdits,
    ...(createWebSocket ? { createWebSocket } : {}),
    ...(backoffBaseMs !== undefined ? { backoffBaseMs } : {}),
  });

  // Prefill from validation affordances / "Describe it instead →".
  useEffect(() => {
    if (!prefill) return;
    setComposer(prefill.text);
    composerRef.current?.focus();
  }, [prefill?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  function toggleAllowEdits() {
    // Computed outside the updater: updaters must stay pure (StrictMode
    // double-invokes them), and this one announces.
    const next = !allowEdits;
    setAllowEdits(next);
    composerRef.current?.announce(
      next
        ? "Auto-apply on — copilot edits the draft without asking"
        : "Auto-apply off — copilot asks before every edit",
    );
  }

  return (
    <section
      aria-label="Copilot"
      className={cn(
        "glass-panel panel-enter flex h-full min-w-0 flex-1 flex-col overflow-hidden",
        className,
      )}
    >
      <header className="flex items-center gap-2 px-4 pb-3 pt-4">
        <span className="flex size-7 items-center justify-center rounded-full bg-ink text-white">
          <Sparkles size={14} aria-hidden="true" />
        </span>
        <h2 className="flex-1 text-[14px] font-semibold">Copilot</h2>
        <AllowEditsSwitch checked={allowEdits} onToggle={toggleAllowEdits} />
      </header>
      <div aria-hidden="true" className="mx-4 h-px bg-black/[0.06]" />

      {allowEdits ? <AutoApplyBanner /> : null}
      {copilot.status === "reconnecting" ? <ReconnectingBanner /> : null}

      <CopilotThread
        copilot={copilot}
        adapter={adapter}
        onFocusComposer={() => composerRef.current?.focus()}
      />

      <CopilotComposer
        ref={composerRef}
        copilot={copilot}
        allowEdits={allowEdits}
        value={composer}
        onChange={setComposer}
      />
    </section>
  );
}
