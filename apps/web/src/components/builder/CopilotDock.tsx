/**
 * Copilot dock — the docked right rail in the builder (spec §12). Streams a
 * message thread over the copilot WS, renders mutation proposals as
 * structured Apply/Dismiss suggestion cards, and applies accepted mutations
 * through the builder controller's dispatch (single writer). Open/closed
 * state persists per user in localStorage.
 */
import { ChevronRight, RefreshCw, Send, Sparkles, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type {
  AgentPresetDto,
  ModelPresetDto,
  WorkflowDefinition,
} from "@invisible-string/shared";

import type { BuilderAction, Pillar } from "../../lib/builder/model";
import type { ContextResources } from "../../lib/builder/resources";
import { pillarOfProposal, proposalToActions } from "../../lib/copilot/mutations";
import type { WebSocketFactory } from "../../lib/copilot/socket";
import { useCopilot } from "../../lib/copilot/useCopilot";
import { cn } from "../../lib/cn";
import { Markdown } from "../chat/Markdown";
import { SuggestionCard } from "./SuggestionCard";

const OPEN_STORAGE_KEY = "is.copilot.open";

const EXAMPLE_PROMPTS = [
  "Set this up to triage Slack mentions",
  "Tighten the instructions",
  "Gate risky tools behind approval",
] as const;

export interface CopilotPrefill {
  id: number;
  text: string;
}

export interface CopilotDockProps {
  workspaceId: string;
  workflowId: string;
  definition: WorkflowDefinition;
  dispatch: React.Dispatch<BuilderAction>;
  resources: ContextResources;
  agentPresets: readonly AgentPresetDto[];
  modelPresets: readonly ModelPresetDto[];
  /** Set by "ask copilot to fix" affordances — opens + seeds the composer. */
  prefill?: CopilotPrefill | null;
  /** Fired after an accepted mutation is applied (pillar flash in the rail). */
  onApplied?: (pillar: Pillar) => void;
  /** Test seam — scripted fake WS. */
  createWebSocket?: WebSocketFactory;
  backoffBaseMs?: number;
}

function readStoredOpen(): boolean {
  try {
    return window.localStorage.getItem(OPEN_STORAGE_KEY) === "1";
  } catch {
    return false;
  }
}

export function CopilotDock(props: CopilotDockProps) {
  const {
    workspaceId,
    workflowId,
    definition,
    dispatch,
    resources,
    agentPresets,
    modelPresets,
    prefill,
    onApplied,
    createWebSocket,
    backoffBaseMs,
  } = props;

  const [open, setOpen] = useState(readStoredOpen);
  const [composer, setComposer] = useState("");
  const threadRef = useRef<HTMLDivElement | null>(null);

  function persistOpen(next: boolean) {
    setOpen(next);
    try {
      window.localStorage.setItem(OPEN_STORAGE_KEY, next ? "1" : "0");
    } catch {
      // storage unavailable — session-only state is fine
    }
  }

  // Live definition ref so getDraft always reads the current draft.
  const definitionRef = useRef(definition);
  definitionRef.current = definition;

  const copilot = useCopilot({
    workspaceId,
    workflowId,
    enabled: open,
    getDraft: () => definitionRef.current,
    applyProposal: (proposal) => {
      for (const action of proposalToActions(proposal)) dispatch(action);
      onApplied?.(pillarOfProposal(proposal));
    },
    ...(createWebSocket ? { createWebSocket } : {}),
    ...(backoffBaseMs !== undefined ? { backoffBaseMs } : {}),
  });

  // Prefill from validation affordances: open the panel + seed the composer.
  useEffect(() => {
    if (!prefill) return;
    persistOpen(true);
    setComposer(prefill.text);
  }, [prefill?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Keep the newest message in view.
  useEffect(() => {
    const el = threadRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [copilot.items]);

  function submit(text: string) {
    copilot.send(text);
    setComposer("");
  }

  if (!open) {
    return (
      <button
        type="button"
        onClick={() => persistOpen(true)}
        aria-label="Open Copilot"
        className="glass-panel lift flex h-full w-12 shrink-0 flex-col items-center gap-3 rounded-panel py-4"
      >
        <span className="flex size-8 items-center justify-center rounded-full bg-ink text-white">
          <Sparkles size={15} aria-hidden="true" />
        </span>
        <span
          className="text-[12px] font-medium tracking-tight text-ink-3"
          style={{ writingMode: "vertical-rl" }}
        >
          Copilot
        </span>
      </button>
    );
  }

  const isEmpty = copilot.items.length === 0;
  const reconnecting = copilot.status === "reconnecting";

  return (
    <aside
      aria-label="Copilot"
      className="glass-panel panel-enter flex h-full w-80 shrink-0 flex-col overflow-hidden"
    >
      <header className="flex items-center gap-2 px-4 pb-3 pt-4">
        <span className="flex size-7 items-center justify-center rounded-full bg-ink text-white">
          <Sparkles size={14} aria-hidden="true" />
        </span>
        <h2 className="flex-1 text-[14px] font-semibold">✦ Copilot</h2>
        <button
          type="button"
          onClick={() => persistOpen(false)}
          aria-label="Collapse Copilot"
          className="lift flex size-7 items-center justify-center rounded-full text-ink-3 hover:bg-black/[0.05] hover:text-ink"
        >
          <ChevronRight size={15} aria-hidden="true" />
        </button>
      </header>
      <div aria-hidden="true" className="mx-4 h-px bg-black/[0.06]" />

      {reconnecting ? (
        <div
          role="status"
          className="mx-3 mt-2 flex items-center gap-1.5 rounded-card border border-warn/30 bg-warn/[0.06] px-3 py-1.5 text-[12px] text-ink-2"
        >
          <RefreshCw size={12} aria-hidden="true" className="text-warn" />
          Reconnecting — your draft will resync automatically.
        </div>
      ) : null}

      {/* Thread */}
      <div
        ref={threadRef}
        aria-live="polite"
        aria-label="Copilot conversation"
        className="thin-scroll flex flex-1 flex-col gap-2.5 overflow-y-auto p-3"
      >
        {isEmpty ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 p-2 text-center">
            <span className="flex size-11 items-center justify-center rounded-full bg-black/[0.04] text-ink-3">
              <Sparkles size={18} aria-hidden="true" />
            </span>
            <p className="text-[13px] font-medium text-ink">
              Build this workflow with copilot
            </p>
            <p className="text-[12px] leading-relaxed text-ink-3">
              Describe what you want — suggestions land as Apply/Preview cards
              you can accept one by one.
            </p>
            <div className="flex flex-col gap-1.5">
              {EXAMPLE_PROMPTS.map((prompt) => (
                <button
                  key={prompt}
                  type="button"
                  onClick={() => submit(prompt)}
                  className="lift rounded-capsule border border-black/10 bg-white/50 px-3 py-1.5 text-[12px] font-medium text-ink-2 hover:text-ink"
                >
                  {prompt}
                </button>
              ))}
            </div>
          </div>
        ) : (
          copilot.items.map((item) => {
            if (item.kind === "suggestion") {
              return (
                <SuggestionCard
                  key={item.id}
                  proposal={item.proposal}
                  status={item.status}
                  definition={definition}
                  resources={resources}
                  agentPresets={agentPresets}
                  modelPresets={modelPresets}
                  onApply={() => copilot.applySuggestion(item.id)}
                  onDismiss={() => copilot.dismissSuggestion(item.id)}
                />
              );
            }
            if (item.kind === "error") {
              return (
                <p
                  key={item.id}
                  role="alert"
                  className="rounded-card border border-err/25 bg-err/[0.05] px-3 py-2 text-[12px] text-ink-2"
                >
                  {item.text}
                </p>
              );
            }
            return item.role === "user" ? (
              <div
                key={item.id}
                className="ml-6 self-end rounded-card-lg bg-ink px-3 py-2 text-[13px] leading-relaxed text-white"
              >
                {item.text}
              </div>
            ) : (
              <div key={item.id} className="mr-2">
                <Markdown text={item.text} className="text-[13px]" />
              </div>
            );
          })
        )}
      </div>

      {/* Composer */}
      <form
        className="flex items-center gap-2 border-t border-black/[0.06] p-3"
        onSubmit={(event) => {
          event.preventDefault();
          submit(composer);
        }}
      >
        <input
          value={composer}
          // Delivered via onInput (React's onChange does not fire under
          // happy-dom); the noop onChange keeps React's controlled-input
          // warning quiet.
          onChange={() => {}}
          onInput={(event) =>
            setComposer((event.target as HTMLInputElement).value)
          }
          aria-label="Ask copilot"
          placeholder="Ask copilot…"
          className="h-9 min-w-0 flex-1 rounded-capsule border border-black/10 bg-white/60 px-3.5 text-[13px] text-ink outline-none placeholder:text-ink-4 focus-visible:border-ink/40"
        />
        {copilot.generating ? (
          <button
            type="button"
            onClick={copilot.stop}
            aria-label="Stop generating"
            className="lift flex size-9 shrink-0 items-center justify-center rounded-full bg-ink text-white"
          >
            <Square size={13} aria-hidden="true" />
          </button>
        ) : (
          <button
            type="submit"
            aria-label="Send to copilot"
            disabled={composer.trim().length === 0}
            className={cn(
              "lift flex size-9 shrink-0 items-center justify-center rounded-full bg-ink text-white",
              composer.trim().length === 0 && "opacity-40",
            )}
          >
            <Send size={14} aria-hidden="true" />
          </button>
        )}
      </form>
    </aside>
  );
}
