# Composer Stop + client-side message queue — Design (2026-08-09)

Supersedes the chat-composer row of `docs/superpowers/specs/2026-08-08-tiptap-editors-design.md` §2 (*"Chat **Composer** — chrome: none — Enter sends, Shift+Enter newlines"*). The composer now carries chrome (a Stop control and a queued-message strip) and Enter has a second meaning. Everything else in that spec still binds — the markdown bridge, the debounced serialization, and the `flush()`-on-send rule in particular.

---

## 1. Decision

Two changes to the chat pane, coupled because they share the same predicate:

1. **Stop moves onto the send button.** While a run holds the session's run slot, the composer's ink circle becomes a Stop square. The per-run Stop button in the transcript (`chat/RunMessage.tsx:156-163`) is deleted.
2. **The composer stays live during a run, and Enter queues.** Messages typed while a run is working accumulate in a client-side queue rendered above the composer. When the slot frees, the queue **merges into one message** and sends as a single turn.

No server change. No new endpoint, no schema change, no `COMPILER_VERSION` bump. The queue is browser state that exists only to defer a call the control plane would otherwise reject.

### Why the queue must gate on the slot, not on "is something streaming"

The control plane allows **one run per session**, and `waiting` counts as busy — a run parked on a human-in-the-loop approval still owns the eve turn. `ThreadContainer.tsx:188-190` already computes this exactly:

```ts
const slotHeld = runViews.some(
  (run) => !run.canceled && (isActiveStatus(run.status) || run.status === "waiting"),
);
```

A message posted while `slotHeld` is true comes back 409 `session_busy`. That is the transient 409 — retry is the correct recovery, and it must never be confused with `session_not_active`, which is permanent for that session id (AGENTS.md, "Two 409s, opposite recoveries"). The queue is therefore a client-side implementation of the same serialization the server already enforces; `slotHeld` is its flush gate, and the two 409s remain its two distinct failure paths.

---

## 2. The composer's disabled/hint split

`Composer.tsx`'s `disabledReason` currently means two things at once: *show this text* **and** *freeze the editor* (`Composer.tsx:42`, `readOnly={disabled}`). That conflation is what makes typing during a run impossible, so it is split.

| prop | status | meaning |
|---|---|---|
| `disabledReason?: string \| null` | narrowed | Genuinely blocked — the editor goes read-only. **Only** a retired session. |
| `hint?: string \| null` | new | Non-blocking notice under/above the capsule. Editor stays live. |
| `onStop?: () => void` | new | Present ⇒ a run is stoppable ⇒ render the Stop control. |
| `stopping?: boolean` | new | Stop request in flight — spinner in the Stop circle, control disabled. |
| `queueing?: boolean` | new | Submit means *queue*: changes the placeholder and the button's accessible name. |

`ThreadContainer` supplies them:

```ts
disabledReason = sessionRetired ? "This session has been retired — start a new chat." : null
hint           = busyNotice ?? (awaitingApproval ? "Waiting for your response above — anything you send now is queued." : null)
queueing       = slotHeld || postMessage.isPending
onStop         = stoppableRunId !== null ? () => onCancel(stoppableRunId) : undefined
```

`queueing` includes `postMessage.isPending` to close the gap between a send leaving the browser and the accepted run reaching `runViews`. In that window the slot is held in fact but not yet in state, and `Composer.submit()`'s current `if (… || sending) return` (`Composer.tsx:57`) would **drop** a fast second Enter on the floor. Queuing it instead is the only behavior consistent with the promise the strip makes. That early-return therefore guards the *send* path only; the queue path takes anything non-empty.

The three strings that used to disable the box (`"Working… you can send a follow-up when this run finishes."`, `"Waiting for your response above."`, and every `busyNotice`) stop disabling it. The first is deleted outright — the queue is the answer it was apologizing for.

### Button states

The composer renders from three booleans — `onStop != null`, `queueing`, `hasText`:

| `onStop` | `queueing` | text | rendering |
|---|---|---|---|
| — | — | no | ink ↑, disabled |
| — | — | yes | ink ↑ — **Send message** |
| — | ✓ | yes | ink ↑ — **Queue message** |
| ✓ | ✓ | no | ink ■ — **Stop** |
| ✓ | ✓ | yes | ghost ■ **Stop** + ink ↑ — **Queue message** |

`onStop` without `queueing` is unreachable — a stoppable run holds the slot by definition. The reverse (`queueing` without `onStop`) is the in-flight window above: the message is on the wire, so there is a slot to respect but no run id to cancel yet.

