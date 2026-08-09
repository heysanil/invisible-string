# Composer Stop + client-side message queue — Design (2026-08-09)

Supersedes the chat-composer row of `docs/superpowers/specs/2026-08-08-tiptap-editors-design.md` §2 (*"Chat **Composer** — chrome: none — Enter sends, Shift+Enter newlines"*). The composer now carries chrome (a Stop control and a queued-message strip) and Enter has a second meaning. Everything else in that spec still binds — the markdown bridge, the debounced serialization, the `flush()`-on-send rule, and **the constant-placeholder rule** in particular.

---

## 1. Decision

Two changes to the chat pane, coupled because they share the same predicate:

1. **Stop moves onto the send button.** While a run holds the session's run slot, the composer's ink circle becomes a Stop square. The per-run Stop button in the transcript (`chat/RunMessage.tsx:156-163`) is deleted.
2. **The composer stays live during a run, and Enter queues.** Messages typed while a run is working accumulate in a client-side queue rendered above the composer. When the slot frees, the queued messages **merge into one message** and send as a single turn.

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
| `hint?: string \| null` | new | Non-blocking notice, rendered in the existing `aria-live="polite"` paragraph (`Composer.tsx:83-90`). Editor stays live. |
| `onStop?: () => void` | new | Present ⇒ a run is stoppable ⇒ render the Stop control. |
| `stopping?: boolean` | new | Stop request in flight — spinner in the Stop circle. |
| `queueing?: boolean` | new | Submit means *queue*: changes the submit button's accessible name to **Queue message**. |

### The placeholder does not change. Ever.

`queueing` must **not** swap the placeholder. `RichTextEditor`'s `useEditor` dependency array is `[extensions, ariaLabel, placeholder]` (`RichTextEditor.tsx:188`), so changing either string tears down and rebuilds the Tiptap instance and **destroys the draft in the box**. `Composer.tsx:98-102` already documents this, and it is why the copilot dock renders "Connecting…" as a separate paragraph instead of a placeholder (`CopilotDock.tsx:448-451`).

The failure this rule prevents is the feature's own core scenario: the user is mid-sentence, a run starts (or a flush lands and starts one), `queueing` flips, and the sentence disappears. **The queue affordance rides the submit button's `aria-label` and the `hint` line only.** The editor's `ariaLabel` stays `"Message"` for the same reason.

### What `ThreadContainer` supplies

```ts
disabledReason = sessionRetired ? "This session has been retired — start a new chat." : null
hint           = queueNotice ?? busyNotice
                   ?? (awaitingApproval ? "Waiting for your response above — anything you send now is queued." : null)
queueing       = slotHeld || postMessage.isPending || queued.length > 0
onStop         = stoppableRunId !== null ? () => onCancel(stoppableRunId) : undefined
```

`queueing` has three terms, and each closes a distinct ordering hole:

- **`slotHeld`** — the run is live; the server would 409.
- **`postMessage.isPending`** — the message is on the wire but the accepted run has not reached `runViews` yet. Without this term, `Composer.submit()`'s `if (… || sending) return` (`Composer.tsx:57`) silently **drops** a fast second Enter.
- **`queued.length > 0`** — the queue is non-empty but the slot is momentarily free: the render between the slot freeing and the flush effect firing, and the whole 2 s window between a `session_busy` rejection and its retry. Without this term a new message takes the *send* path, overtakes the queued text, and lands out of order — breaking the strip's own "sends as one message" promise.

That early-return therefore guards the **send** path only. The queue path accepts anything non-empty, and the submit button's `disabled` drops its `sending` term whenever `queueing` — otherwise a background flush would block queuing by mouse.

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

`onStop` without `queueing` is unreachable — a stoppable run holds the slot by definition. The reverse is the in-flight/backoff window above: a slot to respect, but no run id to cancel yet.

