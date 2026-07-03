/**
 * Session list panel: recency-grouped sessions, each row = derived title +
 * workflow chip + live status dot + relative time. Client-side search filter
 * and a "New chat" capsule that opens the workflow picker.
 */
import { useMemo, useState } from "react";
import { MessageCircle, Plus, Search } from "lucide-react";

import type { AgentSessionSummaryDto } from "@invisible-string/shared";

import { cn } from "../../lib/cn";
import {
  recencyGroup,
  relativeTime,
  RECENCY_GROUPS,
} from "../../lib/chat/time";
import { EmptyState } from "../ui/EmptyState";
import { Spinner } from "../ui/Spinner";
import { Chip } from "./Chip";
import { livenessOf, StatusDot } from "./StatusDot";

export interface SessionListItem extends AgentSessionSummaryDto {
  /** Row title — the workflow name (the list DTO carries no first message). */
  title: string;
}

export interface SessionListProps {
  sessions: readonly SessionListItem[];
  isLoading: boolean;
  activeSessionId: string | null;
  onSelect: (sessionId: string) => void;
  onNewChat: () => void;
  /** Stable "now" for deterministic grouping (fixture mode / tests). */
  now?: Date;
}

export function SessionList({
  sessions,
  isLoading,
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
        session.title.toLowerCase().includes(q) ||
        session.workflowName.toLowerCase().includes(q),
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
            onChange={(event) => setQuery(event.target.value)}
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
        ) : sessions.length === 0 ? (
          <EmptyState
            icon={MessageCircle}
            title="No conversations yet"
            description="Start a session with a workflow and watch its runs stream here live."
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
          {session.title || session.workflowName}
        </span>
        <span className="shrink-0 text-[11px] text-ink-4">
          {relativeTime(session.lastActivityAt, now)}
        </span>
      </div>
      {session.origin !== "chat" ? (
        <div className="flex items-center gap-1.5 pl-4">
          <Chip>{session.origin}</Chip>
        </div>
      ) : null}
    </button>
  );
}
