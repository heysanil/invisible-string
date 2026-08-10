# Composer Stop + Message Queue Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the chat Stop control onto the composer's send button, and let the user keep typing during a run — queued messages merge and send as one turn when the session's run slot frees.

**Architecture:** The control plane allows one run per session (`waiting` counts as busy). A client-side queue defers the POST the server would otherwise reject with 409 `session_busy`. The flush state machine lives in an isolated hook (`use-message-queue.ts`) so it is unit-testable without a DOM; `ThreadContainer` wires it to the existing `slotHeld` predicate; `Composer` becomes purely presentational over three booleans.

**Tech Stack:** React 19, TypeScript strict, Tiptap 3 (`RichTextEditor`), TanStack Query v5, TanStack Router v1, `bun test` + happy-dom + @testing-library/react, Playwright for e2e.

**Spec:** `docs/superpowers/specs/2026-08-09-composer-stop-and-message-queue-design.md`

## Global Constraints

- **Never change `placeholder` or `ariaLabel` on `LazyComposerEditor`/`RichTextEditor` dynamically.** Both are in `useEditor`'s dependency array (`apps/web/src/components/editor/RichTextEditor.tsx:188`); changing either rebuilds the Tiptap instance and destroys the user's draft.
- **Every submit path reads `editorRef.current.flush()`**, never React state. The serializer runs on a 180 ms idle debounce, so `value` lags the caret.
- **The two 409s have opposite recoveries and must never share copy.** `session_busy` = transient, retry. `session_not_active` / `session_not_continuable` = permanent for that id, offer a new chat.
- **E1 design system:** monochrome ink, color only as meaning. Capsule controls, 150–200 ms ease-out, `focus-visible` everywhere. Extend `components/ui` primitives; never fork one-off styles.
- **TypeScript strict.** No `any`, no non-null assertions added.
- Commit messages: conventional style, **no AI/Claude references, no `Co-Authored-By`**.
- **Never run `git clean -fd .changeset`** — an unstaged changeset is exactly what it deletes.
- Retry budget copy, verbatim: `"Still finishing up — your queued message will send shortly."`
- Merge separator, verbatim: `"\n\n"`.
- Queue strip label, verbatim: `"Queued · sends as one message when this finishes."`

## File Structure

| File | Responsibility |
|---|---|
| `apps/web/src/lib/chat/session-errors.ts` (**new**) | `isSessionOver` — lifted from `ThreadContainer` so hook and container agree by construction |
| `apps/web/src/lib/chat/use-message-queue.ts` (**new**) | Queue state + flush state machine. No DOM, no query hooks. |
| `apps/web/src/components/chat/QueuedMessages.tsx` (**new**) | Presentational queued-message strip |
| `apps/web/src/components/chat/DiscardQueueDialog.tsx` (**new**) | Shared confirm for all three discard paths |
| `apps/web/src/components/chat/Composer.tsx` | Prop split; Stop/submit button states; Enter/Escape |
| `apps/web/src/components/editor/RichTextEditor.tsx` | Adds `append` to the imperative handle |
| `apps/web/src/components/chat/RunMessage.tsx` | Loses the Stop button and its props |
| `apps/web/src/components/chat/ThreadView.tsx` | Composer-level `onStop`; renders the strip; autoscroll dep |
| `apps/web/src/components/chat/ThreadContainer.tsx` | Wires queue + stop target + blocker |
| `apps/web/src/components/chat/ChatShell.tsx` | Intercepts session switch / New chat |
| `apps/web/src/components/chat/FixtureChatShell.tsx` | Rewired to composer-level cancel |

---

## Task 1: The queue hook

**Files:**
- Create: `apps/web/src/lib/chat/session-errors.ts`
- Create: `apps/web/src/lib/chat/use-message-queue.ts`
- Create: `apps/web/src/__tests__/message-queue.test.tsx`
- Modify: `apps/web/src/components/chat/ThreadContainer.tsx:87-99` (delete the local `isSessionOver`, import it)

**Interfaces:**
- Consumes: `isSessionBusy`, `isApiErrorCode`, `ApiError` from `lib/api-client`; `errorMessage` from `lib/forms`.
- Produces:
  ```ts
  interface QueuedMessage { id: string; text: string }
  function mergeQueued(messages: readonly QueuedMessage[]): string
  interface UseMessageQueueOptions {
    canFlush: boolean
    send: (text: string) => Promise<void>
    onGiveUp: (mergedText: string) => void
    onRetired: () => void
    retryDelayMs?: number
  }
  interface MessageQueue {
    queued: readonly QueuedMessage[]
    enqueue: (text: string) => void
    remove: (id: string) => void
    clear: () => void
    notice: string | null
  }
  function useMessageQueue(options: UseMessageQueueOptions): MessageQueue
  function isSessionOver(error: unknown): boolean
  ```

- [ ] **Step 1: Create the lifted session-error helper**

Create `apps/web/src/lib/chat/session-errors.ts`:

```ts
/**
 * The session can never take another message. Two codes mean this, with the
 * SAME recovery (start a new chat) and the OPPOSITE recovery from
 * `session_busy`:
 * - `session_not_active` — eve retired the id (terminal / timed out / reset).
 * - `session_not_continuable` — the platform row is closed or lost its eve
 *   session id. Control-plane-only, so there is no shared constant for it.
 *
 * Lifted out of ThreadContainer so the message queue and the container
 * classify the same error the same way by construction.
 */
import { isApiErrorCode, isSessionNotActive } from "../api-client";

export function isSessionOver(error: unknown): boolean {
  return (
    isSessionNotActive(error) || isApiErrorCode(error, "session_not_continuable")
  );
}
```

- [ ] **Step 2: Point ThreadContainer at it**

In `apps/web/src/components/chat/ThreadContainer.tsx`, delete the local `isSessionOver` function (the block at lines 87-99, comment included) and add to the imports:

```ts
import { isSessionOver } from "../../lib/chat/session-errors";
```

Also remove `isApiErrorCode` from the `../../lib/api-client` import list if nothing else in the file uses it.

- [ ] **Step 3: Run typecheck to confirm the lift is clean**

Run: `bun run typecheck`
Expected: PASS (no unused-import or missing-symbol errors).

- [ ] **Step 4: Write the failing tests**

Create `apps/web/src/__tests__/message-queue.test.tsx`:

