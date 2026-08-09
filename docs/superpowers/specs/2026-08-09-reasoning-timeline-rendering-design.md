# Reasoning timeline rendering — design

**Date:** 2026-08-09
**Status:** Approved, ready for implementation
**Supersedes:** the 2026-07-02 design spec's decision C and `docs/PLAN.md`'s "Run rendering in chat" row (the collapsible working block), in `apps/web` only. Nothing about the event stream, the control plane, or the compiler changes — this is a presentation-layer redesign of `RunView` and the components that render it.

---

## 1. The problem

Three symptoms, reported from live use:

1. **Thinking overwrites itself.** A run that thinks, calls a tool, then thinks again keeps only the *last* pass. Every earlier thought is gone.
2. **Output appears in the wrong place.** Text the agent emitted *before* a tool call renders *below* every tool row.
3. **Text jumps after it has already rendered.** Prose starts streaming as the answer, then relocates into the working block a beat later.

All three are the same defect: **`WorkingBlockView` models a run as three parallel buckets, not a sequence.**

`reduceRunView` accumulates into three fields (`run-view.ts`):

| Field | Type | Failure |
|---|---|---|
| `reasoning` | `string \| null` | Last-write-wins (`run-view.ts:357-361`). Symptom 1. |
| `steps` | `Map<callId, StepRowView>` | Insertion-ordered, but ordered only *among themselves*. |
| `narration` | `string[]` | Rendered after every step (`WorkingBlock.tsx:129`). Symptom 2. |

`WorkingBlock` then renders them in a **fixed** order — reasoning top, steps middle, narration bottom — which has no relationship to when anything happened. Chronology is destroyed at reduce time and cannot be recovered at render time.

Symptom 3 has a second, independent cause. `message.appended` carries only `messageSoFar`; the `finishReason` that distinguishes the final answer (`stop`) from mid-run narration (`tool-calls`) arrives later, on `message.completed`. `run-view.ts:412` guesses optimistically and promotes in-flight `streamText` to `reply` — so when the guess is wrong, `message.completed` yanks the text into `narration[]` and it visibly relocates.

**No amount of render-layer work fixes any of this.** The reducer must emit a sequence.

---

## 2. The model

`RunView.block: WorkingBlockView | null` and `RunView.reply` are replaced by `RunView.segments: readonly RunSegment[]` — the run's top-level chronology.

```ts
/** One assistant utterance: mid-run narration or the final answer. Identical
 *  rendering — it is all the agent talking, and which one it turned out to be
 *  is not a distinction the reader needs drawn for them. */
export interface SpeechSegment {
  kind: "speech";
  key: string;              // `say:${turnId}:${stepIndex}` (+ `#n`, see §2.3)
  text: string;
  streaming: boolean;       // see §2.4
}

/** A contiguous stretch of interior work: thinking and tool calls. Renders as
 *  one collapsible glass box containing one rail. */
export interface WorkSegment {
  kind: "work";
  key: string;              // `work:${first item's key}`
  items: readonly TimelineItem[];
  /** Wall-clock span of THIS segment's own frames — not the run's. */
  elapsedSeconds: number | null;
  /** First frame's `at`. The component ticks the live counter from this;
   *  the reducer cannot, because it only re-runs when frames arrive. */
  startedAt: string | null;
  /** Accepting items right now — see §2.4. Drives the spinner + counter. */
  active: boolean;
  /** Blocked on the user (a pending input gates an item here). */
  waiting: boolean;
  /** A later segment exists, so this one has been superseded — the fold cue. */
  sealed: boolean;
}

export type RunSegment = SpeechSegment | WorkSegment;

export type TimelineItem = ThoughtItem | ToolItem;

export interface ThoughtItem {
  kind: "thought";
  key: string;              // `${turnId}:${stepIndex}` (+ `#n`, see §2.1)
  text: string;
  /** Wall-clock seconds for this pass; null while streaming or unmeasurable. */
  seconds: number | null;
  streaming: boolean;       // see §2.4
}

