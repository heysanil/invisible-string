# Workflow Pipelines — deterministic steps with agentic sub-steps — Design (2026-08-31)

Supersedes, in whole or part:

- the **workflow concept block of `2026-07-10-agents-first-redesign.md`** — a
  workflow is no longer `TRIGGER → AGENT → INSTRUCTIONS` (one bound agent, one
  markdown memo, one LLM turn as the entire execution model) but
  `TRIGGER → STEPS`: a pipeline the control plane interprets, in which an
  agent is *a step*. Its §2.3 "**Workflows attach no extra context**" is
  superseded for `tool` steps, which reference workspace connections directly
  (agent steps still get context only through the bound agent's compiled
  artifact). Its floating-binding row survives per step: an `agent` step's
  fresh session runs the bound agent's CURRENT published version.
- the **workflow-surface copilot toolset** (the 2026-07-10 spec's Copilot row,
  carried forward through the 2026-08-11 lifecycle spec's copilot work):
  `setAgent`/`setInstructions` are REMOVED; the workflow surface is now
  `setTrigger` + granular step mutations + two read tools (§9). The 2026-08-11
  spec's copilot mechanics (steps/thought frames, `allowEdits`, the
  agent-surface toolset) survive unchanged.
- the **workflow-dispatch contract** in `docs/runtime-worker-contract.md` as it
  stood: `dispatchTriggerRun` and the `renderTaskMessage`-based task-message
  path are gone; every workflow dispatch path starts a pipeline run, and the
  "the control plane never sends eve's session `mode`" stance is retired —
  fresh agent-step child sessions send `mode: "task"` (+ `outputSchema` when
  declared; spike REPORT finding 36).

Per the no-backwards-compat decree (the platform is not deployed), there is no
v1 config union, no dual dispatch, no legacy editor branch, and no migration
UX: `version: 2` is the only shape (`packages/shared/src/workflow-config.ts`,
the literal kept for future evolution). Dev stacks holding old-shape jsonb
drafts are reset (`docker compose down -v`).

---

## 1. Decision

A workflow that is 90% deterministic (search Slack, dedupe against a cursor,
call the Linear API) was forced through an expensive tool-calling agent —
slower, costlier, unpredictable — and the deterministic parts could not be
expressed at all without burning a model turn. This redesign inverts the
model: **the workflow becomes a pipeline the control plane interprets; the
agent becomes a step.** Canonical example: every 20 min → search Slack for
`@team-exec` → dedupe against a `@state` cursor → per message: cheap-model
summarize (`infer`) → create a Linear issue with the permalink (`tool`). Only
the summarize step is agentic.

Three executor weights and four control verbs:

- **`tool`** — one deterministic MCP `tools/call` on a workspace connection,
  riding the probe's proven machinery (official SDK client, guarded egress,
  OAuth broker central refresh). No hand-built per-integration verb library.
- **`infer`** — a direct control-plane model call on a workspace preset (the
  session-titler precedent), prompt + optional structured output.
- **`agent`** — a real eve session against a bound published Agent, run as a
  **child run** through the ordinary dispatch machinery.
- **`for_each` / `branch` / `filter` / `state`** — interpreted by the runner
  itself, never by an executor.

Publishing still builds nothing — pipelines are interpreted, agent steps ride
the bound agent's already-built artifact. "A workflow builds nothing" survives
intact. A sandboxed `script` step is a designed slot, not shipped: the
`run_step_kind` pgEnum reserves the value day one (enum ordering is awkward
later), the config union gains it only when the sandboxed executor exists.

## 2. Config contract (`packages/shared`)

`workflowConfigSchema` is now
`{version: 2, trigger, steps: PipelineStep[], onComplete?, overlap}` — trigger
schemas and adapters carried over unchanged. New sibling modules:
`pipeline-config.ts` (the step union + tree helpers), `pipeline-template.ts`
(pure rendering + condition evaluation), `pipeline-events.ts` (the run-stream
vocabulary, §6), `pipeline-output-schema.ts` (the structured-output subset).

**Step identity.** Every step carries `id` (`st_` + nanoid16, machine-minted —
never model- or user-typed; chips, diagnostics and the run ledger bind here),
`slug` (unique across the tree, renameable — the `@steps.<slug>` handle; its
charset is a subset of the `@reference` segment charset), and optional `name`.