```tsx
/**
 * The message queue's flush state machine, driven without a DOM composer.
 *
 * Every case here targets a concurrency hole rather than a happy path: the
 * queue's whole job is to serialize behind a slot whose state the client only
 * ever learns about a beat late, so the interesting behavior lives in the gaps
 * — enqueueing mid-flight, a retry armed while the slot is free, and the
 * difference between the two 409s.
 *
 * `retryDelayMs` is injected because bun:test has no fake timers.
 */
import { ensureDomForThisFile } from "../test/setup";

import { afterEach, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";

import { ApiError } from "../lib/api-client";
import { mergeQueued, useMessageQueue } from "../lib/chat/use-message-queue";

ensureDomForThisFile();
afterEach(cleanup);

function busyError(): ApiError {
  return new ApiError(409, "session_busy", "This session is still working.");
}

function deadError(): ApiError {
  return new ApiError(409, "session_not_active", "This session is retired.");
}

/** Renders the hook with overridable options and a settled-promise `send`. */
function setup(overrides: Partial<Parameters<typeof useMessageQueue>[0]> = {}) {
  const send = mock((_text: string) => Promise.resolve());
  const onGiveUp = mock((_text: string) => {});
  const onRetired = mock(() => {});
  const view = renderHook(
    ({ canFlush }: { canFlush: boolean }) =>
      useMessageQueue({
        canFlush,
        send,
        onGiveUp,
        onRetired,
        retryDelayMs: 5,
        ...overrides,
      }),
    { initialProps: { canFlush: false } },
  );
  return { ...view, send, onGiveUp, onRetired };
}

test("queued messages merge into one send, separated by a blank line", async () => {
  const { result, rerender, send } = setup();

  act(() => {
    result.current.enqueue("add tests");
    result.current.enqueue("then push");
  });
  expect(result.current.queued.map((m) => m.text)).toEqual([
    "add tests",
    "then push",
  ]);
  // Nothing goes out while the slot is held.
  expect(send).not.toHaveBeenCalled();

  rerender({ canFlush: true });

  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  expect(send.mock.calls[0]?.[0]).toBe("add tests\n\nthen push");
  await waitFor(() => expect(result.current.queued).toHaveLength(0));
});

test("enqueueing while free flushes immediately — the trigger is the condition, not an edge", async () => {
  const { result, rerender, send } = setup();
  // canFlush is ALREADY true before anything is queued: an edge-triggered
  // machine would strand this message forever.
  rerender({ canFlush: true });

  act(() => {
    result.current.enqueue("ship it");
  });

  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));
  expect(send.mock.calls[0]?.[0]).toBe("ship it");
});

test("a message enqueued mid-flight survives the flush that did not include it", async () => {
  let release: (() => void) | undefined;
  const send = mock(
    (_text: string) =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
  );
  const { result, rerender } = setup({ send });

  act(() => {
    result.current.enqueue("first");
  });
  rerender({ canFlush: true });
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));

  // Arrives AFTER the merge snapshot was taken.
  act(() => {
    result.current.enqueue("second");
  });
  await act(async () => {
    release?.();
    await Promise.resolve();
  });

  // A wholesale clear() would have deleted "second" — it was never sent.
  await waitFor(() => expect(result.current.queued.map((m) => m.text)).toEqual(["second"]));
});

test("session_busy keeps the queue, shows the retry notice, and retries", async () => {
  let attempt = 0;
  const send = mock((_text: string) => {
    attempt += 1;
    return attempt === 1 ? Promise.reject(busyError()) : Promise.resolve();
  });
  const { result, rerender, onGiveUp } = setup({ send });

  act(() => {
    result.current.enqueue("follow-up");
  });
  rerender({ canFlush: true });

  await waitFor(() =>
    expect(result.current.notice).toBe(
      "Still finishing up — your queued message will send shortly.",
    ),
  );
  // The text is still queued, not handed back.
  expect(result.current.queued).toHaveLength(1);
  expect(onGiveUp).not.toHaveBeenCalled();

  await waitFor(() => expect(send).toHaveBeenCalledTimes(2));
  await waitFor(() => expect(result.current.queued).toHaveLength(0));
  expect(result.current.notice).toBeNull();
});

test("five consecutive busy 409s give the text back instead of retrying forever", async () => {
  const send = mock((_text: string) => Promise.reject(busyError()));
  const { result, rerender, onGiveUp } = setup({ send });

  act(() => {
    result.current.enqueue("a");
    result.current.enqueue("b");
  });
  rerender({ canFlush: true });

  await waitFor(() => expect(onGiveUp).toHaveBeenCalledTimes(1));
  expect(send).toHaveBeenCalledTimes(5);
  expect(onGiveUp.mock.calls[0]?.[0]).toBe("a\n\nb");
  expect(result.current.queued).toHaveLength(0);
  expect(result.current.notice).toContain("wasn’t sent");
});

test("a pending retry is cancelled when the slot is taken again", async () => {
  const send = mock((_text: string) => Promise.reject(busyError()));
  const { result, rerender } = setup({ send, retryDelayMs: 40 });

  act(() => {
    result.current.enqueue("later");
  });
  rerender({ canFlush: true });
  await waitFor(() => expect(send).toHaveBeenCalledTimes(1));

  // Another run took the slot before the backoff elapsed.
  rerender({ canFlush: false });
  await new Promise((resolve) => setTimeout(resolve, 80));

  // No second attempt fired into a slot the client knows is busy.
  expect(send).toHaveBeenCalledTimes(1);
  expect(result.current.queued).toHaveLength(1);
});

test("session_not_active retires immediately — it never consumes retries", async () => {
  const send = mock((_text: string) => Promise.reject(deadError()));
  const { result, rerender, onGiveUp, onRetired } = setup({ send });

  act(() => {
    result.current.enqueue("hello");
  });
  rerender({ canFlush: true });

  await waitFor(() => expect(onRetired).toHaveBeenCalledTimes(1));
  expect(send).toHaveBeenCalledTimes(1);
  expect(onGiveUp.mock.calls[0]?.[0]).toBe("hello");
  expect(result.current.queued).toHaveLength(0);
});

test("remove drops one message, clear drops all, and blank text never queues", () => {
  const { result } = setup();

  act(() => {
    result.current.enqueue("one");
    result.current.enqueue("two");
    result.current.enqueue("   ");
  });
  expect(result.current.queued).toHaveLength(2);

  const firstId = result.current.queued[0]!.id;
  act(() => {
    result.current.remove(firstId);
  });
  expect(result.current.queued.map((m) => m.text)).toEqual(["two"]);

  act(() => {
    result.current.clear();
  });
  expect(result.current.queued).toHaveLength(0);
});

test("mergeQueued joins with a blank line so items stay separate paragraphs", () => {
  expect(
    mergeQueued([
      { id: "qm_a", text: "first" },
      { id: "qm_b", text: "second" },
    ]),
  ).toBe("first\n\nsecond");
});
```

- [ ] **Step 5: Run the tests to verify they fail**

Run: `bun test apps/web/src/__tests__/message-queue.test.tsx`
Expected: FAIL — `Cannot find module '../lib/chat/use-message-queue'`.

- [ ] **Step 6: Implement the hook**

Create `apps/web/src/lib/chat/use-message-queue.ts`:

```ts
/**
 * Client-side message queue for a chat thread.
 *
 * The control plane allows ONE run per session (`waiting` counts as busy), so
 * a message typed while a run is working would come back 409 `session_busy`.
 * This hook defers it instead: messages accumulate, and when the slot frees
 * they merge into a single send.
 *
 * Three details are load-bearing and easy to "simplify" wrong:
 *
 * 1. The flush is CONDITION-triggered, not edge-triggered. A message enqueued
 *    while `canFlush` is already true has no edge to ride and would strand.
 * 2. A resolved flush removes the SNAPSHOTTED ids, never the whole queue.
 *    `queueing` is deliberately true during a flush, so Enter in that window
 *    enqueues — a wholesale clear() would delete a message that was never sent.
 * 3. A retry armed while the slot was free is cancelled the moment the slot is
 *    taken again. Firing it would burn the give-up budget on a request the
 *    client already knows will 409.
 */
import { useCallback, useEffect, useRef, useState } from "react";

import { isSessionBusy } from "../api-client";
import { errorMessage } from "../forms";
import { isSessionOver } from "./session-errors";

export interface QueuedMessage {
  id: string;
  text: string;
}

export interface UseMessageQueueOptions {
  /** `!slotHeld && !sessionRetired && !sending` — the server's own rule. */
  canFlush: boolean;
  /** `postMessage.mutateAsync`; must REJECT on error. */
  send: (text: string) => Promise<void>;
  /** Hand the merged text back non-destructively (never clobber the box). */
  onGiveUp: (mergedText: string) => void;
  /** eve retired this session id — permanent. */
  onRetired: () => void;
  /** Test seam: bun:test has no fake timers. */
  retryDelayMs?: number;
}

export interface MessageQueue {
  queued: readonly QueuedMessage[];
  enqueue: (text: string) => void;
  remove: (id: string) => void;
  clear: () => void;
  /** Retry / give-up copy for the composer's hint line. */
  notice: string | null;
}

const MAX_BUSY_ATTEMPTS = 5;
const DEFAULT_RETRY_MS = 2_000;

const BUSY_NOTICE = "Still finishing up — your queued message will send shortly.";
const GAVE_UP_NOTICE =
  "This session is still busy, so your queued message wasn’t sent. It’s back in the box — try again in a moment.";

/**
 * A blank line, because every queued item is markdown: a single newline folds
 * the next item into the previous paragraph under CommonMark.
 */
export function mergeQueued(messages: readonly QueuedMessage[]): string {
  return messages.map((message) => message.text).join("\n\n");
}

/** Matches the short client-side id pattern in lib/slug.ts — never leaves the browser. */
function queuedMessageId(): string {
  return `qm_${crypto.randomUUID().replace(/-/g, "").slice(0, 13)}`;
}

export function useMessageQueue({
  canFlush,
  send,
  onGiveUp,
  onRetired,
  retryDelayMs = DEFAULT_RETRY_MS,
}: UseMessageQueueOptions): MessageQueue {
  const [queued, setQueued] = useState<QueuedMessage[]>([]);
  const [notice, setNotice] = useState<string | null>(null);
  const [retryPending, setRetryPending] = useState(false);

  const flushing = useRef(false);
  const busyAttempts = useRef(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Callbacks change identity every render; keeping them in refs stops the
  // flush effect from re-firing on an unrelated parent repaint.
  const sendRef = useRef(send);
  sendRef.current = send;
  const giveUpRef = useRef(onGiveUp);
  giveUpRef.current = onGiveUp;
  const retiredRef = useRef(onRetired);
  retiredRef.current = onRetired;

  const cancelRetry = useCallback(() => {
    if (retryTimer.current !== null) {
      clearTimeout(retryTimer.current);
      retryTimer.current = null;
    }
    setRetryPending(false);
  }, []);

  useEffect(() => {
    if (!canFlush) cancelRetry();
  }, [canFlush, cancelRetry]);

  useEffect(
    () => () => {
      if (retryTimer.current !== null) clearTimeout(retryTimer.current);
    },
    [],
  );

  useEffect(() => {
    if (!canFlush || retryPending || flushing.current || queued.length === 0) {
      return;
    }
    const included = new Set(queued.map((message) => message.id));
    const merged = mergeQueued(queued);
    const dropIncluded = () =>
      setQueued((current) => current.filter((message) => !included.has(message.id)));

    flushing.current = true;
    void sendRef.current(merged).then(
      () => {
        flushing.current = false;
        busyAttempts.current = 0;
        setNotice(null);
        dropIncluded();
      },
      (error: unknown) => {
        flushing.current = false;
        if (isSessionBusy(error)) {
          busyAttempts.current += 1;
          if (busyAttempts.current < MAX_BUSY_ATTEMPTS) {
            setNotice(BUSY_NOTICE);
            setRetryPending(true);
            retryTimer.current = setTimeout(() => {
              retryTimer.current = null;
              setRetryPending(false);
            }, retryDelayMs);
            return;
          }
          setNotice(GAVE_UP_NOTICE);
        } else if (isSessionOver(error)) {
          retiredRef.current();
          setNotice(null);
        } else {
          setNotice(errorMessage(error));
        }
        busyAttempts.current = 0;
        giveUpRef.current(merged);
        dropIncluded();
      },
    );
  }, [canFlush, queued, retryPending, retryDelayMs]);

  const enqueue = useCallback((text: string) => {
    const trimmed = text.trim();
    if (trimmed.length === 0) return;
    setQueued((current) => [...current, { id: queuedMessageId(), text: trimmed }]);
    setNotice(null);
  }, []);

  const remove = useCallback((id: string) => {
    setQueued((current) => current.filter((message) => message.id !== id));
  }, []);

  const clear = useCallback(() => {
    setQueued([]);
    setNotice(null);
  }, []);

  return { queued, enqueue, remove, clear, notice };
}
```