export interface ToolItem {
  kind: "tool";
  key: string;              // callId
  toolName: string;
  state: StepState;         // unchanged union
  resultPreview: string | null;
}
```

`StepState`, `PendingInputView`, `FrameStore`, and the settled-status-precedence rule (`statusOverride` applies only while the row is unsettled) are **unchanged**.

### 2.1 Thought segmentation

Events used to build timeline keys — `reasoning.*`, `message.appended`/`completed`, `actions.requested`, `action.*`, `input.requested` — all carry `(turnId, stepIndex, sequence)`. (Turn- and session-level events like `turn.*`, `context.cleared` and `compaction.*` do not, but they are never timeline items.) `stepIndex` is per-turn, so every key embeds `turnId` and multi-turn runs cannot collide.

**`(turnId, stepIndex)` is NOT unique for either reasoning or messages.** This was read out of eve's emitter — `eve@0.31.3`, `dist/src/harness/emission.js`, `consumeStreamContent` — and recorded as `spike/REPORT.md` findings 30–33. The emitter holds one reasoning accumulator `u`; a `text-delta` seals the current block (`emit reasoning.completed`) and **resets `u` to empty**. So a model that interleaves thinking (reason → speak → reason inside one model call) emits **two `reasoning.completed` events at the same `turnId` *and* `stepIndex`**, the second `reasoningSoFar` restarting from empty. `sequence` does not disambiguate — it is the turn's sequence, constant within the turn.

A plain upsert would let the second block overwrite the first, **reproducing symptom 1 one level down**, and in the shorter direction. So the ordinal is required:

- `reasoning.appended` → upsert `${turnId}:${stepIndex}`, `text = reasoningSoFar`.
- `reasoning.completed` → same key, `text = reasoning`, **seal it**; `seconds` = the span between that key's first and last frame `at`, rounded, floored at 1.
- `reasoning.appended` for an **already-sealed** key opens a new item at `${turnId}:${stepIndex}#2` (then `#3`, …).

The ordinal also resolves a segment-key collision the walk would otherwise hit: text closes the work segment, so the second reasoning block opens a *new* work segment — which without the suffix would be keyed `work:t0:0` exactly like the first.

Two consequences of finding 33 worth building to:

- **A tool call does not split a reasoning block; only text does.** `reason → tool → reason` at one step is ONE block.
- Its `reasoning.completed` is emitted at **end of stream**, i.e. *after* that step's `actions.requested` and `action.result`. A thought therefore stays unsealed (`Thinking`, no duration) until the step ends — correct, but later than a "seal on the next tool call" heuristic would guess. Do not add such a heuristic.

> **Residual:** these shapes are read from the shipped emitter, not captured off a live model — no reasoning-capable keyed run has been recorded, and there is no `.openrouter-key` in the tree. The emitter is authoritative for what eve *sends*; what remains unobserved is only which of these branches a given provider actually exercises. The design is correct under all of them.

### 2.2 The walk

One pass over `store.frames` in `seq` order, maintaining two **global** lookup maps (`itemsByKey`, `speechByKey`) and a pointer to the current work segment:

- **Known key ⇒ update in place, wherever it already lives** — even if that item sits in a segment closed several segments ago.
- **Unknown key ⇒** a thought/tool item opens or extends the current work segment; assistant text opens a speech segment, which **closes** the current work segment. Subsequent work opens a **new** work segment below.

The global-lookup rule is load-bearing, not an optimization. Updates legitimately arrive for items in closed segments: `action.result`/`action.partial` for a call issued before the agent spoke, and durable **step retries**, which `eve-events.ts:63-64` documents as re-emitting under new `meta.id`s with the *same* `turnId`/`stepIndex`. A current-segment-only lookup would duplicate the item into a new box *and* mint a second segment keyed `work:t0:0`, colliding as a React key.

