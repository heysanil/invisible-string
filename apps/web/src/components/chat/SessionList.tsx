/**
 * Session list panel: recency-grouped sessions, each row = live status dot +
 * the session's own title + relative time, over a quiet identity line naming
 * the agent (and, for trigger-started sessions, origin/workflow provenance
 * chips). Client-side search filter and a "New chat" capsule that opens the
 * agent picker.
 *
 * TITLE OVER AGENT, BOTH LEGIBLE (2026-08-11 spec, D9). Rows used to be
 * titled by the agent's name, which made every thread in a one-agent
 * workspace look identical. The generated title is now the row's headline —
 * but a title alone loses WHICH agent a thread belongs to, so the agent keeps
 * a line of its own, monogram first, in the metadata register. The one case
 * where it is suppressed is the one where it would be duplicated: a session
 * with no title and no known first message falls back to the agent's name,
 * and repeating it underneath would be noise. Resolution itself is
 * {@link sessionRowTitle}, done by the owner of the data (the shells).
 */
import { useMemo, useState } from "react";
import { MessageCircle, Plus, Search } from "lucide-react";

import type { AgentSessionSummaryDto } from "@invisible-string/shared";

import { cn } from "../../lib/cn";
import { errorMessage } from "../../lib/forms";
import {
  recencyGroup,
  relativeTime,
  RECENCY_GROUPS,
} from "../../lib/chat/time";
import { AgentMonogram } from "../agents/AgentMonogram";
import { EmptyState } from "../ui/EmptyState";
import { ErrorState } from "../ui/ErrorState";
import { Spinner } from "../ui/Spinner";
import { Chip } from "./Chip";
import { livenessOf, StatusDot } from "./StatusDot";

// Satisfies React's controlled-input contract; the real handler rides
// onInput, matching the shared Input primitive (React's onChange for text
// inputs never fires under happy-dom).
function noopChange() {}

export interface SessionListItem extends AgentSessionSummaryDto {
  /**
   * Resolved row headline from {@link sessionRowTitle} — never empty. Kept
   * SEPARATE from the DTO's nullable `title` on purpose: the raw column is
   * still needed to tell "the titler has not answered yet" (fall back) from
   * "it did" (use it), and collapsing the two would throw that away.
   */
  displayTitle: string;
}

export interface SessionListProps {
  sessions: readonly SessionListItem[];
  isLoading: boolean;
  /** The sessions query failed — render a retry surface, not "no conversations". */
  isError?: boolean;
  error?: unknown;
  onRetry?: () => void;
  activeSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onNewChat: () => void;
  /** Stable "now" for deterministic grouping (fixture mode / tests). */
  now?: Date;
}

