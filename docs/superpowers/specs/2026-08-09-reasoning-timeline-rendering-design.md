# Reasoning timeline rendering — design

**Date:** 2026-08-09
**Status:** Approved, ready for implementation
**Supersedes:** the 2026-07-02 design spec's decision C (the collapsible working block), in `apps/web` only. Nothing about the event stream, the control plane, or the compiler changes — this is a presentation-layer redesign of `RunView` and the components that render it.

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

`RunView.block: WorkingBlockView | null` is replaced by `RunView.segments: readonly RunSegment[]` — the run's top-level chronology.

```ts
/** One assistant utterance: mid-run narration or the final answer. Identical
 *  rendering — it is all the agent talking, and which one it turned out to be
 *  is not a distinction the reader needs drawn for them. */
export interface SpeechSegment {
  kind: "speech";
  key: string;              // `say:${turnId}:${stepIndex}`
  text: string;
  streaming: boolean;
}

/** A contiguous stretch of interior work: thinking and tool calls. Renders as
 *  one collapsible glass box containing one rail. */
export interface WorkSegment {
  kind: "work";
  key: string;              // `work:${first item's key}`
  items: readonly TimelineItem[];
  /** Wall-clock span of THIS segment's own frames — not the run's. */
  elapsedSeconds: number | null;
  /** The run is unsettled AND this is the last segment. */
  active: boolean;
  /** A later segment exists, so this one has been superseded — the fold cue. */
  sealed: boolean;
}

export type RunSegment = SpeechSegment | WorkSegment;

export type TimelineItem = ThoughtItem | ToolItem;

export interface ThoughtItem {
  kind: "thought";
  key: string;              // `${turnId}:${stepIndex}`
  text: string;
  /** Wall-clock seconds for this pass; null while streaming or unmeasurable. */
  seconds: number | null;
  streaming: boolean;
}