**Carry forward the don't-walk-a-settled-step-backwards guard** (`run-view.ts:319-334`): `action.partial` must not demote a tool item that already reached `ok`/`error`/`rejected`. It lives in the exact code being rewritten and has no test today; §5.11 adds one.

**Fallback for frames without `stepIndex`** (0.19-era rows are replayed from `run_events` forever). Point events get a synthetic key from `frame.seq`. Append-type events (`reasoning.appended`, `message.appended`) instead **stick to the currently-open item/segment of that kind** — a per-frame key would render one item per delta, so a 500-delta stream would produce 500 thought items each holding progressively longer cumulative text.

### 2.3 Speech

**Assistant messages need the same ordinal, for the same reason** (finding 31). `flushCurrentMessage` emits `message.completed({finishReason: "tool-calls"})` and then resets its accumulator `d`, and it fires on *every* tool request while `d` is non-empty — so a step that speaks, calls a tool, speaks again and calls another tool emits **two `message.completed` at one `(turnId, stepIndex)`**, each `messageSoFar` restarting from empty. Speech keys are `say:${turnId}:${stepIndex}`, then `#2`, `#3`, … once the prior key has completed.

`message.appended` streams into a speech segment immediately; `message.completed` settles the same key. A `message.completed` with **no prior `message.appended`** still creates the segment (the `clearedRun` fixture at `fixtures.ts:272` is exactly this). A **blank or null** `message` creates nothing and therefore does not close the current work segment.

**Narration always precedes its tool call in `seq` order** (finding 32): `emitActionRequest` flushes the pending message *before* emitting `actions.requested`. The walk needs no lookahead, and a fixture asserting the opposite order would be wrong.

**The text never moves.** `finishReason` decides only whether more segments follow — a fact about what comes *after*, never a correction to what already rendered. Symptom 3 is designed out rather than mitigated.

The reply is simply the last speech segment; `RunMessage` no longer renders one separately.

> **Consequence, accepted:** a run where the agent speaks mid-work renders as several boxes interleaved with prose. This is honest — it is what happened — and reads as a transcript. A run with no mid-work narration (the common case) renders as exactly one box followed by one reply, unchanged from the approved mockup.

### 2.4 `active`, `waiting`, and `streaming` — the invariants that must not regress

These are derived from **both** status and the frame-derived `canceled` flag, never status alone. `canceled` flips a beat *before* the `run_status` frame (`RunMessage.tsx:48-51`), which is what lets the spinner, caret and Stop button settle together instead of lingering for a round trip.

```
runLive   = !canceled && (status === "queued" || status === "running")
active    = runLive && isLastSegment          // WorkSegment
waiting   = !canceled && status === "waiting" && segment gates a pendingInput
streaming = no completion seen for this key && runLive   // Speech + Thought
```

Two traps this closes:

- **`waiting` is NOT settled.** `isRunSettledStatus` (`api.ts:602-604`) is `succeeded|failed|canceled` only. Defining `active` as "the run is unsettled" would give a run parked on a human approval a spinner and a live-ticking counter for as long as the person takes to answer.
- **Cancellation and crashes produce no completion event.** `run-view.test.ts:205` ("a cancelled turn freezes its partial reply instead of blinking on forever") asserts `reply.streaming === false` after `turn.cancelled` with no `message.completed`. Clearing `streaming` only on completion regresses it — and a crashed run replayed from history would render an eternal caret on a `failed` run.

### 2.5 Segment-key stability

`addFrame` sort-inserts frames arriving below `maxSeq` (`run-view.ts:54-56`). A late gap-fill that inserts a new *first* item into a segment changes that segment's key on the from-scratch re-reduce, remounting the box and losing its manual toggle. This is rare (SSE resume is normally in-order) and low-consequence; **accepted and documented**, not worked around.

---

## 3. The rail