export function SessionList({
  sessions,
  isLoading,
  isError = false,
  error,
  onRetry,
  activeSessionId,
  onSelect,
  onNewChat,
  now,
}: SessionListProps) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q === "") return sessions;
    return sessions.filter(
      (session) =>
        session.displayTitle.toLowerCase().includes(q) ||
        session.agentName.toLowerCase().includes(q) ||
        (session.workflowName?.toLowerCase().includes(q) ?? false),
    );
  }, [sessions, query]);

  const groups = useMemo(() => {
    const nowRef = now ?? new Date();
    const buckets = new Map<string, SessionListItem[]>();
    for (const session of filtered) {
      const group = recencyGroup(session.lastActivityAt, nowRef);
      const list = buckets.get(group) ?? [];
      list.push(session);
      buckets.set(group, list);
    }
    return RECENCY_GROUPS.filter((group) => buckets.has(group)).map((group) => ({
      group,
      items: buckets.get(group)!,
    }));
  }, [filtered, now]);

  return (
    <div className="flex h-full flex-col">
      <header className="flex items-center justify-between gap-2 px-4 pb-3 pt-4">
        <h1 className="text-[17px]">Chat</h1>
        <button
          type="button"
          onClick={onNewChat}
          className="lift inline-flex h-8 items-center gap-1.5 rounded-capsule bg-ink px-3 text-[13px] font-medium text-white"
        >
          <Plus size={14} strokeWidth={2.4} aria-hidden="true" />
          New chat
        </button>
      </header>

      <div className="px-4 pb-2">
        <div className="flex h-9 items-center gap-2 rounded-capsule border border-black/10 bg-white/45 px-3">
          <Search size={14} aria-hidden="true" className="shrink-0 text-ink-4" />
          <input
            value={query}
            onChange={noopChange}
            onInput={(event) =>
              setQuery((event.target as HTMLInputElement).value)
            }
            placeholder="Search conversations"
            aria-label="Search conversations"
            className="min-w-0 flex-1 bg-transparent text-[13px] text-ink outline-none placeholder:text-ink-4"
          />
        </div>
      </div>

      <div className="mx-4 h-px bg-black/[0.06]" aria-hidden="true" />

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2">
        {isLoading ? (
          <div className="flex h-full items-center justify-center">
            <Spinner size={18} className="text-ink-4" />
          </div>
        ) : isError ? (
          <ErrorState
            compact
            title="Couldn’t load conversations"
            message={errorMessage(error, "Check your connection and try again.")}
            onRetry={onRetry}
          />
        ) : sessions.length === 0 ? (
          <EmptyState
            icon={MessageCircle}
            title="No conversations yet"
            description="Start a chat with an agent and watch its replies stream here live."
          />
        ) : filtered.length === 0 ? (
          <p className="px-4 py-8 text-center text-[13px] text-ink-4">
            No conversations match “{query}”.
          </p>
        ) : (
          <ul className="flex flex-col gap-3">
            {groups.map(({ group, items }) => (
              <li key={group}>
                <p className="px-3 pb-1 text-[11px] font-medium uppercase tracking-wide text-ink-4">
                  {group}
                </p>
                <ul className="flex flex-col gap-0.5">
                  {items.map((session) => (
                    <li key={session.id}>
                      <SessionRow
                        session={session}
                        active={session.id === activeSessionId}
                        onSelect={() => onSelect(session.id)}
                        now={now}
                      />
                    </li>
                  ))}
                </ul>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function SessionRow({
  session,
  active,
  onSelect,
  now,
}: {
  session: SessionListItem;
  active: boolean;
  onSelect: () => void;
  now?: Date;
}) {
  const liveness = livenessOf(session.status, session.lastRunStatus);
  // Only redundant when the title IS the agent name — i.e. the last-resort
  // fallback fired. Any real title, generated or message-derived, keeps the
  // identity line.
  const showAgent = session.displayTitle !== session.agentName;
  const showMeta = showAgent || session.origin !== "chat";
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={active ? "true" : undefined}
      className={cn(
        "lift flex w-full flex-col gap-1 rounded-card px-3 py-2 text-left",
        active ? "bg-black/[0.06]" : "hover:bg-black/[0.03]",
      )}
    >
      <div className="flex items-center gap-2">
        <StatusDot state={liveness} />
        <span className="min-w-0 flex-1 truncate text-[13.5px] font-medium text-ink">
          {session.displayTitle}
        </span>
        <span className="shrink-0 text-[11px] text-ink-4">
          {relativeTime(session.lastActivityAt, now)}
        </span>
      </div>
      {/* Metadata register, aligned under the title past the status dot. It
          WRAPS rather than truncating as a unit: in a 320 px panel an agent
          name plus a workflow name does not fit on one line, and clipping the
          provenance would hide the only thing that distinguishes two
          trigger-started threads. */}
      {showMeta ? (
        <div className="flex flex-wrap items-center gap-1.5 pl-4">
          {showAgent ? (
            <span className="flex min-w-0 items-center gap-1 text-[11.5px] text-ink-4">
              {/* Chip-scale monogram: the important overrides win over the
                  size preset (cn has no tailwind-merge). Decorative — the
                  name is right beside it. */}
              <AgentMonogram
                name={session.agentName}
                size="sm"
                className="size-4! text-[8px]!"
              />
              <span className="truncate">{session.agentName}</span>
            </span>
          ) : null}
          {session.origin !== "chat" ? (
            <>
              <Chip>{session.origin}</Chip>
              {session.workflowName !== null ? (
                <Chip title="Started by workflow">{session.workflowName}</Chip>
              ) : null}
            </>
          ) : null}
        </div>
      ) : null}
    </button>
  );
}