**Step union** (discriminated on `kind`; manual interfaces + annotated zod
schemas because the tree recurses):

| kind | shape (beyond base) | notes |
|---|---|---|
| `tool` | `connectionId (cn_…) · tool · args · timeoutMs? (≤300 s) · retry? {maxAttempts ≤5} · sideEffect` | `sideEffect: "at_least_once"` (default) \| `"at_most_once"` — the crash-window retry stance |
| `infer` | `preset (default "quick") · prompt {markdown} · output? {schema} · maxOutputTokens?` | |
| `agent` | `agentId (null while drafting) · instructions {markdown} · session: "fresh"\|"thread" · output? {schema}` | `"thread"` legal only with slack triggers and no output schema (publish rule) |
| `for_each` | `items {$ref} · steps[] · maxItems (≤100) · onItemError: "continue"\|"halt"` | no nested `for_each` in v1 (schema-enforced); overflow FAILS the loop (`fan_out_exceeded`), never truncates |
| `branch` | `branches [{when, steps}] · else?` | first matching lane runs |
| `filter` | `where` | false at top level ⇒ remaining steps `skipped`, run succeeds; inside a loop ⇒ item dropped |
| `state` | `set: Record<key, TemplateValue>` | write-only; reads are `@state.*` refs; key charset = slug charset |

**Template values** (`tool.args`, `state.set`): a tagged-JSON walk. Bare
strings stay LITERAL; `{"$ref": "steps.search.result.messages"}` is a
whole-value, type-preserving reference; `{"$tpl": "…@state.cursor…"}` is
string interpolation under markdown rules. Both tags are strict objects, so
`{$ref, …extras}` falls through to a literal.

**Conditions**: a JSON predicate AST
(`and/or/not/eq/ne/gt/gte/lt/lte/contains/startsWith/endsWith/exists/truthy/empty/in`,
operands = scalar literal | scalar list | `{$ref}`), pure evaluator in shared,
depth ≤8, no regex in v1.

**References**: `parseReferences` (workflow-config.ts) gained heads `steps`,
`state`, `item`, `now` — ONE grammar for markdown surfaces and Tiptap chips,
not a second moustache grammar. `stepsBefore()` computes what is addressable
from a position (document order minus own ancestors) — reference autocomplete
and the publish validator both key off it.

**Rendering** (`pipeline-template.ts`, pure — the SPA imports the same
functions for previews): the scope is
`{trigger, steps (by slug), state, item?, now}` and is deliberately the ONLY
resolution root — **credentials are structurally unreachable, so persisted
`run_steps.input` snapshots cannot contain secrets.** Three surfaces, three
missing-value semantics: markdown → `"(not provided)"`, structured →
`undefined` (keys drop, array slots null), conditions → `null`.

**Output schemas** (`infer`/`agent`): a restricted JSON-Schema subset —
object/array/string/number/boolean, string `enum`, object `required`; no
`$ref`, no `oneOf`/`anyOf`, no pattern/format; depth ≤5; strict nodes so
unsupported keywords are rejected at parse. One shared `compileOutputSchema()`
so server enforcement and SPA preview agree by construction.

**Draft-lenient by design**, exactly like the trigger schemas: empty
`connectionId`/`tool`/slugs and a null `agentId` all parse; shape plus tree
integrity (unique ids/slugs, no nested `for_each`) is what the schema guards.
The publish validator (`resources/workflow-validator.ts`) is what demands a
runnable pipeline: ≥1 step and ≤`MAX_DECLARED_STEPS` (50) declared steps,
non-empty unique slugs, published agents on agent steps, workspace-scoped +
enabled connections (user-scoped connections rejected — unattended runs use
workspace authority), legal references per position (`@item` only inside
loops, `@steps` only backwards), the thread/output-schema exclusion, and cron
validity. The ONLY warning-severity diagnostic is a tool name absent from the
connection's cached `tools/list` (the server stays authoritative); everything
else is an error. Staleness diagnostics re-run the published snapshot against
live resources (paths prefixed `published.`).

## 3. Data (`packages/db`, migration 0015, additive)