One work segment = one collapsible glass box (existing E1 treatment: `rounded-card`, `border-black/[0.06]`, `bg-white/35`) whose body is a vertical rail: a 1px `rgba(0,0,0,.10)` spine at `left: 6px` with a 13px node per item, wash-colored so the spine passes behind it.

| Item | Node | Body |
|---|---|---|
| Thought (streaming) | filled `--ink-4` dot | header `Thinking`, body `text-ink-3` at 12.5px |
| Thought (sealed) | filled `--ink-4` dot | header `Thought for Ns`, or plain `Thought` when `seconds` is null |
| Tool `pending` | spinner, `--ink-4` | mono `toolName` |
| Tool `ok` | check, `--ok` | mono name + one-line `resultPreview` in `--ink-3` |
| Tool `awaiting` | pause bars, `--warn` | preview in `--warn-ink` (the bright `--warn` fails contrast as small text) |
| Tool `error` | ✕, `--err` | preview in `--err` |
| Tool `rejected` / `canceled` | ✕ / −, `--ink-4` | neutral ink — a user decision is never an error |

Color stays meaning-only per E1 §5.

### 3.1 Header, counter, fold

Header: chevron (rotates 90° when open), a spinner while `active`, a label, and a right-aligned tabular-nums counter while `active`.

| State | Label | Counter |
|---|---|---|
| `active` | `Working` | live `M:SS`, ticked component-side from `startedAt` |
| `waiting` | `Waiting on you` | none |
| settled | `Worked for Ns · M steps` | none |

**`M steps` is `items.length` — thoughts included.** The summary is literally the length of the rail, so it cannot drift from its contents, and the two vocabularies (`steps` meaning tool calls, reasoning meaning something else) collapse into one.

The counter ticks in the component because the reducer is pure and only re-runs on frames — a model thinking silently emits none. Derive it as `startedAt` + local elapsed; client-clock skew against the server's `at` is accepted (the value is a progress cue, not a measurement).

