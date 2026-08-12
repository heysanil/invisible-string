# 2026-08-11 — Agent lifecycle, chat legibility, and copilot reach

Status: **approved**, not yet implemented.
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
describes the editor lifecycle, and a changeset.

## 7. Out of scope

Rename-preserves-world-DB (D1); a durable build queue (D2); raw tool output
as a default view (D5); retitling existing sessions retroactively (D9).