- **`run_steps`** — the execution ledger, one row per step INSTANCE: `id`
  (`rs_…`), `run_id` (FK cascade), denormalized `organization_id`,
  `step_id`/`step_slug`, **`path`** (instance path, e.g. `st_loop/3/st_b`;
  unique `(run_id, path)` = the idempotent claim key recovery replays
  against), `parent_path`, `iteration`, `kind` (pgEnum incl. reserved
  `script`), `status` (pgEnum
  `pending|running|waiting|succeeded|failed|skipped|canceled`), `attempt`,
  `input` jsonb (the rendered snapshot), `output` jsonb (capped — what scope
  rebuilding reads after a crash), `error`/`error_class`, `child_run_id`,
  timings.
- **`workflow_state`** — PK `(workflow_id, key)`, jsonb `value`,
  `updated_by_run_id`, org denormalized. App caps: ≤200 keys/workflow,
  ≤64 KiB/value.
- **`runs`** — `mode` pgEnum (`agent|pipeline`, default `agent`),
  `organization_id` (nullable, set on every NEW run of either mode),
  `workflow_id` (SET NULL), and the one relaxation: **`agent_session_id`
  DROPS NOT NULL** (pipeline parent runs have no session). ⚠️ The relaxation
  demands a **join audit**: every `runs ⋈ agent_sessions` read must be a LEFT
  join resolving the org as
  `COALESCE(runs.organization_id, agent_sessions.organization_id)` — an inner
  join silently drops pipeline runs, which on `countActiveRuns` is a cap
  bypass. `runtime/caps.ts`, the delivery reader, reconcile, and the run
  routes are audited; a dedicated caps test asserts pipeline runs hold slots.
- **`connections.tools_cache`** — entry shape widened (jsonb, no migration)
  with an optional trimmed `inputSchema`, populated on the next probe. Old
  rows degrade to name-presence checks. Feeds schema-aware arg forms, the
  tool step's structural pre-flight, and the copilot read tools.

## 4. The runner (`apps/control-plane/src/pipeline/`)

`runner.ts` (the interpreter), `plan.ts` (path grammar + plan index +
ledger→scope rebuild), `step-store.ts` (RunStepStore + WorkflowStateStore),
`events.ts` (the `pipeline.*` appender), `recovery.ts` (boot sweep),
`types.ts` (the DECREED executor interfaces: `StepExecuteContext`,
`StepOutcome`, `StepExecutor`, `PipelineExecutorDeps` — executors implement,
only the runner calls), `mcp-call.ts` + `steps/{tool,infer,agent}.ts` (§5).

**Start** (`startPipelineRun`) mirrors the old dispatch's ordering
guarantees: `overlap: "skip"` (the default; protects cursor semantics against
a slow run overlapping the next window) answers
`{started: false, reason: "overlap_skipped"}` while another run of the
workflow is live; the run row lands inside the advisory-locked workspace-cap
transaction BEFORE any execution (a crash mid-run leaves a visible,
recoverable row — never untracked work); slack-origin runs whose config
declares `onComplete.slackReply` are born owing a reply
(`delivery_status = pending`, §7). Parent and child runs EACH hold a
workspace-cap slot. `TriggerEvent.agentId` on a pipeline parent run is the
nil-uuid placeholder `PIPELINE_TRIGGER_AGENT_ID` (the envelope predates
pipelines and demands a uuid; it remains provenance only).

**Driver**: sequential, `for_each` concurrency 1 (determinism, plus the
single-writer world-DB residual argues against fan-out onto one agent hash).
Per instance: claim the `(run_id, path)` ledger row → render input against
the scope (shared pipeline-template) → execute (leaf kinds via the injected
executor registry; control verbs interpreted in the runner) → persist output
→ append events → extend the scope. The driver holds a SESSION-level
`pg_advisory_lock('pipeline:'||run_id)` on a reserved postgres-js connection
for its lifetime.

**Crash recovery is replay** (`recovery.ts`, called from
`reconcileInterruptedRuns` before the delivery sweep; the old sweep now
filters to `mode='agent'`): boot hands acquirable orphans (lock free) to
`runner.resume`, the driver walks the config from the top, and every claim
that returns an existing row is ADOPTED — terminal outputs rebuild the scope
without re-execution, only the frontier truly runs. An interrupted `tool`
step retries (the at-least-once stance of runs/delivery) unless
`sideEffect: "at_most_once"`, which fails `interrupted` — the honest option;
`infer` retries; `agent` re-attaches to its child by `child_run_id`. The
lock-gated adoption is the schedule-ticker pattern — no NEW single-instance
dependency (the control plane remains single-instance for other reasons).

