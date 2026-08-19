# 2026-08-11 — Agent lifecycle, chat legibility, and copilot reach

Status: **implemented**. Decisions D1–D10 shipped as described, except where a
decision below carries an **Amended after review** note — those record what the
mechanism actually turned out to be once the code review found the places where
this document (and the code's own comments) described something the
implementation did not do. Read the amendments as part of the decision, not as
history: each one replaces the sentence above it.
Supersedes: the agent-identity half of the 2026-07-02 design's compile-hash
description (§ "Live-doc corrections"); the `.lift` hover motion in that
spec's §E1 interaction polish.

This spec collects fourteen pieces of product feedback into one change set.
They are grouped here not by where the feedback landed but by the seam each
one actually sits on, because several symptoms share a cause and two of them
turned out to be already half-built.

---

## 1. What this fixes, and what was actually wrong

| # | Reported | Actual cause |
|---|---|---|
| 1 | Publishing blocks the page | Server is *already* async (`publishAgent` kicks the build and returns `building`); the client never polls the build-status route that exists for it |
| 2 | "Unpublished" is not a real state | `isDirty` compares draft vs *last save*. Nothing compares the saved draft against `publishedDefinition`, which the agent DTO already returns |
| 3 | Streaming caret wraps to the next line | The caret is an inline-block `::after` with width, so it creates a line-break opportunity at the right edge |
| 4 | Tool calls show raw slugs and raw JSON | `WorkingBlock` prints `slug__tool_name` verbatim and `previewValue(result.output)` — the probe's cached tool **descriptions** are never consulted |
| 5 | Compaction doesn't persist | `context.cleared` is *derived* from persisted frames; compaction is transient React state instead |
| 6 | SHA + model id are noise | `ThreadHeader` surfaces build identity where the user wants budget |
| 7 | "Untitled agent" name conflict | The content hash keys on the slugified **display name**, so the unique index is load-bearing for world-DB isolation |
| 8–11 | Copilot too shallow | Copilot streams only `delta` + `proposal`; it has no step visibility, no auto-apply, and cannot touch `agents.name`/`agents.description` |
| 12 | Send doesn't enter the chat | `ChatShell.startSession` awaits session creation before switching panes |
| 13 | Hover rise looks unusual | One rule: `.lift:hover { transform: translateY(-1px) }` |
| 14 | Chat names are unhelpful | `agent_sessions` has **no title column**; the sidebar shows `session.agentName`, so every thread with one agent looks identical |

Two of these are far cheaper than they appear (5 and 1) and two are more
valuable than they appear (14 and 7). The rest are as billed.

---

## 2. Decisions

### D1 — The content hash keys on agent identity, not agent name

`computeAgentHash` currently hashes `resolved.agentSlug`, a slugified display
name. Two agents in one workspace with the same name and the same definition
therefore produce the **same** content hash, hence the same `ag_v_<hash12>`
world database — a direct violation of the documented single-writer-per-hash
constraint. The unique index `agents_organization_id_name_uidx` is what has
been preventing that, which makes a cosmetic UX rule silently load-bearing.

**The hash input takes the agent's stable `id` in place of `agentSlug`.**
Identity is what content addressing should key on; a display string is not
identity.

Consequences, all intended:

- The unique index is **dropped** (new migration; additive rule permits a new
  migration that drops an index — it does not edit an applied one). Duplicate
  agent names become legal.
- New agents are still auto-numbered (`Untitled agent 2`, `3`, …) so lists
  stay readable. This is now a **nicety, not a constraint** — a user may
  rename two agents to the same string and nothing breaks.
- `COMPILER_VERSION` bumps and the golden digest is regenerated, per the
  compiler ritual. **Every agent rebuilds once on its next publish** — the
  first publish after deploy runs a real `eve build` rather than hitting
  cache. This is an operational note for `docs/DEPLOY.md`, not a defect.

**Explicitly not fixed:** renaming an agent still re-keys its world DB and
JWT audience. The human name remains in emitted bytes in two places — the
generated `package.json` name (`codegen/project.ts`) and, load-bearingly, the
model-visible identity line `"Platform agent X in workspace Y"`
(`codegen/channels.ts`). Replacing that line with an opaque id would degrade
how the agent describes itself to its own model. Rename-preserves-world-DB is
a larger change and is out of scope here.

`publishAgentByName` (the seeded-workspace onboarding kick) keeps its
`.limit(1)` name lookup. It runs once against a freshly seeded workspace where
"General Purpose" is unique by construction; ambiguity is not reachable there.

### D2 — Publish is non-blocking in the client; the server is unchanged

The build stays in-process. The client stops waiting:

- `POST …/publish` returns immediately; the editor moves to a `building`
  phase and **polls** the existing
  `GET …/agents/:agentId/versions/:versionId/build` route.
- The poll is owned by a workspace-level store, not the editor component, so
  navigating away does not cancel it. Completion raises a toast naming the
  agent.
- `AgentEditorScreen`'s publish-then-chat path stops blocking on
  `buildStatus === "succeeded"`; it enters the chat and surfaces build failure
  there if it comes.

No durable queue, no new table, no boot reconcile. A control-plane restart
mid-build loses that build and re-publishing recovers it — accepted, and
consistent with the existing single-instance deployment constraint.

**Amended after review — "workspace-level" means the app shell, not the agent
surfaces.** The store outlives the editor, but the poller that drives it was
mounted by the agent screens, so navigating to `/chat` (or accepting an
invitation, which remounts the shell) unmounted the only watcher and the toast
never came. The watch is split in two: a *sink* that owns the polling and a
*pin* that binds it to the active workspace, both mounted once by `AppShell`;
no agent surface mounts either. The pin ignores a NULL (still-resolving)
workspace — treating "unresolved" as "switched away" cancelled watches nobody
left.

### D3 — Three save states, not two

The editor distinguishes:

| State | Condition |
|---|---|
| **Unsaved changes** | `draft ≠ lastSaved` (existing `isDirty`) |
| **Unpublished changes** | `lastSaved ≠ publishedDefinition` |
| **Published** | saved and matching the published version |

`publishedDefinition` is already on the agent DTO, so this is a client-side
comparison — the same structural equality `agentEditorStatesEqual` already
performs, applied against a second baseline. An agent that has never been
published reads as **Draft**, not as "unpublished changes".

**Amended after review — a RENAME is unpublished change too.** `agents.name`
is not part of the definition, so a rename moves neither baseline and the
editor read "Published" over an agent whose live artifact still introduces
itself by the old name. That is a direct consequence of D1 keeping `agentSlug`
in the hash: the display name still shapes emitted bytes, so renaming really
does leave the published version behind. `agentLifecycleState` therefore also
compares the current name's SLUG against the published version's — casing and
punctuation that slugify identically are not drift.

The baseline for that comparison is **not served yet**: `agent_versions` stores
no name, and nothing else on the DTO records what the published version was
compiled under. The web side is complete and reads the field defensively — an
unknown baseline never claims drift, so the chip stays silent rather than
lying — but closing the loop needs an additive migration adding
`agent_versions.name` (written at publish from the same `agent.name` the
compile service slugifies) plus a `publishedName` field on `AgentDto`. No
backfill: a null baseline reads as "unknown", never as drift.

### D4 — Compaction persists the way clearing already does

`contextCleared` is not a column; `run-view.ts` derives it by reducing over
persisted `run_events`. `compaction.requested` / `compaction.completed`
already exist in the event contract and already ride the same persisted
stream. Compaction gets a `contextCompacted` flag in the same reducer and the
same inline `ContextDivider` treatment in `RunMessage`. The transient
`contextMarker` state in `ThreadContainer` is retired.

**Edge case that must not be lied about:** compacting an empty or
already-cleared context emits *no* `compaction.*` events at all — only
`session.waiting`. The UI must therefore not assume a requested compaction
produced a marker.

**Amended after review — deriving the marker is not enough; someone has to
DRAIN it.** Both control routes require a QUIET session, so by construction no
tail is attached when one fires and nothing consumed eve's `context.cleared` /
`compaction.completed` at all. The result was two failures at once: no divider
was ever persisted (so none survived a reload — exactly what D4 promised), and
the frames sat in eve's stream until the NEXT run's tail drained them, drawing
the boundary under an exchange that happened *after* the clear.

The accepted path now drains those frames itself and appends them to the
session's most recent run, and the response carries
`marker: {kind, runId} | null` saying where they landed (contract:
`docs/runtime-worker-contract.md`, "the clear/compact drain"). The client
consumes the marker by re-attaching that run's tail — it resumes from the
store's cursor, so nothing replays — and falls back to refetching the session
when the named run is one this tab has never seen.

`marker: null` is the D4 edge case made explicit and must be *said*, not
papered over: a compact that produced no boundary reports "Nothing to compact —
there was no earlier context to summarize", never "earlier messages were
summarized".

### D5 — Tool calls read as English

A step currently renders `github__create_issue` in mono plus a raw JSON
preview. Instead:

- The `<slug>__<tool>` name is split. The slug resolves to a **connection
  display name** via the version row's `connection_slugs` map; the bare tool
  name is humanized.
- The connection's probe-cached `tools/list` supplies a **description** for
  the tool where one exists, shown as the step's subtitle.
- The result preview is a short **summary**, not serialized JSON. Raw output
  remains reachable on demand, never by default.

Server work is limited to exposing the cached tool metadata the probe already
stores; nothing new is fetched from MCP servers.

### D6 — Context budget replaces build identity in the thread header

The pinned short hash and the exact model id leave the header. In their place
a context-usage indicator: a small meter plus the actual percentage.

- Numerator: `usage.inputTokens` from `turn.completed` frames — persisted in
  `run_events`, therefore replayable, therefore correct after reload without
  a migration.
- Denominator: `contextWindowTokens` from the OpenRouter catalog, which
  already parses `context_length`.
- When either is unavailable the indicator is **absent**, never zero or
  guessed.

The model remains discoverable — as a friendly preset label, not a raw slug.

**Amended after review, twice.**

*The numerator stops at the newest memory boundary.* "The newest run that
measured input tokens" keeps the meter pinned at the pre-boundary percentage
after a clear or compact — it reports a context that no longer exists. Both
halves of the scan enforce it: `reduceRunView` nulls a run's `inputTokens` when
that run's own `context.cleared`/`compaction.completed` arrives, and the
session-wide scan (`contextTokensUsed`) stops at the newest boundary run,
including that run, since a run can measure a fresh step after its own boundary
frame. Nothing measured since the boundary ⇒ the meter is ABSENT, per D6's own
"never zero or guessed" rule.

*The preset label comes from the pinned version's definition, never from the
model id.* Matching the resolved model id against the preset list cannot work:
`balanced` and `quick` seed to the SAME model id and differ only by reasoning
effort, so an id lookup labels every Quick agent "Balanced", and re-pointing a
preset later would silently relabel old sessions. The label is read from the
published definition's own `model.preset`, gated on the session still being
pinned to the published version. A specific-model override (which beats the
preset at compile time) and a session left on an older publish have no preset
to name and fall through to the model's friendly short name — never the raw
slug. Serving an arbitrary version's definition would close that last gap; no
route does today.

### D7 — The copilot gets depth and reach

Four changes, one lane:

1. **Steps and thinking are visible**, in the same visual grammar as the main
   chat's rail-in-box. New server frames carry step and reasoning content
   alongside the existing `delta`.
2. **Allow-edits mode** — a session-scoped toggle. When on, mutations apply
   without the accept gate; the card still renders, marked applied, so the
   history remains an audit trail rather than disappearing.
3. **`setName`** — the copilot can propose the agent's name.
4. **`setDescription`** — a one-line description. `agents.description` exists
   in the schema and is currently unsurfaced; this lane gives it an editor
   field as well as a copilot tool.

**Amended after review — three things this decision left underspecified.**

*Identity rides the frame, beside the draft.* `agents.name`/`description` are
ROW columns and the `draft` a client sends is an `AgentDefinition`, which has
neither — so the copilot could not answer "what is this agent called?", and the
"you already proposed exactly this name" no-op checks could never fire. The
`user_message` frame carries an optional typed `identity {name, description}`
which WINS over the persisted row, because the editor holds edits the database
has not seen (the description is reducer state until the user saves). Omitted —
the workflow surface, an older client — the server falls back to the `agents`
row it already loads with the turn's inventory. Never smuggle these into
`draft`; the server does not read them there.

*Thought keys must be unique for the SOCKET, not the turn.* The dock upserts
timeline items by key globally, so the original `step:<stepIndex>` collided on
every turn after the first (each turn's step loop restarts at zero) and turn 2's
reasoning overwrote turn 1's inside its old work block — silently rewriting the
audit trail D7.2 exists to keep. The server mints
`turn:<turnIndex>:step:<stepIndex>` off a never-reset per-session counter; the
key stays opaque to the client.

*An "Applied" receipt must mean applied.* Accepting a proposal marked the card
applied and answered the server `accepted` before the mutation resolved, so a
failed PATCH left a card claiming a change that had not happened. Apply is now
result-aware: the card parks in an `applying` state, settles `failed` on
failure, and the server is told `rejected` with a reason. The allow-edits path
corrects its own receipt the same way (it has no waiter to answer).

### D8 — Sending enters the chat immediately

`startSession` renders the thread optimistically with the user's message
while session creation is in flight, rather than holding the composer. On
failure it rolls back to the composer **with the message text preserved** —
losing a typed message to a network error is the failure mode this must not
introduce.

### D9 — Sessions get generated titles

New `title` column on `agent_sessions`. After the first user message a titler
runs on the platform key against the **quick** preset — the same calling
pattern the copilot already establishes — and persists a short title. Until
it lands, the sidebar falls back to the existing truncation
(`titleFromMessage`, currently dead code, becomes the fallback rather than
being deleted). Failure is silent: an untitled session shows the fallback.

**Amended after review — three corrections.**

*The fallback needs a message the list DTO actually carries.* "Falls back to
truncating the first message" was unreachable on a cold load: the session LIST
DTO carried no message, so a tab that had never opened a thread fell all the
way through to the agent's name — the "every thread looks identical" symptom
D9 exists to remove. `agentSessionSummaryDtoSchema` gains
`firstMessagePreview`, the thread's opener truncated server-side to
`SESSION_MESSAGE_PREVIEW_MAX_CHARS` and read inside the list route's existing
per-page runs query (no N+1, no full bodies on the wire). The resolution order
is title → a whole message the caller happens to hold → the DTO preview → the
agent's name, iterated rather than `??`-chained so an EMPTY explicit message
falls through to the preview instead of shadowing it. No client may keep a
second source of truth for this — a per-tab map of "messages I have seen" is
what made the bug invisible in local testing.

*Quick is only cheaper than balanced because of its EFFORT.* Both presets seed
to the same model id, so a titler that sends the model but not the preset's
`reasoning` is not asking for the cheap thing at all. The effort travels as
ai@7's top-level `reasoning` call setting, `max` clamped to `xhigh` (the AI SDK
effort union has no `max`) and omitted entirely for `provider-default`.
Honesty about the ceiling: only the Anthropic provider honors it on the control
plane's current pins — `@openrouter/ai-sdk-provider@6.0.0-alpha.1` builds a
whitelisted Responses-API body and drops both `reasoning` and `extraBody`, so
for the seeded (OpenRouter) quick preset the effort cannot reach the wire until
that pin moves. The code asks correctly and says so; AGENTS.md's `extraBody`
rule is about the compiled agent's `3.0.0` pin, not this process.

> **SUPERSEDED — the pin moved.** `apps/control-plane` is now aligned to
> `packages/compiler/versions.json` (`@openrouter/ai-sdk-provider@3.0.0`,
> `ai@7.0.58`, `@ai-sdk/anthropic@4.0.36`), retiring an alpha that semver had
> been sorting *above* the stable line since 2026-01. **The ceiling described
> above was real but the remedy was only half of one:** bumping the pin alone
> changes nothing, because 3.0.0's `getArgs()` *also* never destructures ai@7's
> top-level `reasoning` call option. So the routing became per-provider, in
> `apps/control-plane/src/model/reasoning.ts` — OpenRouter takes the effort on
> the model's `extraBody` exactly as a compiled agent does (verbatim, no `max`
> clamp; the clamp belongs to Anthropic's narrower union), Anthropic keeps the
> top-level option. AGENTS.md's `extraBody` rule is therefore no longer
> compiled-agent-only. `model/reasoning-wire.test.ts` asserts both routes on
> real request bytes — OpenRouter through the titler and the copilot, Anthropic
> through the helper — including the negative that justifies the detour, and the
> control-plane pin block in `tests/integration/toolchain-pins.test.ts` keeps
> the matrix and the control plane from diverging again.

*The kill switch reads the stack's env record.* `SESSION_TITLE_*` is resolved
into `RuntimeConfig` beside the platform provider keys and consumed from there.
Reading `process.env` inside the titler honored an injected key while ignoring
an injected `SESSION_TITLE_ENABLED=0` in the same record — an in-process
harness would bill a real provider call it had explicitly disabled.

### D10 — Hover stops rising

`.lift:hover` drops `translateY(-1px)` for `scale(1.01)`, with the background
and border transitions already in the rule carrying most of the affordance.
`.lift:active` returns to `scale(1)`. One rule, 87 call sites, no per-site
edits. The existing `prefers-reduced-motion` guard continues to zero it.

---

## 3. Work partition

Ten lanes, partitioned by **file ownership** so parallel work never contends
on a file. Phases exist only where a lane consumes another's contract.

**Phase 1 — foundations**

| Lane | Owns | Items |
|---|---|---|
| T1 Tokens/CSS | `packages/design-tokens/tokens.css`, `apps/web/src/index.css` | 3, 13 |
| T2 Compiler identity | `packages/compiler/**`, `packages/db/**` migration | 7 core |
| T3 Shared contracts | `packages/shared/**` | keystone |

**Phase 2 — server** (after T3)

| Lane | Owns | Items |
|---|---|---|
| T4 Copilot server | `apps/control-plane/src/copilot/**` | 8–11 |
| T5 Session titling | `agent_sessions` title + titler service | 14 |
| T6 Tool metadata | connection tool-cache exposure | 4 |

**Phase 3 — web** (after phase 2)

| Lane | Owns | Items |
|---|---|---|
| T7 Agent editor | `components/agents/**`, `lib/agents/**` | 1, 2, 7-web, 10–11-web |
| T8 Chat thread | `components/chat/**` (less `ChatShell`), `lib/chat/run-view.ts` | 4, 5, 6 |
| T9 Chat shell | `ChatShell.tsx`, `SessionList.tsx`, `lib/chat/time.ts` | 12, 14-web |
| T10 Copilot web | `components/copilot/**`, `lib/copilot/**` | 8–11 |

**Phase 4 — integrate**: typecheck, `bun test`, DB-gated lane, web build,
changeset, doc updates, one commit.

---

## 4. Versioning and migration ritual

- `COMPILER_VERSION` **must** bump in the same commit as the `hash.ts` change;
  the golden-digest guard fails CI otherwise and `UPDATE_GOLDEN=1` refuses to
  run without the bump.
- Two new migrations, both additive-rule-compliant: drop
  `agents_organization_id_name_uidx`; add `agent_sessions.title`.
- No `BUILD_ENV_EPOCH` change — the build environment is untouched.

## 5. Testing

Each lane carries its own tests. Beyond that:

- `hash.test.ts` gains a case proving two agents with identical definitions
  and identical **names** but different ids hash differently — the exact
  collision D1 exists to remove.
- The publish poller is tested for the navigate-away case: the store must
  outlive the editor unmount.
- The compaction reducer is tested against the no-events edge case in D4.
- The optimistic-send rollback is tested for message preservation (D8).
- Existing guards that must keep passing untouched: the golden digest, the
  Streamdown wiring and min-theme assertions, the placeholder-stability case
  in `chat-composer.test.tsx`.

## 6. Documents this change must update

`AGENTS.md` (this spec's row; the agent-identity constraint; the `.lift`
note), `docs/DEPLOY.md` (the one-time rebuild in D1), `README.md` where it
describes the editor lifecycle, and a changeset. The review pass added
`docs/runtime-worker-contract.md` (the clear/compact drain and the response's
`marker`) and `.env.example` (where the `SESSION_TITLE_*` switch is read
from).

## 7. Out of scope

Rename-preserves-world-DB (D1); a durable build queue (D2); raw tool output
as a default view (D5); retitling existing sessions retroactively (D9).