The ghost/ink weighting follows `Button.tsx`'s existing `ghost` variant: in the last state the user's primary intent is what they just typed, and stopping is secondary. Both stay one click away, which is what rules out a single morphing button — it would make queuing mouse-inaccessible.

This matches `CopilotDock.tsx:480-501`, which already swaps its send button for a `Square` Stop while `copilot.generating`. The chat composer was the inconsistent surface. The copilot dock is **not** otherwise touched — it has no queue and no server-side run slot.

**`stopping` clears when the cancel mutation resolves, not when the run settles.** Cancellation is cooperative at durable step boundaries, so a stopped turn can keep streaming for a while; the Stop control returns to its active state and the run stays visibly in flight. That is honest — the request landed, the turn has not ended yet — and it avoids a spinner that appears to hang.

### Keyboard

- **Enter** — submits: sends when free, queues when `queueing`. Shift+Enter newlines and the IME-composition guard (`Composer.tsx:67-74`) are unchanged.
- **Escape** — stops the run, only while `onStop` is present. Unbound in this editor today. (Escape inside an open `ConfirmDialog` belongs to the dialog; the composer is not focused there.)

**The `flush()` rule survives intact.** `RichTextEditor` serializes on a 180 ms idle debounce, so `value` lags the caret; every submit path — send *and* queue — reads `editorRef.current.flush()`, not React state (`Composer.tsx:55-65`). Queuing the debounced value would drop the tail of a fast follow-up.

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
  onGiveUp: (mergedText: string) => void,   // hand the text back, non-destructively
  onRetired: () => void,
  retryDelayMs?: number,                    // test seam; defaults to 2000
}) => { queued, enqueue, remove, clear, notice }
```

`notice` is a returned string (or null) carrying the retry/give-up copy — `ThreadContainer` feeds it into `hint` as `queueNotice`. Without it the state machine has user-visible states it cannot express.

`retryDelayMs` is injectable because **bun:test has no fake timers**; the same seam pattern is already established by `use-thread-streams`' injectable stream function.

### Merge semantics

On flush the queue collapses to **one** message:

```ts
const included = queued.map((m) => m.id);           // snapshot
const merged = queued.map((m) => m.text).join("\n\n");
```

`\n\n` because every queued item is markdown and a blank line is the only separator that keeps two items as distinct paragraphs under CommonMark. **Known limitation:** this holds for well-formed markdown only — a queued item ending in an unclosed code fence swallows the next item. Accepted; the user can see and remove rows before they flush.

One merged send means one run, one user bubble, one reply. The strip's label states this rather than letting the user infer it: **"Queued · sends as one message when this finishes."**

### Flush state machine

**Condition-triggered, not edge-triggered.** The rule is `canFlush && queued.length > 0 && !flushInFlight` evaluated every render — not "on the false→true edge of `canFlush`". An edge trigger strands anything enqueued while `canFlush` was already true.

| trigger | action |
|---|---|
| `canFlush && queued.length > 0 && !flushInFlight` | snapshot `included`, send `merged` |
| send resolves | remove **exactly `included`** — never a wholesale `clear()` |
| send rejects `session_busy` | keep the queue, `notice` = *"Still finishing up — your queued message will send shortly."*, schedule retry in `retryDelayMs` |
| `canFlush` goes false while a retry is pending | cancel the timer; the condition rule re-fires when it frees |
| 5 consecutive `session_busy` failures | `onGiveUp(merged)`, remove `included`, `notice` explains |
| send rejects `session_not_active` / `session_not_continuable` | `onRetired()` → `onGiveUp(merged)`, remove `included` |
| any other rejection | `onGiveUp(merged)`, remove `included`, `notice` carries `errorMessage(error)` |

**Removing `included` rather than clearing is load-bearing.** `queueing` is deliberately true during a flush, so Enter in that window enqueues — and a wholesale `clear()` would delete a message that was never part of the merged send. Each retry attempt re-merges from the *current* queue, so a late addition joins the next attempt in the right order.

The bounded retry is deliberate: an unbounded loop against a server that considers the session busy would hold the user's text hostage. Five attempts over ~10 s covers the client-lead race — `slotHeld` derives from SSE frames and run rows, which can lead the control plane's view by a beat.

**Accepted limitation — cross-client contention.** The budget is sized for that race, not for another tab legitimately holding the slot. This tab may never learn about it (`useSession` has a 5 s `staleTime` and no polling; SSE only covers runs it knows). In that case the flush burns its five attempts and gives the text back to the composer with an explanatory notice. That is a correct, non-destructive outcome, just a pessimistic one.

`session_busy` classification reuses `isSessionBusy` (`lib/api-client.ts`); the terminal pair reuses `isSessionOver` (`ThreadContainer.tsx:95-99`), **lifted into `lib/chat/` so the hook and the container agree by construction**.

### Give-up must not clobber the box

`onGiveUp` cannot route through `setFailedDraft` → `initialValue` → `setValue`. That path reaches `RichTextEditor`'s reconcile effect (`RichTextEditor.tsx:257-262`), which calls `applyExternalValue` and **replaces the document**. Today that is safe because the composer is disabled whenever a failed draft returns; under this spec the box is live, and a give-up firing ~10 s later would overwrite whatever the user is typing.

The restore therefore: **appends** through the editor handle when the box has content, and seeds it only when empty. The same hazard now applies to the existing direct-send failure restore (`ThreadContainer.tsx:205`), which moves to the same path.

### Direct-send `session_busy` auto-enqueues

A direct send that comes back 409 `session_busy` (stale `slotHeld`, or another tab) **enqueues the rejected text** instead of returning it as a failed draft. With `queued.length > 0` forcing the queue path, this makes the queue the single owner of all busy recovery and removes one clobber path. `session_not_active` is unchanged — permanent, retire, restore, offer a new chat.

### Stop does not touch the queue

Stopping cancels the in-flight turn only. The canceled run releases the slot, the flush condition holds, and the queue sends as a fresh run. Stop and queue are separate intents: stopping a wrong answer is exactly when the follow-up explaining *why* matters most.

### A failed run flushes the queue too

A `failed` run frees the slot like any other terminal state, so the queue sends. This is deliberate and symmetric with stop — the user's follow-up is often the correction — but it is stated here because it is surprising if undocumented, and it is tested explicitly.

### UI

New `apps/web/src/components/chat/QueuedMessages.tsx` — presentational, no state:

- Rendered between the transcript and the composer, inside `ThreadView`'s existing `max-w-3xl` column, adjacent to the `ContextDivider` slot.
- Uppercase micro-label, then one dashed-border row per queued message: monospace index, truncated text, `×` remove button.
- Dashed border (not the solid card border used elsewhere) reads as *not yet real* — drafts, visually distinct from the sent bubbles above.
- **Height-capped** (`max-h-32` + `thin-scroll`): an unbounded strip would steal the transcript's viewport.
- Empty queue renders nothing.
- `aria-live="polite"` on the strip; removing the last row returns focus to the composer.

**`×` removes, it does not edit.** Restoring a row into the composer for editing is deliberately out of scope — remove-and-retype is the whole recovery, and the row's text is visible while you do it.

### Autoscroll

`ThreadView`'s pin effect depends only on `runs.length` + `streamSignature` (`ThreadView.tsx:94-98`). The strip sits below the scroll container, so growing it shrinks the transcript viewport with nothing to re-pin — enqueueing while parked on an approval (no tokens flowing) pushes the approval card behind the composer. **`queued.length` joins that dependency list.**

---

## 4. Stop leaves the transcript

`RunMessage.tsx` drops the `onCancel`/`canceling` props and the Stop button at lines 156-163, along with the `cancelable` / `onLimitPrompt` computation that gated it. The `Ban`-iconed **"You stopped this run"** banner stays exactly as it is — it explains a completed action rather than offering one, and its neutral-ink treatment is the E1 rule that stopping is a decision, not an error.

`ThreadView` swaps per-run `onCancel(runId)` + `cancelingRunId` for composer-level `onStop` + `stopping`.

`ThreadContainer` computes the target:

```ts
const stoppableRunId =
  [...runViews].reverse().find(
    (run) => !run.canceled && (isActiveStatus(run.status) || run.status === "waiting"),
  )?.runId ?? null;