- [ ] **Step 7: Run the tests to verify they pass**

Run: `bun test apps/web/src/__tests__/message-queue.test.tsx`
Expected: PASS — 9 tests.

If `ApiError`'s constructor signature differs from `new ApiError(status, code, message)`, read `apps/web/src/lib/api-client.ts` and adjust the two helper factories in the test only — never the production code.

- [ ] **Step 8: Run the full unit lane and typecheck**

Run: `bun run typecheck && bun test`
Expected: PASS.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/lib/chat/session-errors.ts \
        apps/web/src/lib/chat/use-message-queue.ts \
        apps/web/src/__tests__/message-queue.test.tsx \
        apps/web/src/components/chat/ThreadContainer.tsx
git commit -m "feat(web): client-side chat message queue with merge-on-flush"
```

---

## Task 2: Composer prop split and button states

**Files:**
- Modify: `apps/web/src/components/editor/RichTextEditor.tsx:59-72` (handle) and `:236-252` (`useImperativeHandle`)
- Modify: `apps/web/src/components/chat/Composer.tsx` (whole file)
- Modify: `apps/web/src/__tests__/chat-composer.test.tsx` (add cases)

**Interfaces:**
- Consumes: nothing from Task 1.
- Produces:
  ```ts
  interface RichTextEditorHandle {
    flush: () => string
    setValue: (next: string) => void
    append: (text: string) => void   // NEW
    focus: () => void
  }
  interface ComposerProps {
    onSend: (message: string) => void
    disabledReason?: string | null
    hint?: string | null             // NEW
    onStop?: () => void              // NEW
    stopping?: boolean               // NEW
    queueing?: boolean               // NEW
    restoreDraft?: string | null     // NEW — appended, never replacing
    onRestoreConsumed?: () => void   // NEW — handshake so it appends once
    sending?: boolean
    placeholder?: string
    initialValue?: string
    autoFocus?: boolean
  }
  ```

**Why `restoreDraft` replaces the `failedDraft`→`initialValue` path:** `initialValue` reaches `RichTextEditor`'s reconcile effect (`RichTextEditor.tsx:257-262`), which **replaces the document**. That was safe only because the composer used to be disabled whenever a failed draft came back. The box is live now, so a give-up landing ~10 s after a failed flush would overwrite whatever the user has since typed. `restoreDraft` appends instead, and `onRestoreConsumed` lets the parent null it so it applies exactly once.
  Accessible names, exact: `"Stop"`, `"Send message"`, `"Queue message"`.

- [ ] **Step 1: Add `append` to the editor handle**

In `apps/web/src/components/editor/RichTextEditor.tsx`, extend the handle interface (after `setValue`, before `focus`):

```ts
  /**
   * Append text to the end of the document, keeping what is already there.
   *
   * The non-destructive counterpart to `setValue`: a queued message handed
   * back after a failed flush must never overwrite a draft the user has since
   * started typing. Separated by a blank line so both stay their own paragraph.
   */
  append: (text: string) => void;
```

And in the `useImperativeHandle` object, between `setValue` and `focus`:

```ts
        append: (text: string) => {
          if (timerRef.current) {
            clearTimeout(timerRef.current);
            timerRef.current = null;
          }
          const current = isLive(editor) ? editor.getMarkdown() : lastValueRef.current;
          applyExternalValue(current.trim().length === 0 ? text : `${current}\n\n${text}`);
        },
```

- [ ] **Step 2: Write the failing Composer tests**

Append to `apps/web/src/__tests__/chat-composer.test.tsx`:

```tsx
// ── Stop on the send button + queueing ──────────────────────────────────────

test("no Stop control when nothing is stoppable", async () => {
  const view = render(<Composer onSend={() => {}} />);
  await view.findByLabelText("Message");
  expect(view.queryByRole("button", { name: "Stop" })).toBeNull();
  expect(view.getByRole("button", { name: "Send message" })).toBeTruthy();
});

test("an empty box during a run shows Stop instead of send", async () => {
  const onStop = mock(() => {});
  const view = render(<Composer onSend={() => {}} onStop={onStop} queueing />);
  await view.findByLabelText("Message");

  fireEvent.click(view.getByRole("button", { name: "Stop" }));
  expect(onStop).toHaveBeenCalledTimes(1);
  // The submit button is not competing for the same spot.
  expect(view.queryByRole("button", { name: /message$/ })).toBeNull();
});

test("typing during a run shows BOTH Stop and Queue — neither action is mouse-inaccessible", async () => {
  const onSend = mock((_message: string) => {});
  const onStop = mock(() => {});
  const view = render(<Composer onSend={onSend} onStop={onStop} queueing />);
  const box = await view.findByLabelText("Message");

  paste(box, "and link the images");

  const queue = await view.findByRole("button", { name: "Queue message" });
  fireEvent.click(queue);
  expect(onSend.mock.calls).toEqual([["and link the images"]]);
  expect(view.getByRole("button", { name: "Stop" })).toBeTruthy();
});

test("Enter queues rather than sends while a run holds the slot", async () => {
  const onSend = mock((_message: string) => {});
  const view = render(<Composer onSend={onSend} onStop={() => {}} queueing />);
  const box = await view.findByLabelText("Message");

  paste(box, "keep it under 200 words");
  fireEvent.keyDown(box, { key: "Enter" });

  // Same callback either way — the parent routes on `queueing`. What matters
  // is that the flush still happened: the debounced value is 180 ms behind.
  expect(onSend.mock.calls).toEqual([["keep it under 200 words"]]);
  expect(box.textContent).toBe("");
});

test("Escape stops the run, and does nothing when there is nothing to stop", async () => {
  const onStop = mock(() => {});
  const view = render(<Composer onSend={() => {}} onStop={onStop} queueing />);
  const box = await view.findByLabelText("Message");
  fireEvent.keyDown(box, { key: "Escape" });
  expect(onStop).toHaveBeenCalledTimes(1);

  cleanup();
  const plain = render(<Composer onSend={() => {}} />);
  const plainBox = await plain.findByLabelText("Message");
  // No throw, no stop — Escape is inert without a stoppable run.
  fireEvent.keyDown(plainBox, { key: "Escape" });
  expect(onStop).toHaveBeenCalledTimes(1);
});

