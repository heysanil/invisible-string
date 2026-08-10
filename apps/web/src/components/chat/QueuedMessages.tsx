/**
 * Messages typed while the session's run slot was held, waiting to send.
 *
 * Dashed borders rather than the solid card border used everywhere else:
 * these rows are NOT YET REAL, and must not read as sent bubbles. The strip
 * is height-capped because it steals from the transcript's viewport, and the
 * label states the merge semantics outright — one send, not one per row.
 */
import { X } from "lucide-react";

import type { QueuedMessage } from "../../lib/chat/use-message-queue";

export interface QueuedMessagesProps {
  messages: readonly QueuedMessage[];
  onRemove: (id: string) => void;
}

export function QueuedMessages({ messages, onRemove }: QueuedMessagesProps) {
  if (messages.length === 0) return null;
  return (
    <div className="px-5 pt-3" aria-live="polite">
      <p className="mb-1.5 text-[10.5px] font-semibold uppercase tracking-[0.07em] text-ink-4">
        Queued · sends as one message when this finishes
      </p>
      <ul className="thin-scroll max-h-32 overflow-y-auto">
        {messages.map((message, index) => (
          <li
            key={message.id}
            className="mb-1 flex items-center gap-2.5 rounded-card border border-dashed border-black/[0.16] bg-white/40 py-1.5 pl-3 pr-2 text-[13px] text-ink-2"
          >
            <span className="w-3 shrink-0 font-mono text-[10.5px] text-ink-4">
              {index + 1}
            </span>
            <span className="min-w-0 flex-1 truncate">{message.text}</span>
            <button
              type="button"
              onClick={() => onRemove(message.id)}
              aria-label={`Remove queued message ${index + 1}`}
              className="lift flex size-[22px] shrink-0 items-center justify-center rounded-full text-ink-4 hover:bg-black/[0.05] hover:text-ink"
            >
              <X size={12} strokeWidth={2.4} aria-hidden="true" />
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