export interface ToolItem {
  kind: "tool";
  key: string;              // callId
  toolName: string;
  state: StepState;         // unchanged union
  resultPreview: string | null;
}
```

`StepState`, `PendingInputView`, `FrameStore`, and every existing invariant around cancellation, `context.cleared`, and settled-status precedence are **unchanged**.

### 2.1 Thought segmentation is exact, not heuristic

Every eve event carries `(turnId, stepIndex, sequence)`. A thought's identity is `${turnId}:${stepIndex}`:

- `reasoning.appended` → upsert the thought at that key, `text = reasoningSoFar`, `streaming = true`.
- `reasoning.completed` → same key, `text = reasoning`, `streaming = false`, and `seconds` = the span between that key's first and last frame `at` timestamps, rounded, floored at 1.

Two passes in different steps are different keys, so they are different items. **Nothing overwrites anything.** This is not a "seal on next tool call" guess — the runtime tells us.

`stepIndex` is also why a *durable step retry* is safe: a retried step re-emits its own key and updates in place rather than appending a duplicate.

### 2.2 Segmentation of the run itself

Walk frames in `seq` order and append to the current segment:

- A **thought** or **tool** item opens (or extends) a `work` segment.
- Assistant text opens a `speech` segment, which **closes the current work segment**.
- Any subsequent work opens a **new** work segment below.

`message.appended` streams into a speech segment immediately; `message.completed` settles the same key's text and clears `streaming`. **The text never moves** — `finishReason` decides only whether more segments follow, which is a fact about *what comes after*, never a correction to what already rendered. Symptom 3 is designed out rather than mitigated.

The reply is simply the last speech segment. `RunView.reply` is removed; `RunMessage` no longer renders it separately.

> **Consequence, accepted:** a run where the agent speaks mid-work renders as several boxes interleaved with prose. This is honest — it is what happened — and reads as a transcript. A run with no mid-work narration (the common case) renders as exactly one box followed by one reply, unchanged from the approved mockup.

### 2.3 Edge cases the reduction must pin down

- **Segment keys are kind-prefixed** (`work:` / `say:`) because one step can emit *both* reasoning and text, which would otherwise give a thought and a speech segment the same `${turnId}:${stepIndex}` and collide as React keys in the same list.
- **Empty `message.completed`.** `message` is `string | null`, and eve emits a null/blank one for a pure tool-call step. A speech segment is created only once non-blank text exists; a blank completion opens nothing and therefore does not close the current work segment.
- **A run with no segments at all** (`segments: []`) keeps the existing `Thinking…` presence cue in `RunMessage.tsx:151`, which now keys off `segments.length === 0` instead of `block === null && !showReply`.
- **`elapsedSeconds` is per-segment** — the span between that segment's own first and last frame `at` values, floored at 1s, `null` when the segment holds fewer than two frames. It is no longer the whole run's span.
- **Frames with no `stepIndex`** (0.19-era rows still replayed from `run_events` forever, per the existing `inputRequestKindOf` precedent) fall back to a synthetic key derived from `frame.seq`, which yields one item per frame rather than mis-merging distinct passes.

---

## 3. The rail

One work segment = one collapsible glass box (existing E1 treatment: `rounded-card`, `border-black/[0.06]`, `bg-white/35`) whose body is a vertical rail: a 1px `rgba(0,0,0,.10)` spine at `left: 6px` with a 13px node per item, wash-colored so the spine passes behind it.

| Item | Node | Body |
|---|---|---|
| Thought (streaming) | filled `--ink-4` dot | header `Thinking`, body `text-ink-3` at 12.5px |
| Thought (sealed) | filled `--ink-4` dot | header `Thought for Ns` |
| Tool `pending` | spinner, `--ink-4` | mono `toolName` |
| Tool `ok` | check, `--ok` | mono name + one-line `resultPreview` in `--ink-3` |
| Tool `awaiting` | pause bars, `--warn` | preview in `--warn-ink` (the bright `--warn` fails contrast as small text) |
| Tool `error` | ✕, `--err` | preview in `--err` |
| Tool `rejected` / `canceled` | ✕ / −, `--ink-4` | neutral ink — a user decision is never an error |

Color stays meaning-only per E1 §5.

### 3.1 Header and fold

Header: chevron (rotates 90° when open), a spinner while `active`, a label, and a right-aligned tabular-nums elapsed counter while `active`.

- **Active:** `Working` + live `M:SS`.
- **Settled:** `Worked for Ns · M steps`, counter hidden.

**`M steps` is `items.length` — thoughts included.** The summary is literally the length of the rail, so it cannot drift from its contents, and the two vocabularies (`steps` meaning tool calls, reasoning meaning something else) collapse into one.

**The fold trigger changes.** Today `WorkingBlock.tsx:67-71` folds on `block.active` going false — i.e. run-settled, which is *after* the reply has finished streaming. Instead a work segment auto-folds when it becomes **`sealed`** (a later segment exists), which for the last box is the first token of the final message. The rail closes as the answer opens: one handoff, not two beats.

Fold uses the existing `grid-template-rows: 0fr ↔ 1fr` transition at 220ms `--ease-out`. The manual toggle wins permanently: once the user has clicked a box, auto-fold never overrides them again.

### 3.2 Height

- **While `active`:** body capped at `max-height: 210px`, `overflow-y: auto`, scrolled to bottom on each new item. A long reasoning pass streams *within* the box instead of shoving the composer down the page.
- **Once settled:** the cap is removed. Reopening a finished box expands full-height in page flow — no nested scrollbar, and no second click per thought. The cap exists to serve streaming, not reading.

### 3.3 What stays outside the boxes

`pendingInputs` (approval cards), the failure banner, the stopped notice, the `ContextDivider`, and the Stop button keep their current position **below** the segments. Approval cards are actionable and always concern the run's present state; burying one inside a scrolling rail would hide the thing the run is blocked on. The gating tool row shows `awaiting` and points at the card.

---

## 4. Files

| File | Change |
|---|---|
| `apps/web/src/lib/chat/run-view.ts` | Replace `WorkingBlockView`/`reply` with `RunSegment[]`; segment-aware reduction; keyed thoughts; drop the optimistic `streamText → reply` promotion at :412 |
| `apps/web/src/components/chat/WorkingBlock.tsx` | Rewrite as the rail-in-box for **one** `WorkSegment`; new `ThoughtRow`; `StepRow` → `ToolRow`; capped/uncapped body; `sealed`-driven auto-fold |
| `apps/web/src/components/chat/RunMessage.tsx` | Map `run.segments` in order; speech segments render through `Markdown`; remove the separate reply branch |
| `apps/web/src/lib/chat/fixtures.ts` | Extend the scripted frames to cover multi-pass reasoning and a mid-run narration so `VITE_FIXTURE_MODE=1` exercises segmentation |
| `apps/web/src/__tests__/run-view.test.ts` | New cases (§5) |
| `apps/web/src/__tests__/chat-thread.test.tsx` | Update for the new DOM |
| `.changeset/*.md` | `"@invisible-string/web": minor` |
| `AGENTS.md` | Add this spec to the living-documents table |

No control-plane, worker, compiler, shared-package, or database change. No new dependency.

---

## 5. Testing

Reducer tests (`run-view.test.ts`) are the primary guard, because the bugs are reducer bugs:

1. **Two reasoning passes in different `stepIndex` produce two thought items** with both texts intact — the direct regression test for symptom 1.
2. **A retried step's re-emitted reasoning updates in place**, not appended twice.
3. **Interleaving is preserved**: `reason → tool → reason → tool` yields items in exactly that order.
4. **Mid-run narration segments the run**: text with `finishReason: "tool-calls"` followed by more tools yields `work, speech, work` — the regression test for symptom 2.
5. **Streaming text never relocates**: a speech segment's key is stable from first `message.appended` through `message.completed`, whichever `finishReason` lands — symptom 3.
6. **`M steps` equals `items.length`** across a mixed segment.
7. **Cancellation freezes the rail**: pending/awaiting tools go `canceled`, thoughts keep their text, no failure state.
8. **`turn.cancelled` mid-thought** leaves that thought rendered and non-streaming.
9. **A step emitting both reasoning and text** yields two segments with *distinct* keys (`work:t0:0` and `say:t0:0`) — the key-collision guard.
10. **A blank/null `message.completed`** creates no speech segment and does not split the surrounding work segment.

Component tests: auto-fold on `sealed`; manual toggle survives subsequent frames; `prefers-reduced-motion` zeroes the fold transition.

Lane: `bun test` (ungated) + `bun run typecheck`. No DB or eve build needed.

---

## 6. Accessibility

The rail is a `<ul>` of `<li>`; each tool row keeps its `sr-only` state label (`STEP_STATE_LABEL`), and thought rows expose `Thought for Ns` as real text rather than a title attribute. The existing `aria-live="polite"` / `aria-busy` wrapper in `RunMessage` is unchanged. The fold button keeps `aria-expanded`; the collapsed body keeps `aria-hidden`. Every animation added here (`fold`, item entry, caret, spinner) is inside the global `prefers-reduced-motion` guard.

---

## 7. Rejected alternatives

- **Always-open timeline (no box).** Maximum transparency, but every reply sits below a wall of process and threads grow unboundedly tall. Rejected on scrollback cost.
- **Keep the box, only reorder its contents.** Fixes symptoms 1 and 2 with no layout risk, but leaves thinking a `line-clamp-2` stub and does nothing for symptom 3.
- **Narration inside the rail.** Approved in mockup, then rejected on a hard constraint: it forces either the final reply to stop streaming in place, or the symptom-3 jump to remain. Segmenting the box delivers the same intent — speech distinguished from thought, at its true chronological position — with no jump.
- **Collapse sealed thoughts to their header on reopen.** Tighter for long runs, but makes you click twice for the thing you opened the box to read.