**Fold rules** (today's is `active → false`, at `WorkingBlock.tsx:67-71`):

- Default open iff `active` on mount — so a history-replayed run opens collapsed.
- Auto-fold when `sealed` **or** on `active → false` (a failed or cancelled run has no following segment to seal it, and must still fold).
- A manual toggle wins over auto-fold for the life of the mounted component. Note `ThreadView` virtualizes rows (overscan 4), so scrolling a box far off-screen unmounts it and resets the toggle — same as today, and accepted.

Fold uses the existing `grid-template-rows: 0fr ↔ 1fr` transition at **200ms** `--ease-out`, matching the current `duration-200` and the E1 150–200ms band.

### 3.2 Height and inner scroll

- **While `active`:** body capped at `max-height: 210px`, `overflow-y: auto`. A long reasoning pass streams *within* the box instead of shoving the composer down the page.
- Auto-scroll to bottom on new content **only while the user is pinned near the bottom of that body** — reuse the stick-to-bottom heuristic at `ThreadView.tsx:80-85`. Unconditional scrolling would yank a reader who scrolled up inside a live box to re-read an earlier thought.
- **Once settled:** the cap is removed. Reopening a finished box expands full-height in page flow — no nested scrollbar, and no second click per thought. The cap exists to serve streaming, not reading.

A pathological run (say 50 reasoning passes) reopens to a very large DOM subtree inside a dynamically-measured virtual row. Accepted: it requires a deliberate click, and re-reduce cost is unchanged from today.

### 3.3 What stays outside the boxes

`pendingInputs` (approval cards), the failure banner, the stopped notice, the `ContextDivider`, and the Stop button keep their current position **below** the segments. Approval cards are actionable and always concern the run's present state; burying one inside a scrolling rail would hide the thing the run is blocked on. The gating tool row shows `awaiting` and its segment shows `Waiting on you`, pointing at the card.

---

## 4. Files

| File | Change |
|---|---|
| `apps/web/src/lib/chat/run-view.ts` | Replace `WorkingBlockView`/`reply` with `RunSegment[]`; the §2.2 global-upsert walk; §2.4 derivations; drop the optimistic `streamText → reply` promotion at :412. Rewrite the header comment to describe segments, **keeping** the cancellation and settled-precedence prose |
| `apps/web/src/components/chat/WorkingBlock.tsx` | Rewrite as the rail-in-box for **one** `WorkSegment`; new `ThoughtRow`; `StepRow` → `ToolRow`; capped/uncapped body; component-side counter; `sealed`-driven fold |
| `apps/web/src/components/chat/RunMessage.tsx` | Map `run.segments` in order; speech segments render through `Markdown`; remove the reply branch; presence cue keys off `segments.length === 0` |
| `apps/web/src/components/chat/ThreadView.tsx` | **`streamSignature` (:88-93) reads `reply.text.length` + `block.steps.length`.** Not just a typecheck fix — it drives autoscroll, so the replacement must grow with segment count *and* trailing speech length or streaming stops following |
| `apps/web/src/lib/chat/fixtures.ts` | Extend scripted frames to cover multi-pass reasoning and mid-run narration. **Append new sessions, never splice** — `fixture-chat.test.tsx` addresses them by list index (`fixtures.ts:335`) |
| `apps/web/src/__tests__/run-view.test.ts` | New cases (§5); carry :205 forward |
| `apps/web/src/__tests__/chat-thread.test.tsx` | Update for the new DOM |
| `apps/web/src/__tests__/integrations-ui.test.tsx` | `:131-132`, `:159` build `RunView` literals with `block:`/`reply:` |
| `apps/web/src/__tests__/chat-composer.test.tsx` | `:143-144`, same |
| `.changeset/*.md` | `"@invisible-string/web": minor`, one-line summary |
| `AGENTS.md` | Add this spec to the living-documents table; amend the 2026-07-02 row (its decision C is now superseded in `apps/web`) |
| `docs/PLAN.md` | `:24` "Run rendering in chat" documents decision C's fold-on-completion and step semantics — both change |

Nothing outside `apps/web` reads `RunView`. No control-plane, worker, compiler, shared-package, or database change. No new dependency.

---

## 5. Testing

Reducer tests (`run-view.test.ts`) are the primary guard, because the bugs are reducer bugs:

1. **Two reasoning passes in different `stepIndex` produce two thought items** with both texts intact — the direct regression test for symptom 1.
2. **A re-`appended` sealed reasoning key opens `#2`** rather than overwriting — finding 30's interleaving case (`reason → text → reason` at ONE `stepIndex`), which must yield two thoughts, two work segments with distinct keys, and no lost text.
3. **Two `message.completed` at one `(turnId, stepIndex)`** yield two speech segments, not one overwritten — finding 31.
4. **`reason → tool → reason` at one step is ONE thought**, sealed by the single trailing `reasoning.completed` that arrives *after* the step's tool events — finding 33. Guards against re-adding a seal-on-next-tool heuristic.
5. **Interleaving is preserved**: `reason → tool → reason → tool` yields items in exactly that order.
6. **Mid-run narration segments the run**: text with `finishReason: "tool-calls"` followed by more tools yields `work, speech, work` — symptom 2. Frames must be ordered per finding 32: the `message.completed` precedes its `actions.requested`.
7. **Streaming text never relocates**: a speech segment's key is stable from first `message.appended` through `message.completed`, whichever `finishReason` lands — symptom 3.
8. **`M steps` equals `items.length`** across a mixed segment.
9. **A retry / late `action.result` for a call in a closed segment updates it in place** — no duplicate item, no second segment with the same key (§2.2).
10. **`action.partial` after `action.result` does not demote the item** — the carried-forward :319-334 guard.
11. **Cancellation freezes the rail**: pending/awaiting tools go `canceled`, thoughts keep their text, no failure state.
12. **Cancel mid-thought and cancel mid-speech** both leave the text rendered with `streaming === false` — the carried-forward :205 invariant, extended to thoughts.
13. **A `failed` run replayed with an unterminated append** renders `streaming === false` (no eternal caret in history).
14. **A run parked on `waiting`** has `active === false` and `waiting === true` on its last segment — no perpetual spinner.
15. **A step emitting one reasoning block and one message** yields two segments with distinct keys (`work:t0:0`, `say:t0:0`) — the cross-kind collision guard, distinct from case 2's same-kind one.
16. **A blank/null `message.completed`** creates no speech segment and does not split the surrounding work segment; a bare non-blank one (no prior append) does create one.

Component tests: auto-fold on `sealed` and on `active → false`; default-collapsed on history mount; manual toggle survives subsequent frames; `prefers-reduced-motion` zeroes the fold and item-entry transitions.

**Lanes:** `bun test` + `bun run typecheck` (no DB or eve build needed) — **and the e2e lane**. `e2e/specs/agent-workflow.e2e.ts:104-117` asserts `getByRole("button", {name: /Work(ing|ed)/})`, `aria-expanded="false"` after completion, and `/Worked for \d+s · \d+ step/`. All three survive the new strings, but the **fold timing changes** (sealed = first reply token, not run-settled). Verify, don't assume. The mock model emits no reasoning events, so the step count there is unchanged.

---

## 6. Accessibility

The rail is a `<ul>` of `<li>`; each tool row keeps its `sr-only` state label (`STEP_STATE_LABEL`), and thought rows expose `Thought for Ns` as real text.

**The streaming rail body must be excluded from the live region.** `RunMessage.tsx:96-100` wraps the run in `aria-live="polite" aria-relevant="additions text"`, which today announces a 2-line truncated stub. With full reasoning in the rail, a screen reader would read the entire chain of thought delta by delta and drown the actual answer. Announce state changes — "Working", "Thought for 4s", tool results, the reply — not thought token streams.

The fold button keeps `aria-expanded`; the collapsed body keeps `aria-hidden`. Every animation added here (fold, item entry, caret, spinner) sits inside the global `prefers-reduced-motion` guard; the counter must not animate its digits.

---

## 7. Implementation order

The reducer is the risk; everything downstream is mechanical.

1. Types + the §2.2 walk, TDD against the full §5 set.
2. `WorkingBlock` rewrite (one `WorkSegment`).
3. `RunMessage` segment mapping + presence cue.
4. `ThreadView.streamSignature`.
5. Fixtures, then the component/DOM tests.
6. Changeset, `AGENTS.md`, `docs/PLAN.md`.

Reducer shape: a single seq-ordered pass with `itemsByKey` + `speechByKey` (both global, each pointing at its owning segment) and a current-work-segment pointer. Known key ⇒ mutate in place; unknown ⇒ open or extend. That one rule delivers retry-safety, text-never-moves, and the closed-segment update case simultaneously.

Memoization needs no new work: `ThreadContainer`'s per-run cache (`:143-161`) keys on `(run, store, status)` references and is untouched, and `RunMessage`'s memo semantics are identical. Just never key segment components by array index.

---

## 8. Rejected alternatives

- **Always-open timeline (no box).** Maximum transparency, but every reply sits below a wall of process and threads grow unboundedly tall. Rejected on scrollback cost.
- **Keep the box, only reorder its contents.** Fixes symptoms 1 and 2 with no layout risk, but leaves thinking a `line-clamp-2` stub and does nothing for symptom 3.
- **Narration inside the rail.** Approved in mockup, then rejected on a hard constraint: it forces either the final reply to stop streaming in place, or the symptom-3 jump to remain. Segmenting the box delivers the same intent — speech distinguished from thought, at its true chronological position — with no jump.
- **Collapse sealed thoughts to their header on reopen.** Tighter for long runs, but makes you click twice for the thing you opened the box to read.