**Retries**: exponential backoff 2 s·2ⁿ⁻¹ capped 60 s with half-jitter.
Budgets per kind: tool 3 (config `retry.maxAttempts` overrides), infer 2 (its
schema-repair retry is the executor's own), agent 2 — and the runner retries
only outcomes the executor classified `retryable` (§5). Control verbs: 1.

**Caps**: per-attempt timeouts (tool 60 s default, config ≤300 s; infer
120 s), `PIPELINE_MAX_WALL_CLOCK_MS` (default 30 min, whole run),
`PIPELINE_MAX_STEPS_PER_RUN` (default 200 executed instances),
`PIPELINE_MAX_STEP_OUTPUT_BYTES` (default 256 KiB serialized per-step output
→ `output_too_large`), `for_each` overflow → `fan_out_exceeded` (silent
truncation would corrupt cursors).

**Cancellation** is cooperative at step boundaries (eve's stance): cancel
sets a flag + aborts the in-flight attempt's signal; an agent step's cancel
also cancels the live child run; the run lands `canceled` — a user decision,
never an error. `stopAll()` (process shutdown) interrupts WITHOUT terminal
writes; recovery re-adopts on the next boot.

**Terminal + delivery**: failed iff any non-isolated step failed
(`onItemError: "continue"` records item failures in the loop's aggregate
output without failing the loop). Delivery is §7's — explicit only.

## 5. Step mechanics

**`tool`** (`steps/tool.ts` over `mcp-call.ts`): connection loaded
workspace-scoped + enabled; auth per type — none, static headers via
`decryptConnectionAuthHeaders`, or a live OAuth access token through the
broker's central refresh — plaintext confined to function scope. `mcp-call.ts`
extends the probe's dial machinery (same transport construction, outer
deadline, close-in-finally, `scrubSecrets` over every failure message) with
one `tools/call`; fresh client per attempt (pooling can arrive later behind
the module boundary), every dial through the guarded egress fetch. Output =
`{result: structuredContent ?? parsed-single-text-JSON ?? null, text
(truncated), isError}`. Classification is finer than the probe's because
retry policy keys off it: retryable is EXACTLY
`unreachable`/`timeout`/`rate_limited` (429)/`server_error` (5xx); a JSON-RPC
answer means the server is up, so `tool_error` (isError), `invalid_args`, and
`config_error` never retry — and a "tool not found" additionally
fire-and-forgets a re-probe to refresh the cache. Structural pre-flight runs
against the CACHED `inputSchema` when present; a cache miss calls anyway (the
server stays authoritative). Approval/HITL on tool steps is deferred with the
slot designed (`waiting` + `POST /runs/:id/input` exist; an `approval` field
is additive later).

**`infer`** (`steps/infer.ts`): preset → `resolvePresetModel`
(`model/presets.ts`, the generalized extraction of the titler's resolver);
provider + reasoning effort routed through `model/reasoning.ts` exactly as
the titler (OpenRouter effort on `extraBody`, Anthropic top-level, `max`
clamped `xhigh` only there); provider keys come from the injected record,
never `process.env`; the workspace model allowlist is re-checked at
execution. No schema → `generateText` → `{text, usage}`; schema →
`generateObject` + the SHARED compiled validator belt-and-braces →
`{result, usage}`, with ONE repair retry re-prompting with the validator's
errors before `validation_failed`. Prompt clamp 128 KiB fails `input_too_large`
(truncation = confidently wrong output). `usage` sums across repair
round-trips and persists per step (substrate for later spend caps).

**`agent`** (`steps/agent.ts` over `dispatchRenderedRun`, §7): a CHILD run +
session through the ordinary machinery (scheduler → ensure-agent → eve
session → tailer), so SSE/reconcile/409-handling/wall-clock apply unchanged;
`run_steps.child_run_id` links them. The runner renders instructions against
the full scope; the child receives that string as its task message.

- `session: "fresh"` sends **`mode: "task"` unconditionally** — nobody
  watches a pipeline child in chat, so a token-budget crossing must fail the
  call (`SESSION_TOKEN_LIMIT_REACHED`), not park forever on a prompt nobody
  answers — and, **spike-proven** (REPORT finding 36, wire capture
  committed), `outputSchema` on create when the step declares one; the turn
  emits `result.completed` carrying the schema-shaped payload. Amendment A3
  resolved: send it. Task mode terminates the session (data-less
  `session.completed`); completion is keyed on the child RUN ROW's status,
  never a follow-up send or 409 probe (eve 202-and-drops follow-ups to a
  completed task session).
- `session: "thread"` is Slack thread continuity: the thread key the ingress
  stamps into the parent's `TriggerEvent.data.slackThreadKey` resolves an
  existing thread-keyed session (advisory-locked claim + dead-holder
  eviction, machinery now inside the new dispatch) whose PINNED version takes
  a follow-up turn; no session yet mints a fresh conversational one. The
  lookup is QUALIFIED-FIRST: the step probes its own agent-qualified key
  `<bareKey>:agent:<agentId>` before the bare key, reuses a bare holder only
  when its `agentId` matches, and on mismatch claims the qualified key — so
  each agent in one thread keeps its own session and cross-run continuity
  even after the bare holder terminates and releases its key. The ingress
  known-thread gate (`isKnownSlackThread`) matches the bare key OR any
  `:agent:` derivative, so unmentioned replies keep flowing under
  `mentionOnly`. The session `principal` keeps the BARE key — the true
  Slack-thread identity — and the qualified form deliberately fails
  `parseSlackThreadKey`'s 3-segment contract so it can never mis-target a
  reply. Never `mode: "task"`, never an output schema (publish gate).
- Output extraction is ALWAYS local belt-and-braces: `result.completed` →
  `output.result` (validated against the declared schema →
  `validation_failed` on miss), else the last stop-message text →
  `output.text`.
- CHILD LINKING IS PRE-DISPATCH: the executor passes dispatch an
  `onRunCreated` hook that writes `run_steps.child_run_id` (keyed by the
  unique `(run_id, path)` claim) INSIDE the transaction that creates the
  child run row, before any eve call — an unlinked dispatched child cannot
  exist by construction, so replay always re-attaches instead of
  double-dispatching. The hook also fences cancellation (aborts the
  transaction when the attempt's signal fired or the parent run is already
  terminal), and dispatch CAS-writes a dispatch-attempt marker
  (`runs.started_at`) strictly before the eve call: a crash before the
  marker is provably undispatched (stillborn recovery re-dispatches fresh);
  a crash between marker and eve-session-id persist is undecidable and
  fails honest (`agent_run_failed`) — at-most-once, never a double
  dispatch. The executor then returns `{status: "waiting", childRunId}` and
  the runner re-invokes with `ctx.childRunId`. While
  the child runs the executor waits on a RunEventBus subscription plus a
  `PIPELINE_CHILD_POLL_MS` poll; a child parking `waiting` (HITL) parks the
  parent step and run, and `POST /runs/:id/input` on the CHILD resumes the
  chain.
- Retry policy: dispatch-phase failures only — `session_busy` transient
  (retry), `session_not_active` permanent (the dispatch already evicted the
  dead thread claim; the retry mints a fresh session). A failed/canceled
  child TURN is never retried. The two-409s doctrine's consumer for
  workflows is now this executor.

## 6. Events + streaming (`pipeline-events.ts`, `pipeline/events.ts`)

Step lifecycle events append into the PARENT run's `run_events` beside eve
events, under the same monotonic `seq` (tailer-style claim) — SSE resume
(Last-Event-ID) carries step timelines with zero transport changes.
Vocabulary (all `pipeline.`-prefixed so nothing collides with eve's own
`step.*` in a mixed stream): `pipeline.started {stepCount}` ·
`pipeline.step.started {stepId, slug, kind, path, attempt, childRunId?}` ·
`pipeline.step.completed {status: succeeded|skipped, durationMs,
outputPreview?}` · `pipeline.step.failed {attempt, errorClass, error
(scrubbed), willRetry}` · `pipeline.step.waiting {childRunId}` ·
`pipeline.state.updated {keys}` · `pipeline.completed {status, durationMs}`.
Two producer-owned content rules: `outputPreview` is capped at 2 KiB
(`buildStepOutputPreview`, UTF-8-boundary truncation), and `state.updated`
carries KEYS ONLY — state values never enter the event stream.
`RunStreamEventPayload` widened to `EveStreamEvent | PipelineStreamEvent`;
consumers MUST default-ignore unknown event types (verified in the SPA's
switch).

## 7. Dispatch rewiring (`runtime/`, `integrations/`)

`dispatchTriggerRun` and `resolveWorkflowDispatchTarget` are REMOVED. What
remains of dispatch is **`dispatchRenderedRun`** — the extracted
worker-selection → cap-locked session+run insert (org + workflow + `mode:
'agent'` set; delivery never pending on child runs) → allowlist re-check →
ensure-agent → eve create/continue → `startTail` spine, taking an
already-rendered message. Its ONLY caller is the agent step.
`WorkerClient.createEveSession` now takes the full
`EveCreateSessionRequest` (serialized verbatim), which is how `mode` and
`outputSchema` reach the wire; chat's own create sends `{message}` and stays
conversational.

- **Webhook/form ingress** (`/t/:token`): dispatches via `startPipelineRun`;
  202 body is now `{accepted: true, runId}` (no sessionId — pipeline runs
  have none) or `{accepted: false, reason: "overlap_skipped"}` (2xx on
  purpose: the sender did nothing wrong); the idempotency cache stores
  `{runId}`.
- **Slack ingress**: a Slack event on a workflow always starts a NEW pipeline
  run — thread continuity is the agent step's `session: "thread"`, keyed by
  the `slackThreadKey` the ingress stamps into `TriggerEvent.data`. The
  thread GATE is preserved: a reply in a thread with a claimed session
  dispatches regardless of the binding; a fresh thread must pass the binding
  check. Overlap-skips are logged, never silent.
- **Schedule ticker**: `dispatchDue` = `resolveEnabledPipeline` +
  `startPipelineRun` (origin/trigger type `schedule`, `data.scheduledFor`);
  claim/advance/no-backfill semantics unchanged; an overlap-skip logs
  `schedule.overlap_skipped` and never un-advances the cursor.
- **Manual run** (`POST /workspaces/:id/workflows/:wfId/run`): 201
  `{run: RunDto}` (no session), 409 `run_overlap_skipped` on overlap, 503
  `pipeline_lock_pool_exhausted` when the pipeline lock pool is pinned by
  live runs (transient; nothing created — the same code the webhook/form
  ingress answers), 409 `workflow_not_published` pre-publish.
- **Cancel** (`POST /runs/:id/cancel`): a pipeline run routes to
  `cancelPipelineRun` and cancels linked live child runs; a run with no live
  driver falls back to a direct CAS + delivery settle + bus publish.
- **Input** (`POST /runs/:id/input`): sessionless (pipeline) runs answer 409
  `no_pending_input` — HITL input lands on the CHILD run.
- **`RunDto`** gains `mode` + `workflowId`; run-ownership loads are LEFT
  joins with the COALESCE org (§3).
- **Delivery**: pipelines get EXPLICIT delivery only. The one writer of
  `delivery_status = 'pending'` is the pipeline run creator, for slack-origin
  parent runs declaring `onComplete.slackReply`; the runner's terminal path
  renders the template against the final scope and the existing
  DeliveryService CAS machinery posts it. The implicit
  last-assistant-message delivery is removed with the v1 dispatch — a
  pipeline has no well-defined "final assistant message"; guessing posts
  wrong content. Boot recovery re-renders a succeeded-but-unposted reply from
  the published template + the scope rebuilt from `run_steps`
  (`rebuildScopeSteps`). At-least-once semantics unchanged.
- **`PublishedWorkflow`** reshaped to `{workflow, config}` — no top-level
  `agentId`. Publish stops writing `workflows.published_agent_id` (dead but
  present, additive rule); its delete-protection role moved to the agent
  DELETE path, which scans PUBLISHED workflow configs for agent-step
  references and 409s with the referencing workflow names (drafts no longer
  block).

## 8. API surface (`pipeline/routes.ts`, mounted beside the runtime plugin)

All workspace-scoped (`requireWorkspace` + row ownership; authz-matrix
tested: anonymous 401, outsider 403, foreign row 404, member reads,
admin-only state DELETEs), all under the existing `/workspaces` and `/runs`
nginx prefixes — **no `infra/nginx/web.conf` change**:

| Route | Notes |
|---|---|
| `GET /workspaces/:wsId/workflows/:wfId/runs` | `?status`, `?limit` (default 50, ≤200); both run modes via the LEFT-join discipline |
| `GET /runs/:runId/steps` | ledger previews; `?full=1` for capped input/output |
| `GET/DELETE /workspaces/:wsId/workflows/:wfId/state[/:key]` | operator cursor surgery; DELETEs admin-gated; deleting a missing key answers `{deletedKeys: 0}` |
| `POST /workspaces/:wsId/workflows/:wfId/steps/:stepId/test` | tool + infer only (422 `step_not_testable`); renders against a caller-supplied partial scope and executes the REAL executor (side effects are real — UI copy owns saying so); a failed EXECUTION is the 200 payload's `failed` arm, never an HTTP error |

Pipeline-dependent routes answer a typed 503 `pipelines_unavailable` when the
runtime is unconfigured (`requirePipelines`).

## 9. Copilot (conversational-first authoring)

The workflow surface is now granular step mutations — `addStep {step,
position}`, `updateStep {stepId, step}` (whole-step replacement),
`removeStep`, `moveStep`, plus the kept `setTrigger` — with
`stepPositionSchema = {after: stepId|null, parent?: {stepId, slot:
"body"|"then"|"else"}}` (a branch's lane resolves from `after`; `after: null`
with `slot: "then"` targets the first lane). A whole-pipeline `setPipeline` was
REJECTED: unreviewable cards, no rejection granularity, and validate.ts's
accepted-state threading is exactly what granular tools need. **Ids for
`addStep` are minted by validate.ts** (`mintStepIds` — model-supplied ids are
stripped first, even well-formed ones); unknown ids bounce with the known-id
list. `copilot/pipeline-draft.ts` holds the pure tree mechanics (position
resolution, insert/replace/remove/move, the publish-gate-mirroring problem
collector); simulate and apply share the same functions so they cannot drift,
and only NEW problems block a proposal (draft-lenient, like the schemas).

Two server-executed READ tools — `searchConnectionTools {query,
connectionId?}` and `getConnectionTool {connectionId, toolName}` — run inline
in the session loop (pure lookups over the probe's cached `tools/list`, no
proposal park), emitting existing `step` frames. They make the prompt's hard
rule enforceable: tool DETAIL stays out of the system prompt (the inventory
carries a capped name index), and "ALWAYS call searchConnectionTools before
proposing a tool step — never invent tool names".

`buildWorkflowSystemPrompt` teaches the pipeline model and the step-choice
doctrine: deterministic + knowable args → `tool`; cheap structured transform
→ `infer`; open-ended/multi-tool → `agent`; the cheapest kind that suffices.
`maxStepsPerTurn` is per-surface (workflow 24, agent 12 —
`COPILOT_MAX_STEPS` overrides both). `allowEdits` default is now
surface-aware: ON for never-published drafts, OFF once published; still
session-scoped and unpersisted.

## 10. Product surfaces (`apps/web`)

- **Shell**: `CopilotThread`/`CopilotComposer` extracted from the dock
  (~80% surface-agnostic; the agent editor's dock untouched). The workflow
  editor is two-pane: ComposerPane (transcript + composer, primary) left,
  PipelinePane (`clamp(360px, 34vw, 460px)`) right with TriggerCard + the
  vertical step strip. <1180 px: a Compose | Pipeline SegmentedControl with
  pending/issue-count badges; both panes stay mounted-hidden so the socket
  and draft survive. The route splits into Edit | Runs segments
  (`_app.workflows.$workflowId.{index,runs,runs.$runId}.tsx`).
- **Strip** (`components/pipeline/`): PipelineStrip, TriggerCard, StepCard
  (three densities: compact/default/run), StepConnector (hairline spine +
  hover "+" + run pulse), NestedSteps (indented rail; branch = stacked
  labeled lanes), AddStepMenu (incl. "Describe it instead →" focusing the
  composer), StepStatusBadge, GhostStepCard. E1 throughout; color only as
  meaning; reduced-motion honored.
- **Inspectors**: selected card expands inline (accordion, 180 ms ease-out);
  deep infer/agent forms get a Drawer escape hatch that REPLACES the inline
  form — one Tiptap mounted at a time, constant placeholder/ariaLabel per
  mount (the AGENTS.md invariant). ToolStepForm: connection select with
  health, searchable tool picker, schema-aware arg fields when `inputSchema`
  is cached (name-keyed template fields otherwise), raw-JSON toggle.
  Condition rows: ref picker · operator · value. Reference sources are
  computed per position (`stepsBefore` only; `@item` only inside loops).
  Diagnostics address steps by config path (`steps.0.branches.1.steps.2.…`).
  `StepTestPopover` fronts the step-test route for tool/infer.
- **Ghost proposals**: pending step mutations render dashed placeholders at
  the target strip position; apply solidifies with the pillar-flash
  treatment; proposal cards carry a compact StepCard diff (args as key-value
  diff, markdown via DiffView).
- **Runs**: the same strip in `run` density IS the timeline — one grammar for
  the object at rest and in motion. `lib/pipeline/run-progress.ts` is the
  single pure reducer absorbing `pipeline.*` events over a `run_steps`
  ledger seed (last-event-wins per step; `willRetry` failures stay running;
  settled runs mark unreached steps skipped). The step drawer shows capped
  input/output per instance; **agent steps embed the child run's chat
  transcript** (streamRun → reduceRunView → RunMessage, HITL wired), tool/
  infer get the plain panel.
- **List**: `WorkflowSummaryDto` carries `stepKinds` (kind-glyph capsule +
  "N steps") and a sole-agent-step `agentName` so single-agent rows keep
  today's agent chip.
- Scope cut (amendment A1): the background pipeline advisor and ConvertBanner
  are dropped; a "Convert this workflow into steps" copilot prompt chip
  serves single-agent-step pipelines.

## 11. Security posture

- The template scope cannot reach credentials (§2), so ledger snapshots and
  events are structurally secret-free; every failure string is scrubbed
  (probe `scrubSecrets` discipline) before persistence or events.
- Every tool-step dial rides `createGuardedFetch` (DNS-pinned, HTTPS-only,
  same stance as probe + broker); OAuth plaintext lives in function scope.
- Prompt injection across steps (hostile tool output flowing into infer/agent
  prompts) is documented, not fenced, in v1: deterministic steps cannot be
  steered into arbitrary tool use (only declared steps run), and an agent
  step's blast radius is its own compiled context. Real fencing later.
- At-least-once tool side effects can double-fire in crash windows — the same
  accepted residual as Slack delivery; `sideEffect: "at_most_once"` is the
  opt-out and attempt counts are visible in the timeline.

## 12. Config knobs

| Variable | Default | Meaning |
|---|---|---|
| `PIPELINE_MAX_WALL_CLOCK_MS` | 1800000 (30 min) | whole-run budget |
| `PIPELINE_MAX_STEPS_PER_RUN` | 200 | executed step instances per run |
| `PIPELINE_MAX_STEP_OUTPUT_BYTES` | 262144 (256 KiB) | serialized per-step output cap |
| `PIPELINE_CHILD_POLL_MS` | 5000 | parked agent-step child-run poll cadence |

All tuning knobs, not required config — unset/invalid falls back to defaults.

## 13. Testing

Runner semantics against in-memory fakes (34-case driver suite: retries,
budgets, wall clock, caps, cancellation, crash-resume replay, `at_most_once`
`interrupted`, loop isolation, filter/branch/state, overlap); DB-gated suites
for the stores, events, recovery, routes (full authz matrix), caps-join
audit, workflows CRUD/publish/staleness, and dispatch; executor suites with a
stub MCP server (`MCP_PROBE_ALLOW_PRIVATE=1`); the spike gate
`spike/tests/task-output-schema.test.ts` (`SPIKE_EVE_BUILD=1`) is the wire
proof behind finding 36; web suites cover the reducer, shell, strip,
inspectors, and runs routes. Lanes: `bun run typecheck`, root `bun test`,
DB-gated, e2e.

## 14. Documentation

This spec joins the AGENTS.md living-documents table; AGENTS.md's header,
architecture, constraints and residuals sections, README's workflow surfaces,
`docs/PLAN.md` (Phase 7 note), `docs/runtime-worker-contract.md` (ingress/
dispatch/delivery/ticker/env), and `.env.example` (§12 knobs) move in the
same commit, per the docs-move-with-code rule. One changeset names
`@invisible-string/{control-plane,db,shared,web}` at minor with a
`**Breaking:**` summary.