```

Same predicate as `slotHeld`, read for its run id — only one run can hold the slot, so "the slot holder" is unambiguous.

**The session-limit exception is dropped deliberately.** `RunMessage.tsx:56-58` suppressed its Stop when a `session-limit` prompt was on screen, because that card offers its own "Stop" through the same path and two adjacent identical Stops is worse than one. In the composer that adjacency no longer exists, so the suppression has no reason to survive — and keeping it would make Stop mysteriously vanish mid-run.

**Why this is a net accessibility gain:** the transcript is virtualized (`ThreadView.tsx:66-76`), so Stop could be scrolled out of the DOM entirely while a run streamed. The composer is fixed at the bottom, so Stop is always rendered and always reachable — one Tab from the editor rather than an arbitrary distance into a virtualized list.

### Verify before trusting the queue's only automatic exit

Per AGENTS.md, cancelling a run whose eve session is already dead returns 200 `no_active_turn` — the same dead-session condition, not "nothing was running". If the control plane does **not** settle the run row to `canceled` in that case, `slotHeld` stays true forever: the flush never fires, give-up never triggers (it counts *flush* rejections, and no flush is attempted), and the queued text is stuck behind a phantom run with only the discard dialog as an escape. **Verified during implementation: it does settle to `canceled`, on both cancel paths, whatever eve answers** — `apps/control-plane/src/runtime/routes.ts`'s `POST /runs/:runId/cancel` marks a run with no live tail `canceled` FIRST and only then fires `cancelEveTurnBestEffort`, while a live tail's `handle.cancel(reason, { status: "canceled" })` sets `canceledByUser` and aborts, and `apps/control-plane/src/runs/tailer.ts`'s abort path finishes the run `canceled` (`finishRun(canceledByUser ? "canceled" : "failed", …)`); the remote cancel there is fired-and-forgotten through `requestRemoteCancel`, whose `.catch` only logs `run.remote_cancel_failed`. So no eve response — `no_active_turn` included — can leave the row unsettled, and the strip needs no manual "send now" escape.

---

## 5. Leaving with a queue

A non-empty queue holds text the user typed and has not seen sent. Dropping it silently is the failure mode this guards.

Entry points, all resolving to one shared `DiscardQueueDialog` (a `ConfirmDialog` wrapper, `destructive`, copy naming the count):

| path | mechanism |
|---|---|
| In-pane session switch, "New chat" | `ThreadContainer` reports depth via `onQueuedCountChange`; `ChatShell` intercepts `SessionList`'s `onSelect` and `onNewChat` |
| Route navigation (sidebar → Agents/Workflows/Settings) | `useBlocker` in `ThreadContainer` drives the same dialog |
| **Session reset** | The existing reset `ConfirmDialog` gains a line naming the queued count; confirming discards the queue |

The reset path matters because it bypasses both guards: `performReset` → `onSessionReplaced` → `ChatShell` swaps `activeSessionId` → the keyed `ThreadContainer` (`ChatShell.tsx:165-172`) remounts and the queue evaporates. Reset is menu-blocked while `slotHeld`, but a queue can be non-empty with the slot free (every busy-retry backoff), so it is reachable.

### The `useBlocker` call must be spelled out

```ts
useBlocker({
  shouldBlockFn: () => queuedCountRef.current > 0,   // ref, not a render closure
  enableBeforeUnload: false,
  withResolver: true,
});
```

`enableBeforeUnload` **defaults to `true`** (`useBlocker.tsx:159` in TanStack Router's source), so omitting it installs exactly the reload/tab-close prompt this spec rejects below. `shouldBlockFn` is required — the bare `{ withResolver: true }` form is not a complete call.

`shouldBlockFn` reads a ref so a flush that empties the queue mid-navigation is seen. **Both dialogs auto-resolve and close when the count reaches zero** — otherwise a flush landing while the dialog is open leaves it offering to discard messages that are already sent.

`useBlocker` is safe in this component: `ThreadContainer` renders inside the route tree, and `chat-container.test.tsx:187` already mounts it through `renderWithRouter` (`test/router.tsx`), which builds a real router over memory history.

**Not covered, deliberately:**
- **Browser tab close / reload** — a `beforeunload` handler would fire on every reload of a thread with a queue, disproportionate to a client-side draft. Hence `enableBeforeUnload: false`.
- **Workspace switch** — neither a route navigation nor a `SessionList` selection; the queue dies silently.
- **Fixture mode** (`VITE_FIXTURE_MODE=1`) session switches — no dialog; it is a backend-free preview.

---

## 6. Testing

| Suite | Coverage |
|---|---|
| `__tests__/message-queue.test.ts` (**new**) | The hook against a stub `send`, `retryDelayMs` injected: merge separator, condition-trigger (including enqueue while already free), snapshot-removal preserving an item enqueued mid-flight, `session_busy` retry → give-up at 5, retry cancelled when `canFlush` drops, terminal-error path, `notice` transitions |
| `__tests__/chat-composer.test.tsx` (extended) | Stop absent without `onStop`; ink Stop when `queueing` with an empty box; **both** controls when `queueing` with text; Enter queues rather than sends; Escape stops only while stoppable; submit stays enabled while `sending && queueing`; **placeholder identical across a `queueing` flip with a draft in the box** (the P1 regression guard); the existing `flush()` cases on the queue path |
| `__tests__/chat-container.test.tsx` (extended) | The container wiring: composer Stop cancels the slot-holder; queue strip appears and clears; busy-retry then give-up; give-up appends without clobbering; direct-send busy auto-enqueues; stop→flush; **fail→flush**; retired mid-queue. This suite — not `chat-thread.test.tsx` — has the real query hooks, mocked fetch and mocked `useThreadStreams` these need |
| `__tests__/chat-thread.test.tsx` (extended) | Presentational only: no Stop in the transcript (the three existing Stop tests at `:289-345` move to the composer) |
| `__tests__/chat-shell.test.tsx` (**new**) | The discard dialog on session switch / New chat. `ChatShell` has no suite today (`fixture-chat.test.tsx:43` mounts `FixtureChatShell`), so this assembles `renderWithRouter` + `QueryClientProvider` + fetch mocks for `useSessions`/`useAgents` — existing parts, new file |
| `components/chat/FixtureChatShell.tsx` | Rewired to composer-level cancel; `fixture-chat.test.tsx:128` relocates its Stop lookup |
| `e2e/specs/chat-approval.e2e.ts` | **Reworked.** It currently uses `toBeEnabled()` on the Message box as its run-completion signal (`:81-83`, `:106-109`); a composer that never disables makes those pass instantly, and the following `Send message` click (`:94`) then fires while the slot may still be held, where the button is named **Queue message**. Assert on run-terminal UI (reply visible / stopped notice) instead, and move the Stop lookup to the composer |

Lanes: `bun run typecheck`, root `bun test`, **and** `cd e2e && bunx playwright test`. The e2e lane is not optional for this change. No DB or keyed lanes are implicated.

---

## 7. Documentation

Per the repo's docs-move-with-code rule:

- This spec, listed in `AGENTS.md`'s living-documents table, noting the supersession in §1.
- `.changeset/` entry naming **`@invisible-string/web`**, bump `minor`, one-line summary.

No `README.md` change — it does not describe composer mechanics. No `docs/runtime-worker-contract.md` change — the control-plane protocol is untouched.