test("a background flush does not block queuing by mouse", async () => {
  const onSend = mock((_message: string) => {});
  // `sending` is true because the QUEUE is flushing, not because this box sent.
  const view = render(
    <Composer onSend={onSend} onStop={() => {}} queueing sending />,
  );
  const box = await view.findByLabelText("Message");

  paste(box, "one more thing");
  const queue = await view.findByRole("button", { name: "Queue message" });
  expect((queue as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(queue);
  expect(onSend.mock.calls).toEqual([["one more thing"]]);
});

test("the placeholder never changes when queueing flips — the draft must survive", async () => {
  const view = render(<Composer onSend={() => {}} placeholder="Message Release Notes…" />);
  const box = await view.findByLabelText("Message");
  paste(box, "half a thought");

  // A run starts underneath the user mid-sentence.
  view.rerender(
    <Composer
      onSend={() => {}}
      placeholder="Message Release Notes…"
      onStop={() => {}}
      queueing
    />,
  );

  // Same editor instance, same text. Changing `placeholder` (or `ariaLabel`)
  // is in useEditor's dep array and would have rebuilt the editor, silently
  // destroying this draft — the exact scenario the queue exists for.
  const after = await view.findByLabelText("Message");
  expect(after.textContent).toContain("half a thought");
});

test("a retired session is the only thing that still freezes the box", async () => {
  const onSend = mock((_message: string) => {});
  const view = render(
    <Composer onSend={onSend} disabledReason="This session has been retired — start a new chat." />,
  );
  const box = await view.findByLabelText("Message");
  paste(box, "anything");
  fireEvent.keyDown(box, { key: "Enter" });
  expect(onSend).not.toHaveBeenCalled();
  expect(view.getByText(/has been retired/)).toBeTruthy();
});

test("a restored draft appends — it never overwrites what the user is typing", async () => {
  const onRestoreConsumed = mock(() => {});
  const view = render(
    <Composer onSend={() => {}} onRestoreConsumed={onRestoreConsumed} />,
  );
  const box = await view.findByLabelText("Message");
  paste(box, "a new thought");

  // A queued flush gave up ~10 s after the user started typing again.
  view.rerender(
    <Composer
      onSend={() => {}}
      restoreDraft="the message that failed to send"
      onRestoreConsumed={onRestoreConsumed}
    />,
  );

  await waitFor(() => {
    expect(box.textContent).toContain("a new thought");
    expect(box.textContent).toContain("the message that failed to send");
  });
  // Consumed exactly once, so a re-render cannot append it twice.
  expect(onRestoreConsumed).toHaveBeenCalledTimes(1);
});

test("a restored draft seeds an empty box without a leading blank line", async () => {
  const view = render(<Composer onSend={() => {}} restoreDraft="just this" onRestoreConsumed={() => {}} />);
  const box = await view.findByLabelText("Message");
  await waitFor(() => expect(box.textContent).toBe("just this"));
});

test("the hint is announced without disabling anything", async () => {
  const onSend = mock((_message: string) => {});
  const view = render(
    <Composer onSend={onSend} hint="Still finishing up — your queued message will send shortly." />,
  );
  const box = await view.findByLabelText("Message");
  const hint = view.getByText(/Still finishing up/);
  expect(hint.getAttribute("aria-live")).toBe("polite");

  paste(box, "still typeable");
  fireEvent.keyDown(box, { key: "Enter" });
  expect(onSend.mock.calls).toEqual([["still typeable"]]);
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `bun test apps/web/src/__tests__/chat-composer.test.tsx`
Expected: FAIL — the new props do not exist, so no Stop button renders and the send button keeps its old name.

- [ ] **Step 4: Rewrite the Composer**

Replace `apps/web/src/components/chat/Composer.tsx` with:

```tsx
/**
 * Chat composer — capsule glass input. Enter sends, Shift+Enter newlines.
 *
 * While a run holds the session's run slot the box STAYS LIVE and Enter
 * queues instead of sending (the parent routes on `queueing`); the send
 * circle becomes a Stop, and a second ink circle appears once there is text
 * so neither action is ever mouse-inaccessible.
 *
 * THE FLUSH IS LOAD-BEARING. `RichTextEditor` serializes on an idle debounce,
 * so at the instant Enter fires, `value` is still the markdown from ~180 ms
 * ago — sending it would drop the tail of the message (or send nothing at all
 * for a fast one-word reply). Every submit path therefore reads the editor
 * synchronously through `flush()`.
 *
 * THE PLACEHOLDER IS CONSTANT, AND SO IS THE ARIA LABEL. Both are in
 * `useEditor`'s dependency array, so changing either rebuilds the editor and
 * destroys the draft — which would fire in exactly the scenario the queue
 * exists for. State rides the BUTTON's accessible name and the hint line.
 */
import { useEffect, useRef, useState } from "react";
import { ArrowUp, Square } from "lucide-react";

import { cn } from "../../lib/cn";
import { LazyComposerEditor } from "../editor/LazyComposerEditor";
import type { RichTextEditorHandle } from "../editor/RichTextEditor";

export interface ComposerProps {
  /** Submit. The parent decides whether that means send or enqueue. */
  onSend: (message: string) => void;
  /** Non-null freezes the input. ONLY a retired session — never "working". */
  disabledReason?: string | null;
  /** Non-blocking notice (retry state, transient errors). Box stays live. */
  hint?: string | null;
  /** Present ⇒ a run is stoppable ⇒ render the Stop control. */
  onStop?: () => void;
  /** Stop request in flight. */
  stopping?: boolean;
  /** Submit means enqueue: the button says so, and `sending` stops blocking. */
  queueing?: boolean;
  /**
   * Text handed back after a failed send or a given-up flush. APPENDED, never
   * replacing: the box is live now, so a give-up landing seconds later must
   * not overwrite whatever the user has started typing since.
   */
  restoreDraft?: string | null;
  /** Called once the restore has been applied, so the parent can null it. */
  onRestoreConsumed?: () => void;
  /** A send is in flight (spinner + disabled send — unless queueing). */
  sending?: boolean;
  placeholder?: string;
  /** Retained draft after a failed send (controlled from the parent). */
  initialValue?: string;
  autoFocus?: boolean;
}

export function Composer({
  onSend,
  disabledReason,
  hint,
  onStop,
  stopping,
  queueing,
  restoreDraft,
  onRestoreConsumed,
  sending,
  placeholder = "Send a message…",
  initialValue,
  autoFocus,
}: ComposerProps) {
  const [value, setValue] = useState(initialValue ?? "");
  const editorRef = useRef<RichTextEditorHandle>(null);
  const disabled = disabledReason != null;

  // Re-seed the box when the parent hands back a failed draft.
  useEffect(() => {
    if (initialValue !== undefined) setValue(initialValue);
  }, [initialValue]);

  // The editor exists by the time a passive effect runs (its imperative
  // handle is attached in a layout effect), so one shot is enough.
  useEffect(() => {
    if (autoFocus) editorRef.current?.focus();
  }, [autoFocus]);

  // A restore APPENDS. Going through `value`/`initialValue` would reach the
  // reconcile effect, which replaces the document — and the box is live now,
  // so that would eat a draft the user started after the send failed.
  //
  // The ref is not belt-and-braces: this composer re-renders on every streamed
  // token of the live run, and `onRestoreConsumed` is an inline arrow in the
  // parent. Without it, a repaint landing between the append and the parent's
  // null would run the effect again and append the same text twice.
  const appliedRestore = useRef<string | null>(null);
  useEffect(() => {
    if (restoreDraft == null || restoreDraft.length === 0) {
      appliedRestore.current = null;
      return;
    }
    if (appliedRestore.current === restoreDraft) return;
    appliedRestore.current = restoreDraft;
    editorRef.current?.append(restoreDraft);
    setValue((current) =>
      current.trim().length === 0 ? restoreDraft : `${current}\n\n${restoreDraft}`,
    );
    onRestoreConsumed?.();
  }, [restoreDraft, onRestoreConsumed]);

  // A send in flight blocks another SEND, but never a queue: the flush that
  // set `sending` is exactly when the user's next thought needs somewhere to
  // go.
  const sendBlocked = sending === true && queueing !== true;

  function submit() {
    const message = (editorRef.current?.flush() ?? value).trim();
    if (message.length === 0 || disabled || sendBlocked) return;
    onSend(message);
    // Both halves are needed. The imperative write is what actually empties
    // the document: send-and-clear takes `value` from "" back to "" inside a
    // single React batch, so the prop never changes and the reconcile effect
    // would never run. The state update keeps the two in step afterwards.
    editorRef.current?.setValue("");
    setValue("");
  }

  function onKeyDown(event: KeyboardEvent): boolean {
    // Escape stops the run — the keyboard twin of the Stop circle. Inert
    // when there is nothing to stop, so it never swallows the key.
    if (event.key === "Escape") {
      if (onStop === undefined || stopping === true) return false;
      onStop();
      return true;
    }
    if (event.key !== "Enter" || event.shiftKey) return false;
    // Mid-composition Enter commits an IME candidate; it is not a send.
    if (event.isComposing || event.keyCode === 229) return false;
    submit();
    // Handled — ProseMirror must not also split the paragraph underneath.
    return true;
  }

  // Emptiness rides the debounced value, so the send button can trail the
  // last keystroke by one debounce. That only ever gates the MOUSE path
  // (Enter flushes), and reaching for the button costs more than 180 ms.
  const empty = value.trim().length === 0;
  const showStop = onStop !== undefined;
  // With an empty box Stop IS the primary action and owns the ink circle;
  // once there is text the user's own words are primary and Stop steps back.
  const stopIsPrimary = showStop && empty;
  const showSubmit = !stopIsPrimary;

  return (
    <div className="px-4 pb-4 pt-2">
      {disabledReason ?? hint ? (
        <p aria-live="polite" className="mb-1.5 px-2 text-[12px] text-ink-3">
          {disabledReason ?? hint}
        </p>
      ) : null}
      <div
        className={cn(
          "flex items-end gap-2 rounded-[22px] border border-black/10 bg-white/55 px-3 py-2 transition-colors duration-150",
          "focus-within:border-black/20",
          disabled && "opacity-60",
        )}
      >
        {/* The contenteditable grows with its content — no autosize math —
            and the clamp turns into a scroll region past ~6 lines. The
            placeholder is constant: it is suppressed for a read-only host in
            CSS, because changing the prop re-creates the editor and would
            drop the draft the moment a run starts. */}
        <LazyComposerEditor
          ref={editorRef}
          value={value}
          onChange={setValue}
          ariaLabel="Message"
          placeholder={placeholder}
          readOnly={disabled}
          onKeyDown={onKeyDown}
          className="thin-scroll tt-host-composer max-h-40 min-w-0 flex-1 overflow-y-auto text-sm leading-relaxed"
        />
        {showStop ? (
          <button
            type="button"
            onClick={onStop}
            disabled={stopping}
            aria-label="Stop"
            aria-busy={stopping || undefined}
            className={cn(
              "lift flex size-8 shrink-0 items-center justify-center rounded-full disabled:pointer-events-none",
              stopIsPrimary
                ? "bg-ink text-white"
                : "border border-black/12 bg-white/70 text-ink hover:bg-white/90",
            )}
          >
            {stopping ? (
              <span className="spinner size-3.5" aria-hidden="true" />
            ) : (
              <Square size={11} strokeWidth={2.6} fill="currentColor" aria-hidden="true" />
            )}
          </button>
        ) : null}
        {showSubmit ? (
          <button
            type="button"
            onClick={submit}
            disabled={disabled || sendBlocked || empty}
            aria-label={queueing === true ? "Queue message" : "Send message"}
            aria-busy={sendBlocked || undefined}
            className="lift flex size-8 shrink-0 items-center justify-center rounded-full bg-ink text-white disabled:pointer-events-none disabled:opacity-40"
          >
            {sendBlocked ? (
              <span className="spinner size-3.5" aria-hidden="true" />
            ) : (
              <ArrowUp size={16} strokeWidth={2.4} aria-hidden="true" />
            )}
          </button>
        ) : null}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Run the Composer tests**

Run: `bun test apps/web/src/__tests__/chat-composer.test.tsx`
Expected: PASS — all pre-existing cases plus the 9 new ones.

- [ ] **Step 6: Fix the call sites the prop rename broke**

`ThreadView.tsx` and `ChatShell.tsx`'s `NewChatComposer` still pass `disabledReason={composerDisabledReason}`. That prop still exists, so typecheck should pass unchanged. Confirm:

Run: `bun run typecheck`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/web/src/components/editor/RichTextEditor.tsx \
        apps/web/src/components/chat/Composer.tsx \
        apps/web/src/__tests__/chat-composer.test.tsx
git commit -m "feat(web): composer Stop control, queue affordance and hint/disabled split"
```

---

## Task 3: Move Stop out of the transcript

This task deliberately carries **no queue logic** — it is the one that breaks the most existing tests, so keeping it isolated keeps it revertable.

**Files:**
- Modify: `apps/web/src/components/chat/RunMessage.tsx` (remove Stop)
- Modify: `apps/web/src/components/chat/ThreadView.tsx` (props swap)
- Modify: `apps/web/src/components/chat/ThreadContainer.tsx` (compute `stoppableRunId`)
- Modify: `apps/web/src/components/chat/FixtureChatShell.tsx:200`
- Modify: `apps/web/src/__tests__/chat-thread.test.tsx:289-345`
- Modify: `apps/web/src/__tests__/fixture-chat.test.tsx:128-135`
- Modify: `e2e/specs/chat-approval.e2e.ts:81-83,94,106-109,113`

**Interfaces:**
- Consumes: `ComposerProps.onStop` / `stopping` from Task 2.
- Produces: `ThreadViewProps` gains `onStop?: () => void` and `stopping?: boolean`; loses `onCancel` and `cancelingRunId`. `RunMessageProps` loses `onCancel` and `canceling`.

- [ ] **Step 1: Rewrite the three transcript Stop tests**

In `apps/web/src/__tests__/chat-thread.test.tsx`, replace the block at lines 289-345 (the three tests under `// ── Stop (eve 0.31 turn cancellation) ───`) with:

```tsx
// ── Stop (eve 0.31 turn cancellation) ───────────────────────────────────────

test("a stopped run reads as a user decision, never as a failure", () => {
  const view = render(
    <RunMessage
      run={baseRun({
        status: "canceled",
        canceled: true,
        reply: { text: "I pulled 142 open issues", streaming: false },
      })}
      isChatOrigin
      onRespond={() => {}}
    />,
  );
  // No error banner: eve emits NO failure event for a cancelled turn.
  expect(view.queryByRole("alert")).toBeNull();
  expect(view.getByText(/You stopped this run/)).toBeTruthy();
  // Whatever streamed before the stop stays readable.
  expect(view.getByText(/142 open issues/)).toBeTruthy();
});

test("the transcript never offers Stop — it lives on the composer now", () => {
  // Virtualization can scroll a transcript button out of the DOM entirely
  // while a run streams; the composer is always mounted.
  const view = render(
    <RunMessage run={baseRun({ status: "running" })} isChatOrigin onRespond={() => {}} />,
  );
  expect(view.queryByRole("button", { name: "Stop" })).toBeNull();
});

test("ThreadView puts Stop on the composer while a run is stoppable", () => {
  const onStop = mock(() => {});
  const view = renderWithRouter(
    <ThreadView
      header={HEADER}
      runs={[baseRun({ status: "running" })]}
      isChatOrigin
      onRespond={() => {}}
      onStop={onStop}
      onSend={() => {}}
    />,
  );
  fireEvent.click(view.getByRole("button", { name: "Stop" }));
  expect(onStop).toHaveBeenCalledTimes(1);
});
```

If `fireEvent` or `mock` is not already imported in this file, add them to the existing `bun:test` / `@testing-library/react` import lines.

- [ ] **Step 2: Run to verify the new tests fail**

Run: `bun test apps/web/src/__tests__/chat-thread.test.tsx`
Expected: FAIL — `RunMessage` still renders a Stop button, and `ThreadView` has no `onStop` prop.

- [ ] **Step 3: Strip Stop out of RunMessage**

In `apps/web/src/components/chat/RunMessage.tsx`:

1. Update the file header — replace `— and the Stop control.` with `. The Stop control lives on the composer (2026-08-09 spec).`
2. Delete `onCancel` and `canceling` from `RunMessageProps` (lines 29-32).
3. Delete them from the destructured params.
4. Delete the `onLimitPrompt` and `cancelable` computations and the `handleCancel` callback (lines 52-60 and 65-68).
5. Delete the final Stop block (lines 156-163):

```tsx
        {onCancel && cancelable ? (
          <div className="pt-1">
            <Button variant="ghost" size="sm" loading={canceling} onClick={handleCancel}>
              {!canceling ? <Square size={11} strokeWidth={2.6} aria-hidden="true" /> : null}
              {canceling ? "Stopping…" : "Stop"}
            </Button>
          </div>
        ) : null}
```

6. Remove the now-unused imports: `Square` from `lucide-react`, `Button` from `../ui/Button`, and `useCallback` if `handleRespond` is the only remaining user (it is not — keep `useCallback`).

Keep `isActive`, the `Ban` banner, and everything else untouched.

- [ ] **Step 4: Swap ThreadView's props**

In `apps/web/src/components/chat/ThreadView.tsx`:

Replace the two prop declarations:

```ts
  /** Stop an in-flight run (stable identity). */
  onCancel?: (runId: string) => void;
  /** The run whose stop request is in flight (disables its button). */
  cancelingRunId?: string | null;
```

with:

```ts
  /** Stop whichever run holds the session's slot. Rendered on the composer. */
  onStop?: () => void;
  /** True while the stop request is in flight. */
  stopping?: boolean;
```

Update the destructured params accordingly, drop `onCancel`/`canceling` from the `<RunMessage>` call, and pass the new props to `<Composer>`:

```tsx
        <Composer
          onSend={onSend}
          disabledReason={composerDisabledReason}
          onStop={onStop}
          stopping={stopping}
          sending={sending}
          initialValue={failedDraft}
        />
```

- [ ] **Step 5: Compute the stop target in ThreadContainer**

In `apps/web/src/components/chat/ThreadContainer.tsx`, after the `slotHeld` computation (around line 190), add:

```ts
  // The slot holder, read for its run id. Same predicate as `slotHeld` — only
  // one run can hold the slot, so "the one to stop" is unambiguous.
  const stoppableRunId =
    [...runViews]
      .reverse()
      .find(
        (run) =>
          !run.canceled && (isActiveStatus(run.status) || run.status === "waiting"),
      )?.runId ?? null;
```

Then change the `onCancel` callback to take no argument:

```ts
  const onStop = useCallback(() => {
    if (stoppableRunId === null) return;
    setBusyNotice(null);
    cancelMutate(
      { runId: stoppableRunId },
      {
        onError: (mutationError) => setBusyNotice(errorMessage(mutationError)),
      },
    );
  }, [cancelMutate, stoppableRunId]);
```

And in the `<ThreadView>` call, replace:

```tsx
        onCancel={onCancel}
        cancelingRunId={cancelRun.isPending ? (cancelRun.variables?.runId ?? null) : null}
```

with:

```tsx
        onStop={stoppableRunId !== null ? onStop : undefined}
        stopping={cancelRun.isPending}
```

- [ ] **Step 6: Rewire FixtureChatShell**

In `apps/web/src/components/chat/FixtureChatShell.tsx`, replace line 200:

```tsx
      onCancel={(runId) => setStopped((prev) => new Set(prev).add(runId))}
```

with:

```tsx
      onStop={
        lastRun !== undefined &&
        !lastRun.canceled &&
        (lastRun.status === "queued" ||
          lastRun.status === "running" ||
          lastRun.status === "waiting")
          ? () => setStopped((prev) => new Set(prev).add(lastRun.runId))
          : undefined
      }
```

- [ ] **Step 7: Update the fixture Stop test**

In `apps/web/src/__tests__/fixture-chat.test.tsx`, the test at line 128 already looks up `getByRole("button", { name: "Stop" })` — which now resolves to the composer's button. Only the final assertion needs adjusting, because the composer's Stop disappears when the run settles:

```tsx
test("fixture mode can actually stop a running run (backend-free preview)", async () => {
  const view = renderWithRouter(<FixtureChatShell />);
  // The first session is the live streaming run. Stop now lives on the
  // composer, so it is reachable without scrolling the virtualized thread.
  const stop = await view.findByRole("button", { name: "Stop" });
  fireEvent.click(stop);
  expect(view.getByText(/You stopped this run/)).toBeTruthy();
  await waitFor(() =>
    expect(view.queryByRole("button", { name: "Stop" })).toBeNull(),
  );
});
```

Add `waitFor` to the `@testing-library/react` import if it is not already there.

- [ ] **Step 8: Run the unit lane**

Run: `bun run typecheck && bun test`
Expected: PASS.

- [ ] **Step 9: Rework the e2e approval spec**

In `e2e/specs/chat-approval.e2e.ts`, the composer no longer disables during a run, so `toBeEnabled()` is no longer a run-completion signal — it is now vacuously true and the following click can fire while the slot is still held.

Replace the first occurrence (around lines 80-83):

```ts
  // The card is dismissed and the run completes (composer re-enabled).
  await expect(card).toBeHidden({ timeout: RUN_TIMEOUT_MS });
  await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled({
    timeout: RUN_TIMEOUT_MS,
  });
```

with:

```ts
  // The card is dismissed and the run completes. The composer never disables
  // any more, so the completion signal is the SUBMIT BUTTON'S NAME: it reads
  // "Queue message" (or is replaced by Stop) exactly while the session's run
  // slot is held, and returns to "Send message" when the slot frees.
  await expect(card).toBeHidden({ timeout: RUN_TIMEOUT_MS });
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible({
    timeout: RUN_TIMEOUT_MS,
  });
```

Replace the second occurrence (around lines 105-109), after the Stop assertions:

```ts
  // Cancellation leaves the SESSION usable; the composer comes back.
  await expect(page.getByRole("textbox", { name: "Message" })).toBeEnabled({
    timeout: RUN_TIMEOUT_MS,
  });
```

with:

```ts
  // Cancellation leaves the SESSION usable: the slot frees, so the submit
  // button goes back to being a send.
  await expect(page.getByRole("button", { name: "Send message" })).toBeVisible({
    timeout: RUN_TIMEOUT_MS,
  });
```

The `getByRole("button", { name: "Stop" }).click()` call is unchanged — the composer's Stop carries the same accessible name, and it is now the only one on the page.

- [ ] **Step 10: Run the e2e lane**

Run: `cd e2e && bunx playwright test specs/chat-approval.e2e.ts --workers=1`
Expected: PASS. The harness manages its own stack; first run may take several minutes.

If chromium is missing: `cd e2e && bunx playwright install chromium`.

- [ ] **Step 11: Commit**

```bash
git add apps/web/src/components/chat/RunMessage.tsx \
        apps/web/src/components/chat/ThreadView.tsx \
        apps/web/src/components/chat/ThreadContainer.tsx \
        apps/web/src/components/chat/FixtureChatShell.tsx \
        apps/web/src/__tests__/chat-thread.test.tsx \
        apps/web/src/__tests__/fixture-chat.test.tsx \
        e2e/specs/chat-approval.e2e.ts
git commit -m "feat(web): move chat Stop from the transcript onto the composer"
```

---

## Task 4: Wire the queue into the thread

**Files:**
- Create: `apps/web/src/components/chat/QueuedMessages.tsx`
- Modify: `apps/web/src/components/chat/ThreadContainer.tsx`
- Modify: `apps/web/src/components/chat/ThreadView.tsx`
- Modify: `apps/web/src/__tests__/chat-container.test.tsx`

**Interfaces:**
- Consumes: `useMessageQueue`, `QueuedMessage`, `mergeQueued` (Task 1); `ComposerProps.hint` / `queueing` (Task 2); `ThreadViewProps.onStop` (Task 3).
- Produces:
  ```ts
  interface QueuedMessagesProps {
    messages: readonly QueuedMessage[]
    onRemove: (id: string) => void
  }
  ```
  `ThreadViewProps` gains `queued?: readonly QueuedMessage[]`, `onRemoveQueued?: (id: string) => void`, `composerHint?: string | null`, `queueing?: boolean`.

- [ ] **Step 1: Write the failing container tests**

Append to `apps/web/src/__tests__/chat-container.test.tsx`:

```tsx
// ── message queue ───────────────────────────────────────────────────────────

test("a message typed during a run is queued, then sent as one message", async () => {
  handler = (method, url) => {
    if (method === "GET" && url.includes(`/sessions/${SESSION_ID}`)) {
      return json(sessionResponse("running"));
    }
    if (method === "POST" && url.includes("/messages")) {
      return json({ run: { ...sessionResponse("queued").runs[0], id: "run_2" } });
    }
    return json({}, 404);
  };
  const view = renderContainer();
  const box = await view.findByLabelText("Message");

  // The run is live, so the composer is in queueing mode — and still typeable.
  await waitFor(() =>
    expect(view.getByRole("button", { name: "Stop" })).toBeTruthy(),
  );
  pasteInto(box, "also mention the Tiptap swap");
  pressEnter(box);
  pasteInto(box, "keep it under 200 words");
  pressEnter(box);

  // Both sit in the strip; nothing has been POSTed.
  await waitFor(() =>
    expect(view.getByText(/also mention the Tiptap swap/)).toBeTruthy(),
  );
  expect(view.getByText(/keep it under 200 words/)).toBeTruthy();
  expect(requests.filter((r) => r.url.includes("/messages"))).toHaveLength(0);

  // The run settles → the slot frees → the queue flushes as ONE message.
  liveStores.set(RUN_ID, { store: EMPTY_FRAME_STORE, status: "succeeded" });
  view.rerender(view.container.firstChild as never);

  await waitFor(() => {
    const posts = requests.filter((r) => r.url.includes("/messages"));
    expect(posts).toHaveLength(1);
    expect((posts[0]?.body as { message: string }).message).toBe(
      "also mention the Tiptap swap\n\nkeep it under 200 words",
    );
  });
});

test("the composer Stop cancels the run that holds the slot", async () => {
  handler = (method, url) => {
    if (method === "GET" && url.includes(`/sessions/${SESSION_ID}`)) {
      return json(sessionResponse("running"));
    }
    if (method === "POST" && url.includes(`/runs/${RUN_ID}/cancel`)) {
      return json({ run: { ...sessionResponse("canceled").runs[0], status: "canceled" } });
    }
    return json({}, 404);
  };
  const view = renderContainer();

  const stop = await view.findByRole("button", { name: "Stop" });
  fireEvent.click(stop);

  await waitFor(() =>
    expect(requests.some((r) => r.url.includes(`/runs/${RUN_ID}/cancel`))).toBe(true),
  );
});

test("a queued message survives a stop and flushes afterwards", async () => {
  handler = (method, url) => {
    if (method === "GET" && url.includes(`/sessions/${SESSION_ID}`)) {
      return json(sessionResponse("running"));
    }
    if (method === "POST" && url.includes("/cancel")) {
      return json({ run: { ...sessionResponse("canceled").runs[0], status: "canceled" } });
    }
    if (method === "POST" && url.includes("/messages")) {
      return json({ run: { ...sessionResponse("queued").runs[0], id: "run_2" } });
    }
    return json({}, 404);
  };
  const view = renderContainer();
  const box = await view.findByLabelText("Message");

  pasteInto(box, "actually use zod");
  pressEnter(box);
  await waitFor(() => expect(view.getByText(/actually use zod/)).toBeTruthy());

  fireEvent.click(view.getByRole("button", { name: "Stop" }));
  // Stop cancels the turn only — the follow-up explaining WHY is exactly what
  // the user still wants delivered.
  liveStores.set(RUN_ID, { store: EMPTY_FRAME_STORE, status: "canceled" });
  view.rerender(view.container.firstChild as never);

  await waitFor(() => {
    const posts = requests.filter((r) => r.url.includes("/messages"));
    expect((posts[0]?.body as { message: string }).message).toBe("actually use zod");
  });
});

test("a FAILED run flushes the queue too", async () => {
  handler = (method, url) => {
    if (method === "GET" && url.includes(`/sessions/${SESSION_ID}`)) {
      return json(sessionResponse("running"));
    }
    if (method === "POST" && url.includes("/messages")) {
      return json({ run: { ...sessionResponse("queued").runs[0], id: "run_2" } });
    }
    return json({}, 404);
  };
  const view = renderContainer();
  const box = await view.findByLabelText("Message");

  pasteInto(box, "try again with the other model");
  pressEnter(box);

  liveStores.set(RUN_ID, { store: EMPTY_FRAME_STORE, status: "failed" });
  view.rerender(view.container.firstChild as never);

  await waitFor(() =>
    expect(requests.filter((r) => r.url.includes("/messages"))).toHaveLength(1),
  );
});

test("removing a queued row drops it before it is ever sent", async () => {
  handler = (method, url) => {
    if (method === "GET" && url.includes(`/sessions/${SESSION_ID}`)) {
      return json(sessionResponse("running"));
    }
    return json({}, 404);
  };
  const view = renderContainer();
  const box = await view.findByLabelText("Message");

  pasteInto(box, "scrap this one");
  pressEnter(box);
  await waitFor(() => expect(view.getByText(/scrap this one/)).toBeTruthy());

  fireEvent.click(view.getByRole("button", { name: /Remove queued message/ }));
  await waitFor(() => expect(view.queryByText(/scrap this one/)).toBeNull());
});
```

Add `fireEvent` to the `@testing-library/react` import in this file if it is not already present.

- [ ] **Step 2: Run to verify they fail**

Run: `bun test apps/web/src/__tests__/chat-container.test.tsx`
Expected: FAIL — no queue strip renders and Enter during a run sends nothing.

- [ ] **Step 3: Build the queue strip**

Create `apps/web/src/components/chat/QueuedMessages.tsx`:

```tsx
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
```

- [ ] **Step 4: Render the strip and fix autoscroll in ThreadView**

In `apps/web/src/components/chat/ThreadView.tsx`:

Add to `ThreadViewProps`:

```ts
  /** Messages waiting for the session's run slot to free. */
  queued?: readonly QueuedMessage[];
  onRemoveQueued?: (id: string) => void;
  /** Non-blocking composer notice (queue retry state, transient errors). */
  composerHint?: string | null;
  /** Submit means enqueue. */
  queueing?: boolean;
```

and **replace** the existing `failedDraft?: string` prop with:

```ts
  /** Text handed back after a failed send — appended, never replacing. */
  restoreDraft?: string | null;
  onRestoreConsumed?: () => void;
```

with `import type { QueuedMessage } from "../../lib/chat/use-message-queue";` and `import { QueuedMessages } from "./QueuedMessages";`.

Add `queued.length` to the autoscroll layout effect — the strip sits below the scroll container, so growing it shrinks the transcript viewport with nothing to re-pin:

```ts
  const queuedCount = queued?.length ?? 0;
  useLayoutEffect(() => {
    if (stickToBottom.current && runs.length > 0) {
      virtualizer.scrollToIndex(runs.length - 1, { align: "end" });
    }
  }, [runs.length, streamSignature, queuedCount, virtualizer]);
```

Render the strip between the context divider and the composer, and pass the new composer props:

```tsx
        <QueuedMessages messages={queued ?? []} onRemove={onRemoveQueued ?? (() => {})} />
        <Composer
          onSend={onSend}
          disabledReason={composerDisabledReason}
          hint={composerHint}
          onStop={onStop}
          stopping={stopping}
          queueing={queueing}
          restoreDraft={restoreDraft}
          onRestoreConsumed={onRestoreConsumed}
          sending={sending}
        />
```

`initialValue` is gone from this call site — `NewChatComposer` in `ChatShell.tsx` is the only remaining user of it.

- [ ] **Step 5: Wire the container**

In `apps/web/src/components/chat/ThreadContainer.tsx`:

Add the imports:

```ts
import { useMessageQueue } from "../../lib/chat/use-message-queue";
```

Rename the `failedDraft` state to `restoreDraft` — its consumer is now the append path, not the replace path:

```ts
  const [restoreDraft, setRestoreDraft] = useState<string | null>(null);
```

Then wire the queue. `onGiveUp` goes to `setRestoreDraft`, **never** to a value that reaches `initialValue`:

```ts
  // `postMessage.mutateAsync` so the queue can await the outcome. The direct
  // `send` path below keeps using `mutate` with callbacks.
  const postMessageAsync = postMessage.mutateAsync;
  const sendForQueue = useCallback(
    async (message: string) => {
      await postMessageAsync({ sessionId, message });
    },
    [postMessageAsync, sessionId],
  );

  const queue = useMessageQueue({
    canFlush: !slotHeld && !sessionRetired && !postMessage.isPending,
    send: sendForQueue,
    onGiveUp: setRestoreDraft,
    onRetired: () => setSessionRetired(true),
  });
```

Change the direct `send` so a transient busy 409 **enqueues** instead of returning a failed draft — with `queued.length > 0` forcing the queue path afterwards, this makes the queue the single owner of busy recovery:

```ts
          onError: (mutationError) => {
            if (isSessionBusy(mutationError)) {
              // The slot was taken between the click and the POST (a stale
              // `slotHeld`, or another tab). Hand it to the queue rather than
              // making the user re-send.
              queue.enqueue(message);
              return;
            }
            setRestoreDraft(message);
            if (isSessionOver(mutationError)) {
              setSessionRetired(true);
              setBusyNotice(
                "This session has been retired and can’t take new messages. Start a new chat to keep going — your text is still here to copy.",
              );
            } else {
              setBusyNotice(errorMessage(mutationError));
            }
          },
```

Route submit through the queue when the slot is held:

```ts
  const queueing = slotHeld || postMessage.isPending || queue.queued.length > 0;
  const onSubmit = useCallback(
    (message: string) => {
      if (queueing) {
        queue.enqueue(message);
        return;
      }
      send(message);
    },
    [queue, queueing, send],
  );
```

Replace `composerDisabledReason` with the split:

```ts
  const composerDisabledReason = sessionRetired
    ? "This session has been retired — start a new chat."
    : null;
  const composerHint =
    queue.notice ??
    busyNotice ??
    (awaitingApproval
      ? "Waiting for your response above — anything you send now is queued."
      : null);
```

And update the `<ThreadView>` call:

```tsx
        onSend={onSubmit}
        composerDisabledReason={composerDisabledReason}
        composerHint={composerHint}
        queueing={queueing}
        queued={queue.queued}
        onRemoveQueued={queue.remove}
        restoreDraft={restoreDraft}
        onRestoreConsumed={() => setRestoreDraft(null)}
```

Delete the old `failedDraft={failedDraft}` line. Also update the direct send's success handler — `setFailedDraft(undefined)` becomes `setRestoreDraft(null)`.

- [ ] **Step 6: Run the container tests**

Run: `bun test apps/web/src/__tests__/chat-container.test.tsx`
Expected: PASS — including the pre-existing 409 tests. The `session_busy` test at line 217 now asserts the enqueue path; if it still asserts a failed-draft restore, update it to expect the message in the queue strip instead, and update its comment to say why.

- [ ] **Step 7: Run the full unit lane**

Run: `bun run typecheck && bun test`
Expected: PASS.

- [ ] **Step 8: Eyeball it in fixture mode**

Run: `bun run --cwd apps/web dev` with `VITE_FIXTURE_MODE=1` set, open the chat section, and confirm: the strip appears with dashed rows, Stop sits on the composer, and the strip scrolls rather than growing past ~4 rows.

- [ ] **Step 9: Commit**

```bash
git add apps/web/src/components/chat/QueuedMessages.tsx \
        apps/web/src/components/chat/ThreadView.tsx \
        apps/web/src/components/chat/ThreadContainer.tsx \
        apps/web/src/__tests__/chat-container.test.tsx
git commit -m "feat(web): queue chat messages during a run and flush them as one send"
```

---

## Task 5: Discard guards

**Files:**
- Create: `apps/web/src/components/chat/DiscardQueueDialog.tsx`
- Create: `apps/web/src/__tests__/chat-shell.test.tsx`
- Modify: `apps/web/src/components/chat/ThreadContainer.tsx`
- Modify: `apps/web/src/components/chat/ChatShell.tsx`
- Create: `.changeset/composer-stop-and-message-queue.md`

**Interfaces:**
- Consumes: `queue.queued` (Task 4).
- Produces: `ThreadContainerProps` gains `onQueuedCountChange?: (count: number) => void`.

- [ ] **Step 1: Write the failing ChatShell test**

Create `apps/web/src/__tests__/chat-shell.test.tsx`:

```tsx
/**
 * ChatShell's discard guard: switching sessions with a non-empty queue must
 * ask first, because the queue is per-thread and the keyed ThreadContainer
 * remounts on switch — which would drop typed text with no trace.
 */
import { ensureDomForThisFile } from "../test/setup";

import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { renderWithRouter } from "../test/router";
import { ToastProvider } from "../components/ui/Toast";
import { DiscardQueueDialog } from "../components/chat/DiscardQueueDialog";

ensureDomForThisFile();
afterEach(cleanup);

test("the discard dialog names how many messages are at stake", () => {
  const onConfirm = mock(() => {});
  const view = render(
    <DiscardQueueDialog open count={2} onClose={() => {}} onConfirm={onConfirm} />,
  );
  expect(view.getByText(/Discard 2 queued messages\?/)).toBeTruthy();
  fireEvent.click(view.getByRole("button", { name: /Discard/ }));
  expect(onConfirm).toHaveBeenCalledTimes(1);
});

test("one queued message is singular — copy must not read '1 messages'", () => {
  const view = render(
    <DiscardQueueDialog open count={1} onClose={() => {}} onConfirm={() => {}} />,
  );
  expect(view.getByText(/Discard 1 queued message\?/)).toBeTruthy();
});

test("the dialog closes itself when a flush empties the queue underneath it", async () => {
  const onClose = mock(() => {});
  const view = render(
    <DiscardQueueDialog open count={2} onClose={onClose} onConfirm={() => {}} />,
  );
  // The queue flushed while the dialog was open: there is nothing left to
  // discard, and offering to discard already-sent messages is a lie.
  view.rerender(
    <DiscardQueueDialog open count={0} onClose={onClose} onConfirm={() => {}} />,
  );
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `bun test apps/web/src/__tests__/chat-shell.test.tsx`
Expected: FAIL — `Cannot find module '../components/chat/DiscardQueueDialog'`.

- [ ] **Step 3: Build the dialog**

Create `apps/web/src/components/chat/DiscardQueueDialog.tsx`:

```tsx
/**
 * Shared confirm for every path that would drop a non-empty message queue:
 * an in-pane session switch, a route navigation, and "New chat".
 *
 * It self-closes when the count reaches zero. A flush can land while the
 * dialog is open, and offering to discard messages that have already been
 * sent is worse than not asking at all.
 */
import { useEffect } from "react";

import { ConfirmDialog } from "../ui/ConfirmDialog";

export interface DiscardQueueDialogProps {
  open: boolean;
  count: number;
  onClose: () => void;
  onConfirm: () => void;
}

export function DiscardQueueDialog({
  open,
  count,
  onClose,
  onConfirm,
}: DiscardQueueDialogProps) {
  useEffect(() => {
    if (open && count === 0) onClose();
  }, [open, count, onClose]);

  const noun = count === 1 ? "message" : "messages";
  return (
    <ConfirmDialog
      open={open && count > 0}
      onClose={onClose}
      onConfirm={onConfirm}
      destructive
      title={`Discard ${count} queued ${noun}?`}
      description={`${count === 1 ? "It has" : "They have"} not been sent yet. Leaving this conversation drops ${count === 1 ? "it" : "them"}.`}
      confirmLabel="Discard"
      cancelLabel="Stay here"
    />
  );
}
```

- [ ] **Step 4: Run the dialog tests**

Run: `bun test apps/web/src/__tests__/chat-shell.test.tsx`
Expected: PASS — 3 tests.

- [ ] **Step 5: Report the queue depth and block route navigation**

In `apps/web/src/components/chat/ThreadContainer.tsx`:

Add to `ThreadContainerProps`:

```ts
  /** Lets the owner of session selection guard a switch away from a live queue. */
  onQueuedCountChange?: (count: number) => void;
```

Add the reporting effect and the router blocker (after the `queue` is created):

```ts
  // A ref, not a render closure: `shouldBlockFn` is registered once, and a
  // flush that empties the queue mid-navigation must be visible to it.
  const queuedCountRef = useRef(0);
  queuedCountRef.current = queue.queued.length;

  useEffect(() => {
    onQueuedCountChange?.(queue.queued.length);
  }, [onQueuedCountChange, queue.queued.length]);

  // `enableBeforeUnload` DEFAULTS TO TRUE. Leaving it out installs a
  // reload/tab-close prompt on every thread with a queue — deliberately out
  // of scope for a client-side draft.
  const blocker = useBlocker({
    shouldBlockFn: () => queuedCountRef.current > 0,
    enableBeforeUnload: false,
    withResolver: true,
  });
```

with `import { useBlocker } from "@tanstack/react-router";` and `useEffect` added to the React import.

Render the dialog alongside the reset confirm:

```tsx
      <DiscardQueueDialog
        open={blocker.status === "blocked"}
        count={queue.queued.length}
        onClose={() => blocker.reset?.()}
        onConfirm={() => {
          queue.clear();
          blocker.proceed?.();
        }}
      />
```

Add the queued count to the reset confirm's body — reset bypasses both guards, because `onSessionReplaced` remounts the keyed container:

```tsx
        {queue.queued.length > 0 ? (
          <p className="mt-2 text-[13px] leading-relaxed text-ink-3">
            The {queue.queued.length === 1 ? "message" : `${queue.queued.length} messages`} waiting
            to send {queue.queued.length === 1 ? "is" : "are"} discarded too.
          </p>
        ) : null}
```

- [ ] **Step 6: Intercept session switching in ChatShell**

In `apps/web/src/components/chat/ChatShell.tsx`, add state and the interception:

```tsx
  const [queuedCount, setQueuedCount] = useState(0);
  /** A switch the user asked for, held until they resolve the discard prompt. */
  const [pendingSwitch, setPendingSwitch] = useState<
    { kind: "session"; sessionId: string } | { kind: "new" } | null
  >(null);

  function applySwitch(target: { kind: "session"; sessionId: string } | { kind: "new" }) {
    setQueuedCount(0);
    if (target.kind === "new") {
      setPickerOpen(true);
      return;
    }
    setDraftAgent(null);
    setActiveSessionId(target.sessionId);
  }

  function requestSwitch(target: { kind: "session"; sessionId: string } | { kind: "new" }) {
    if (queuedCount > 0) {
      setPendingSwitch(target);
      return;
    }
    applySwitch(target);
  }
```

Point `SessionList` at it:

```tsx
          onSelect={(id) => requestSwitch({ kind: "session", sessionId: id })}
          onNewChat={() => requestSwitch({ kind: "new" })}
```

Pass the reporter to `ThreadContainer`:

```tsx
            onQueuedCountChange={setQueuedCount}
```

And render the dialog next to the picker:

```tsx
      <DiscardQueueDialog
        open={pendingSwitch !== null}
        count={queuedCount}
        onClose={() => setPendingSwitch(null)}
        onConfirm={() => {
          const target = pendingSwitch;
          setPendingSwitch(null);
          if (target !== null) applySwitch(target);
        }}
      />
```

- [ ] **Step 7: Run the full unit lane and typecheck**

Run: `bun run typecheck && bun test`
Expected: PASS.

If `useBlocker`'s options differ from `{ shouldBlockFn, enableBeforeUnload, withResolver }`, read `node_modules/@tanstack/react-router/dist/esm/useBlocker.d.ts` and adjust — `enableBeforeUnload: false` is non-negotiable regardless of the surrounding shape.

- [ ] **Step 8: Write the changeset**

Create `.changeset/composer-stop-and-message-queue.md`:

```md
---
"@invisible-string/web": minor
---

Move the chat Stop control onto the composer's send button and queue messages typed during a run, merging them into one send when the session frees.
```

The summary must stay one line — `parseChangeset` collapses the body into a single space-joined line.

- [ ] **Step 9: Update the spec's status note**

In `docs/superpowers/specs/2026-08-09-composer-stop-and-message-queue-design.md` §4, replace the "Verify before trusting the queue's only automatic exit" paragraph's final sentence with the finding: state whether cancelling a run behind a dead eve session settles the row to `canceled`, citing the control-plane file you checked. If it does not, open a follow-up note in AGENTS.md's "Known residuals".

- [ ] **Step 10: Run every affected lane**

Run: `bun run typecheck && bun test && cd e2e && bunx playwright test --workers=1`
Expected: PASS.

- [ ] **Step 11: Commit**

```bash
git add apps/web/src/components/chat/DiscardQueueDialog.tsx \
        apps/web/src/components/chat/ThreadContainer.tsx \
        apps/web/src/components/chat/ChatShell.tsx \
        apps/web/src/__tests__/chat-shell.test.tsx \
        docs/superpowers/specs/2026-08-09-composer-stop-and-message-queue-design.md \
        .changeset/composer-stop-and-message-queue.md
git commit -m "feat(web): guard session switches and navigation against discarding a queue"
```

---

## Verification checklist

Before claiming done:

- [ ] `bun run typecheck` passes
- [ ] `bun test` passes (root lane — includes every new suite)
- [ ] `cd e2e && bunx playwright test --workers=1` passes
- [ ] `VITE_FIXTURE_MODE=1` chat preview shows the strip, composer Stop, and a capped queue height
- [ ] The changeset file exists and is **staged** (never `git clean -fd .changeset`)
- [ ] No commit message mentions AI assistance