The ghost/ink weighting is deliberate and follows `Button.tsx`'s existing `ghost` variant (`border-black/10 bg-white/40`): in the fourth state the user's primary intent is the thing they just typed, and stopping is secondary. Both remain one click away, which is what rules out a single morphing button — it would make queuing mouse-inaccessible.

This matches `CopilotDock.tsx:480-501`, which already swaps its send button for a `Square` Stop while `copilot.generating`. The chat composer was the inconsistent surface; after this change the two composers agree. The copilot dock is **not** otherwise touched — it has no queue and no server-side run slot.

### Keyboard

- **Enter** — submits: sends when the slot is free, queues when it is held. Unchanged otherwise (Shift+Enter newlines, IME-composition guard at `Composer.tsx:67-74`).
- **Escape** — stops the run, but only while `onStop` is present. Unbound in this editor today, so nothing collides.

**The `flush()` rule survives intact.** `RichTextEditor` serializes on a 180 ms idle debounce, so `value` lags the caret; every submit path — send *and* queue — must read `editorRef.current.flush()`, not React state (`Composer.tsx:55-65`). Queuing the debounced value would drop the tail of a fast follow-up, which is the exact bug that header exists to prevent.

---

## 3. The queue

### Shape

```ts
interface QueuedMessage {
  id: string;    // "qm_" + 13 lowercase alphanumerics
  text: string;  // markdown, exactly as flushed from the editor
}
```

Ids follow the existing client-side pattern in `apps/web/src/lib/slug.ts:16` (`crypto.randomUUID()` stripped and sliced) rather than adding a `nanoid` dependency for what are React list keys. They never leave the browser.

### The hook

New `apps/web/src/lib/chat/use-message-queue.ts`, isolated the way `use-thread-streams.ts` isolates the other hard part of this pane, so the flush state machine is unit-testable without a DOM:

```ts
useMessageQueue({
  canFlush: boolean,                        // !slotHeld && !sessionRetired && !sending
  send: (text: string) => Promise<void>,    // postMessage.mutateAsync — rejects on error
  onGiveUp: (mergedText: string) => void,   // hand the text back to the composer
  onRetired: () => void,
}) => { queued, enqueue, remove, clear }
```

### Merge semantics

On flush the queue collapses to **one** message:

```ts
const merged = queued.map((m) => m.text).join("\n\n");
```

`\n\n` because every queued item is markdown and a blank line is the only separator that keeps two items as distinct paragraphs under CommonMark — a single `\n` would fold `keep it short` into the previous item's paragraph.

One merged send means one run, one user bubble, one reply. The strip's label states this rather than letting the user infer it: **"Queued · sends as one message when this finishes."**

### Flush state machine

| trigger | action |
|---|---|
| `canFlush` goes true, queue non-empty | send `merged` |
| send resolves | `clear()` |
| send rejects `session_busy` | keep the queue, hint *"Still finishing up — your queued message will send shortly."*, retry after 2 s |
| 5 consecutive `session_busy` failures | `onGiveUp(merged)` → text returns to the composer as a failed draft, queue clears, hint explains |
| send rejects `session_not_active` / `session_not_continuable` | `onRetired()` → `onGiveUp(merged)`, queue clears |
| any other rejection | `onGiveUp(merged)`, queue clears, hint carries `errorMessage(error)` |

The bounded retry is deliberate: an unbounded loop against a server that has decided the session is busy forever would silently hold the user's text hostage. Five attempts over ~10 s covers the real race — `slotHeld` is derived from SSE frames and run rows, which can lead the control plane's own view by a beat — and anything longer is a genuine fault the user should see.

`session_busy` classification reuses `isSessionBusy` (`lib/api-client.ts`); the terminal pair reuses `ThreadContainer`'s existing `isSessionOver` helper (`ThreadContainer.tsx:95-99`), which is lifted to a shared spot so the hook and the container agree by construction.

### Stop does not touch the queue

Stopping cancels the in-flight turn only. The canceled run releases the slot, `canFlush` goes true, and the queue flushes into a fresh run. Stop and queue are separate intents: stopping a wrong answer is exactly when the follow-up explaining *why* it was wrong matters most.

### UI

New `apps/web/src/components/chat/QueuedMessages.tsx` — presentational, no state:

- Rendered between the transcript and the composer, inside `ThreadView`'s existing `max-w-3xl` column, adjacent to the `ContextDivider` slot.
- Uppercase micro-label, then one dashed-border row per queued message: monospace index, truncated text, `×` remove button.
- Dashed border (not the solid card border used everywhere else) reads as *not yet real* — these rows are drafts, visually distinct from the sent bubbles above them.
- Empty queue renders nothing at all.
- `aria-live="polite"` on the strip so enqueue/remove is announced.

---

## 4. Stop leaves the transcript

`RunMessage.tsx` drops the `onCancel`/`canceling` props and the Stop button at lines 156-163, along with the `cancelable` / `onLimitPrompt` computation that gated it. The `Ban`-iconed **"You stopped this run"** confirmation banner stays exactly as it is — it explains a completed action rather than offering one, and its neutral-ink treatment is the E1 rule that stopping is a decision, not an error.

`ThreadView` swaps per-run `onCancel(runId)` + `cancelingRunId` for composer-level `onStop` + `stopping`.

`ThreadContainer` computes the target:

```ts
const stoppableRunId =
  [...runViews].reverse().find(
    (run) => !run.canceled && (isActiveStatus(run.status) || run.status === "waiting"),
  )?.runId ?? null;
```

Same predicate as `slotHeld`, read for its run id — only one run can hold the slot, so "the slot holder" is unambiguous.

**The session-limit exception is dropped deliberately.** `RunMessage.tsx:56-58` suppressed its Stop when a `session-limit` prompt was on screen, because that card offers its own "Stop" option through the same cancel path and two adjacent identical Stops is worse than one. In the composer that adjacency no longer exists — the card is in the transcript, the Stop is in the composer — so the suppression has no reason to survive, and keeping it would make Stop mysteriously vanish mid-run.

**Why this is a net accessibility gain:** the transcript is virtualized (`ThreadView.tsx:66-76`), so the Stop button could be scrolled out of the DOM entirely while a run streamed. The composer is fixed at the bottom of the pane, so Stop is now always rendered and always reachable — including by keyboard, where it is one Tab from the editor rather than an arbitrary distance into a virtualized list.

---

## 5. Leaving with a queue

A non-empty queue holds text the user typed and has not seen sent. Dropping it silently is the failure mode this guards.

Two entry points, one shared `DiscardQueueDialog` (a thin `ConfirmDialog` wrapper, `destructive`, copy naming the count):

| path | mechanism |
|---|---|
| In-pane session switch, "New chat" | `ThreadContainer` reports depth via `onQueuedCountChange`; `ChatShell` intercepts `SessionList`'s `onSelect` and `onNewChat` |
| Route navigation (sidebar → Agents/Workflows/Settings) | `useBlocker({ withResolver: true })` in `ThreadContainer` drives the same dialog |

`useBlocker` is safe here: `ThreadContainer` renders inside the route tree, and the chat suites already mount through `RouterProvider` (`__tests__/chat-thread.test.tsx:72`), so no test needs new scaffolding.

**Not covered:** browser tab close / reload. A `beforeunload` handler would fire on every reload of a thread with a queue and is disproportionate to a client-side draft. The queue is explicitly ephemeral — it does not survive a page load, and nothing persists it.

---

## 6. Testing

| Suite | Coverage |
|---|---|
| `__tests__/chat-composer.test.tsx` (extended) | Stop absent without `onStop`; ink Stop when running with an empty box; **both** controls when running with text; Enter queues (not sends) when `queueing`; Escape stops only while stoppable; the existing `flush()` cases still pass on the queue path |
| `__tests__/message-queue.test.ts` (**new**) | The hook with a stub `send`: merge separator, no flush while `canFlush` is false, flush on the false→true edge, `session_busy` retry then give-up at 5, terminal-error draft restore, remove/clear |
| `__tests__/chat-thread.test.tsx` (extended) | No Stop in the transcript; composer Stop cancels the slot-holding run; queue strip appears and clears; discard dialog on session switch |
| `components/chat/FixtureChatShell.tsx` | Rewired to composer-level cancel so `VITE_FIXTURE_MODE=1` still demonstrates stop + queue with no backend |

All of it lands in the default `bun test` lane — no DB, no key, no docker.

---

## 7. Documentation

Per the repo's docs-move-with-code rule:

- This spec, listed in `AGENTS.md`'s living-documents table, noting the supersession in §1.
- `.changeset/` entry naming **`@invisible-string/web`**, bump `minor`, one-line summary.

No `README.md` change — it does not describe composer mechanics. No `docs/runtime-worker-contract.md` change — the control-plane protocol is untouched.
