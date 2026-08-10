# Runtime ⇄ worker / compiler contract

Reconciled at the Integrate stage — this document describes what the code
actually does on BOTH sides (apps/control-plane ⇄ apps/worker ⇄
packages/compiler). The end-to-end proof is
`tests/integration/phase1-acceptance.test.ts`.

Agents-first (2026-07-10 redesign): the **Agent is the compile unit** — an
**agent version** (immutable published snapshot, identified by content hash)
is what gets built, stored, ensured, and dispatched. Workflows are standing
delegations (trigger → agent → instructions) and compile NOTHING; compiled
agents expose only eve's default channel, and every dispatch path speaks
eve's session API.

## Worker HTTP surface the control plane calls

### Internal plane (shared secret)

```
POST <worker>/internal/agents/ensure
x-worker-secret: <WORKER_SHARED_SECRET>
{ "versionHash": "<contentHash>",
  "artifactUrl": "<presigned GET url of artifacts/<hash>.tar.gz>",
  "env": { ...full agent process env, secrets included... } }
→ 200 {hash, port, url, startedAt, reused} once the agent is running &
  healthy (idempotent)
```

- `env` is spawn-time-only material. The supervisor must never write it to
  disk or logs, and must additionally pin `NODE_ENV=production` on the agent
  process (spike/REPORT.md finding 5 — bun/vitest NODE_ENV leaks flip eve
  into mock-model mode).
- Client: `apps/control-plane/src/runtime/worker-client.ts` (createWorkerClient).

### Agent proxy plane (platform JWT)

```
<worker>/agents/<contentHash>/eve/v1/*                      → agent's eve routes
<worker>/cb/<callbackToken>/agents/<contentHash>/.well-known/workflow/* → run callbacks
```

Both prefixes MUST be forwarded (PLAN correction 10), but `.well-known/
workflow/*` (eve's UNAUTHENTICATED run-callback surface) is only reachable
through the `/cb/<token>/…` route: the token is a per-boot secret the
supervisor hands ONLY to its co-located agents via
`WORKFLOW_LOCAL_BASE_URL`, so external clients cannot forge step/flow
callbacks (public `/agents/<hash>/.well-known/…` → 403).

Calls onto `/eve/v1/*` carry `authorization: Bearer <HS256 JWT>` minted per
call with `iss=invisible-string`, exp ≤ 120 s (`src/runtime/jwt.ts`), and a
VERSION-BOUND contract: audience `agent-version:<contentHash>` and signing
secret `derivePlatformJwtSecret(PLATFORM_JWT_SECRET, contentHash)` — the
compiler bakes the matching audience into the generated verifier and the
agent env receives only the derived secret, so a leaked agent env or token
is useless against any other agent version. Compiled channels verify via
eve's `verifyJwtHmac`.

Used today by the control plane (this is the ONLY dispatch surface — there
are no per-trigger channels; chat, webhook, form, Slack, schedule, and manual
"Run now" all speak eve's session API):

### eve session API v2 — ID-addressed (eve 0.31)

0.31 retired continuation tokens: a session is addressed by its **id in the
path**, and every route below returns 400 if the request body carries a
`continuationToken` key at all — eve's guard is `"continuationToken" in body`,
not a truthiness test, so `{continuationToken: null}` is a hard 400 while a
key dropped by `JSON.stringify` is fine. Wire shapes, route builders and body
guards live in `packages/shared/src/eve-session-api.ts` (cross-checked against
eve 0.31.3's shipped handlers); build bodies from them rather than by hand.

| Call (through `<worker>/agents/<hash>`) | Body | Answer |
|---|---|---|
| `POST .../eve/v1/session` | `{message}` (+ optional `mode`, `capabilities`) | **202** `{ok, sessionId, status:"accepted"}` + `x-eve-session-id` |
| `POST .../eve/v1/session/:id` | `{message}` **XOR** `{inputResponses:[{requestId,optionId?,text?}]}` | 202 `{ok, sessionId, status:"accepted"}` · **409** `{ok:false, code:"session_not_active"}` |
| `POST .../eve/v1/session/:id/cancel` | optional `{turnId}` | 202 `{…status:"accepted"}` · 200 `{…status:"no_active_turn"}` |
| `POST .../eve/v1/session/:id/clear` | optional, empty | 202 `accepted` · 200 `no_active_session` |
| `POST .../eve/v1/session/:id/compact` | optional, empty | 202 `accepted` · 200 `no_active_session` |
| `POST .../eve/v1/session/:id/reset` | optional `{reason}` | **always 200**: `{ok, previousSessionId, status:"reset"}` · `{ok, status:"no_active_session"}` |
| `GET .../eve/v1/session/:id/stream` | `?startIndex=<n>&includeTailIndex=1` | 200 NDJSON (+ `x-eve-stream-tail-index` when asked) · 404 |

- **Send XOR respond**: both fields present → 400, neither → 400.
  `POST /runs/:id/input` forwards a parked run's answer as the
  `inputResponses` form; `inputResponses` on *create* is also a 400.
- **`reset` is the odd one out** — both outcomes are 200 (never 202) and its
  id field is `previousSessionId`, not `sessionId`. The retired id can never
  accept another message; a replacement needs a fresh create.
- **`no_active_turn` / `no_active_session` do NOT mean "nothing was
  running."** eve renders ONE condition — a dead session command hook — as
  `session_not_active` (send), `no_active_turn` (cancel) and
  `no_active_session` (clear/compact/reset). So a 200 there carries the same
  terminal meaning as a 409 on send, and a 202 never proves a turn was
  stopped: a cancel against a live-but-idle session answers 202 `accepted`
  (REPORT finding 24).
- **Cancellation is cooperative**, at durable step boundaries: a tool call
  already in flight runs to completion and still emits its `action.result`;
  the turn then ends `turn.cancelled` → `session.waiting`, never
  `turn.failed`. A cancel posted before `turn.started` is accepted and
  consumed as a no-op — it does not arm a pending cancellation.
- **Session limits apply whether or not we configure them**: a 40,000,000
  input-token budget per root session and a 30-day `sessionTimeoutMs`
  (constants in `packages/shared/src/eve-events.ts`). The create body's `mode`
  decides what a budget crossing does — `conversation` (the default, and what
  `capabilities.requestInput` implies) parks on a deterministic Approve/Stop
  prompt carrying `kind: "session-limit"`; `task` skips the prompt and fails
  with `SESSION_TOKEN_LIMIT_REACHED`. A dispatch path with no human watching
  wants the latter; a parked prompt nobody can answer hangs forever.
- The **worker needs no change** for the four control routes: the proxy
  forwards all of `/eve/` generically, and the sandbox reaper's activity
  regex (`/^\/eve\/v1\/session\/([^/?]+)/`, `apps/worker/src/server.ts`)
  already matches the sub-routes.

### Event stream (NDJSON, stream version 21)

`GET .../eve/v1/session/:id/stream` answers
`content-type: application/x-ndjson`, `x-eve-stream-version: 21`,
`cache-control: no-store, no-transform`, `x-accel-buffering: no`.

- `startIndex` is an absolute event count; **negative values are
  tail-relative** (`-1` = latest event). It stays the authoritative cursor.
- `includeTailIndex=1` (or `true`) adds **`x-eve-stream-tail-index`**: the
  zero-based index of the last durably recorded event, or `-1` for an empty
  stream. Absent header ≠ `-1` — absent means the flag was not sent (or the
  agent predates it); `-1` means there is nothing to catch up on. This is the
  bounded catch-up read; there is **no `follow` query parameter** (`follow:
  false` is an `eve/client` construct, and so is
  `streamReconnectPolicy: {reconnect:false}` — the tailer speaks raw fetch and
  therefore owns cursor recovery structurally. Any future `eve/client` usage
  MUST pass `{reconnect:false}` or its internal reconnect loop contends with
  ours and double-consumes).
- Every event carries **`meta.id`** — an `evt_`-prefixed ULID, stable across
  reconnects, rewinds and replays (REPORT finding 25). It is a dedupe KEY, not
  a cursor: ULIDs are time-ordered but not totally ordered across steps, and a
  retried durable step re-emits under NEW ids with the same
  `turnId`/`stepIndex`/`sequence`.
- New event types in 0.31: `turn.cancelled` (NOT a failure — always followed
  by `session.waiting`), `context.cleared`, `action.partial`
  (last-write-wins per `callId`). `input.requested` gained a required `kind`
  discriminator (`tool-approval` | `question` | `session-limit`).
- `session.waiting.data.continuationToken` survives as a compatibility echo of
  the session id. It is never accepted on any request — do not read it back.
- The serializer emits a **bare LF before the first event** (a proxy/header
  flush primer, read from eve's `serializeAsNdjson`); a line splitter must skip
  empty lines and must not count them toward the cursor.

## Env injected per agent (ensure-agent `env`)

The env map is **identical across all dispatch paths** — no per-trigger env
injection exists. In particular `SLACK_BOT_TOKEN` is NOT agent env anymore:
Slack replies are posted by the control-plane DeliveryService (below), so bot
tokens never reach a worker or an agent process. (`WORKFLOW_*` names are the
eve world package's contract — never rename them to match platform nouns.)

| Var | Value |
|---|---|
| `WORKFLOW_POSTGRES_URL` | the version's **dedicated world database** (below) |
| `WORKFLOW_POSTGRES_JOB_PREFIX` | contentHash — observability ONLY, does not isolate |
| `WORKFLOW_POSTGRES_MAX_POOL_SIZE` / `WORKFLOW_POSTGRES_WORKER_CONCURRENCY` | per-agent connection budget (defaults 5/5 — REPORT finding 15) |
| `PLATFORM_JWT_SECRET` | channel-auth secret, **derived per version** (`derivePlatformJwtSecret(master, contentHash)`) — never the platform master |
| `OPENROUTER_API_KEY` **or** `ANTHROPIC_API_KEY` | exactly ONE, matching the version's resolved provider (`agent_versions.model_provider`) |
| `OPENROUTER_BASE_URL` | passthrough when set (test harnesses) |
| `MCP_<NAME>_TOKEN` | decrypted MCP connection bearer tokens; `<NAME>` = connection name upper-snaked (`src/runtime/agent-env.ts` `mcpTokenEnvName`). The compiler-emitted `connections/*.ts` reads `MCP_<SLUG>_TOKEN` (`connectionTokenEnvVar(slugifyName(name))`) — the adapter (`src/build/compiler-adapter.ts`) asserts both sides agree at compile time. Header-auth connections get one `MCP_<NAME>_HEADER_<H>` per header instead (`mcpHeaderEnvName`, same drift guard). **OAuth connections get NO `MCP_*` env at all** — their generated `getToken` calls the token broker (below) at tool-call time |
| `PLATFORM_API_URL` | control-plane base URL as reachable from the worker network (present only when configured — absent, oauth connections' tool calls fail with a missing-env error, nothing else breaks). Read by the compiler-emitted `lib/platform-token.ts` (same env-name constant on both sides, `PLATFORM_API_URL_ENV`) to POST `/internal/connections/token` |
| `EVE_MOCK_AUTHORED_MODELS` | TEST HARNESS ONLY passthrough (set on the control plane → forwarded per agent); eve serves turns with its built-in mock model |

The supervisor adds `PORT`, `NODE_ENV=production` (REPORT finding 5) and
`WORKFLOW_LOCAL_BASE_URL=${publicUrl}/agents/<hash>` (its own proxy base —
REPORT finding 9; caller env may override) itself, plus the ambient
PATH/HOME/LANG/TMPDIR. Worker registration:
`POST /internal/workers/{register,heartbeat,deregister}` on the control
plane, `x-worker-secret`-guarded (`src/runtime/workers.ts`).

## Agent-facing token broker (control plane)

`POST /internal/connections/token` — the runtime half of the MCP OAuth broker
(connectors redesign spec §6). Callers are COMPILED AGENTS: the generated
`getToken` helper mints a short-lived HS256 platform JWT with the version's
in-env `PLATFORM_JWT_SECRET` (audience `agent-version:<contentHash>`) and
posts here to obtain a live access token for one of its OAuth connections.
The route shares the `/internal/*` prefix with the worker plane but NOT its
auth model: a version-bound platform JWT, never `x-worker-secret`.

- **Request:** `Authorization: Bearer <agent-minted JWT>` +
  `{"connectionId": "cn_…"}`. Any other body field is ignored — in
  particular, a `versionHash` in the body can never steer version
  resolution.
- **Verification order (exact, security-relevant** —
  `src/runtime/routes.ts` `serveConnectionToken`**):** read the UNVERIFIED
  `aud` claim and require the strict shape `agent-version:<64-hex>` (this
  rejects the bare `agent-version` audience channel dispatch uses) → verify
  signature/`exp`/issuer against the audience-derived per-version secret
  (`derivePlatformJwtSecret(master, hash)`) — a JWT minted in a different
  version's env fails here → resolve the agent version by the VERIFIED
  audience hash — never from the request body → authorize by membership: the
  connection id must be in that version's compiled definition.
- **Response:** `{token, expiresAt}` only. Refresh tokens and client secrets
  NEVER leave the control plane — refresh happens centrally inside this call
  (single-flight `SELECT … FOR UPDATE`, `src/oauth/tokens.ts`) when the
  stored access token is stale.
- **Errors:** one opaque 401 for every credential failure (missing/
  malformed/expired/cross-version JWT, unknown version hash), 403
  `connection_not_in_version`, 409 `oauth_not_connected` (grant absent/
  expired/revoked — re-consent is the only recovery; the agent surfaces it
  as a failed tool call, never a hang).

Blast radius (spec §13): a leaked agent env can mint valid JWTs only for its
OWN version — the audience and the derived signing secret both bind the
content hash — so the route serves exactly the connections named in that one
version's definition. Agents reach the route at the control-plane base URL
on the worker network (injected as agent env by the oauth codegen slice);
like the rest of `/internal/*` it is not proxied by the public web gateway
(`infra/nginx/web.conf`) and must never be internet-reachable (deployment
constraints below).

## Trigger ingress + dispatch (control-plane public surface)

Trigger ingress lives on the control plane, not the worker. Public endpoints
authenticate by token/signature (no session):

- `POST /t/:token` — webhook + form ingress. The `:token` (plaintext, shown
  ONCE at mint) is SHA-256-hashed and matched against `triggers.token_hash`
  (constant-time indexed lookup; plaintext is never stored). Per-token +
  per-IP rate limits and a 256 KiB payload cap run BEFORE parsing. → 202
  `{accepted, runId, sessionId}`.
- `POST /integrations/slack/events` — Slack Events API. Missing auth headers,
  per-IP rate limit, and a 256 KiB body cap are checked BEFORE the HMAC;
  signature (`v0` HMAC) + 5-min replay window next; `event_id` dedup makes
  Slack retries idempotent; a `message` twin of an `app_mention` (one channel
  mention arrives as BOTH, with different event_ids) is dropped whenever the
  message text contains the bot mention ANYWHERE (Slack fires `app_mention`
  for mid-text mentions too — a leading-only check would double-dispatch
  them); routed by `team_id` → integration → bound workflows;
  `thread_ts ↔ agent_session` continuation via the indexed
  `agent_sessions.slack_thread_key` column (partial unique per workflow — two
  racing first-messages of a new thread resolve to one session, the loser's
  `session_busy` is logged and dropped). A session that reaches a TERMINAL
  status (closed/error) RELEASES its thread key (`markSession` nulls it, and
  the new-session re-check evicts any legacy terminal holder), so the next
  message in that thread mints a fresh session instead of being silently
  dropped forever. Since 0.31 that release has a SECOND trigger — an eve 409
  `session_not_active` on a continue (below) — because the platform row can
  lag eve's terminal truth indefinitely. DMs (`channel_type: im`) key the
  session on the IM channel itself, so a 1:1 conversation keeps one ongoing
  session without threading.
- `GET /integrations/slack/callback` — single platform Slack app OAuth
  redirect-back (state-signed); per-team bot token stored envelope-encrypted,
  keyed by `team_id`. The install kickoff is workspace-scoped:
  `GET /workspaces/:id/integrations/slack/install`.

**Dispatch (agents-first contract, `runtime/dispatch.ts`).** Every non-chat
path (webhook / form / Slack / schedule / manual "Run now") resolves the
workflow's published snapshot + the delegated agent's CURRENT published
version (FLOATING binding — a new session runs the agent's current version;
a continuation always runs the session's PINNED version), renders the
workflow's instructions against the event (`renderTaskMessage`,
`packages/shared`) and sends THAT string as the eve session message —
`createEveSession` for a new session, `continueEveSession` for a thread
reply. **The `TriggerEvent` envelope is never sent to the agent**; it is
persisted on the run purely as provenance (`runs.trigger_event`, alongside
the rendered `task_message`). There is no compiled trigger channel and no
per-trigger agent env.

**One run per eve session at a time (hole closed):** `waiting` (parked HITL)
counts as busy alongside queued/running — a new message into a parked session
is 409 `session_busy` ("answer the pending approval first"), and
`POST /runs/:id/input` refuses while any OTHER run of the session is
dispatching. Exactly one tail per eve NDJSON stream at any instant.

**Two 409s with OPPOSITE recoveries — never collapse them** (constants:
`SESSION_BUSY_ERROR_CODE` / `SESSION_NOT_ACTIVE_ERROR_CODE` in
`packages/shared/src/api.ts`):

| Code | Origin | Meaning | Recovery |
|---|---|---|---|
| `session_busy` | the PLATFORM's own one-tail-per-session guard (above) | transient — a run is already queued/running/waiting | wait, retry; a racing Slack twin is logged and dropped |
| `session_not_active` | eve, 409 on `POST /eve/v1/session/:id` | **permanent for that session id** — unknown, terminal, reset, or timed out | never retry: close the platform session row (releasing any `slack_thread_key`), fail the run with this code, and let the next message mint a fresh session |

`session_not_active` is a semantic *widening* of the 0.19 busy 409, not a
rename, and it is why eve's truth can diverge from `agent_sessions.status`
indefinitely: the default 30-day `sessionTimeoutMs` emits `session.completed`
into a stream nobody is tailing, and a `reset` retires the id — in both the
platform row stays `active`/`waiting`. (A task-mode token-budget breach would
be a third cause, but the control plane never sends eve's session `mode` on
any dispatch path, so every session runs in eve's default conversation mode
and parks on a `session-limit` input request rather than failing. That is
deliberate: chat, webhook, form, Slack and schedule runs are all observable
and answerable in chat, so a budget prompt always has a human who can reach
it. Sending `mode: "task"` would turn those into hard failures.)
The status-driven Slack thread-key eviction alone can
never fire for those rows, so the eve-driven eviction (a 409
`session_not_active` on a continue) is the second release trigger and is what
keeps a Slack thread from bricking forever.

**Turn cancellation.** `POST /runs/:id/cancel` remains the single platform
contract (there is deliberately no second session-scoped cancel route); it now
fronts eve's real `POST /eve/v1/session/:id/cancel` instead of only stopping
our tail. Cancellation is a user decision, never an error: the stream settles
`turn.cancelled` → `session.waiting` and the run must land `canceled`, not
`failed` — and not `succeeded`, which is where an unhandled `session.waiting`
would classify it (that would also settle the run's Slack delivery obligation
and post a truncated partial reply). The session stays usable afterwards.

**Context controls.** `POST /sessions/:id/{clear,compact,reset}` front the
matching eve control routes (DTOs: `sessionContextControlResponseSchema`,
`resetSessionResponseSchema` in `packages/shared/src/api.ts`). Success is
keyed on the body's `status`, not the HTTP code. An accepted `clear` emits
`context.cleared` → `session.waiting`; an accepted `compact` emits
`compaction.requested` → `compaction.completed` → `session.waiting`, except
that a missing `compaction.completed` means summarization was skipped and
history was PRESERVED (not an error) and compacting an empty/already-cleared
context emits no `compaction.*` events at all — the 202 is the only reliable
acknowledgement (REPORT finding 24). `reset` is destructive: the eve id is
retired permanently, so the platform closes the row and mints a NEW
`agent_sessions` row that the client must switch to.

DISPATCH-TIME MODEL ALLOWLIST RE-VALIDATION (spec §7): before running, the
dispatcher re-checks the version's COMPILED model against the CURRENT workspace
allowlist; a now-disallowed model FAILS the run (a visible failed run, never
executed) rather than dispatching. This is the ONLY thing dispatch reads from
the live model layer — the model and its reasoning effort come from the
version's baked artifact, never from `model_presets` (see "Compiler seam").

## Outbound reply delivery (control-plane DeliveryService)

Slack replies are posted by the control plane, never by the agent
(`runs/delivery.ts` — the compiled Slack channel + `SLACK_BOT_TOKEN` agent-env
injection are gone):

- dispatch marks slack-origin runs `delivery_status = pending` (born owing a
  reply);
- the run tailer's finished-hook posts the run's final assistant reply
  (`message.completed` with `finishReason: "stop"`) as a threaded
  `chat.postMessage` with the team's decrypted bot token, then settles the
  marker (`delivered` / `failed` with a reason);
- paths that mark a run terminal OUTSIDE the tailer hook (`failDispatch`, the
  dispatch-time allowlist failure, cancel of an untailed run, the sweeper's
  no-eve-session fail) call `deliver()` themselves, so the marker settles at
  the moment of failure instead of lingering `pending`;
- boot recovery (`reconcileInterruptedRuns` → `recoverPending`) finds
  TERMINAL runs stuck `pending`: succeeded ones (crash between terminal event
  and post) recover the reply from persisted `run_events` and deliver late;
  failed/canceled ones settle the ledger.

Semantics are **at-least-once** (documented residual): the Slack post happens
before the marker flips, so a crash in between re-delivers on recovery. The
marker itself is CAS'd (only `pending` settles), so racing settlers resolve to
one ledger write and a second `deliver()` is a no-op. Failed/canceled runs owe
no reply — their marker settles `failed` so the sweep never reconsiders them.
Bot tokens are decrypted in-process at delivery time and never logged.
`SLACK_API_BASE_URL` (non-production stubs) now applies to the control plane's
own Slack client only.

## Schedule ticker (control-plane cron)

Compiled schedule codegen is gone — it only ever fired under `eve start`,
which workers never run (spike finding 6). Scheduling is a platform concern
(`runtime/schedule-ticker.ts`):

- workflow publish syncs the trigger row's `cron` + `next_fire_at`;
- every `SCHEDULE_TICK_MS` (default 30 s) the ticker scans for DUE triggers
  (`next_fire_at <= now`, trigger enabled, workflow enabled + published);
- each due trigger is CLAIMED in its own transaction under a per-trigger
  `pg_advisory_xact_lock`: re-read + re-check, then advance `next_fire_at`
  from NOW (**no backfill** — a control plane down over three windows fires
  ONCE, then resumes cadence) BEFORE dispatching. The advisory lock makes
  claims safe under concurrent tickers;
- the dispatch is the ordinary workflow dispatch (origin/trigger type
  `schedule`, `data.scheduledFor` = the window that fired, empty message —
  the instructions carry the task). Scheduled runs are ordinary sessions and
  can park on HITL approvals;
- a dispatch failure never un-advances the cursor (one failed run per window,
  never a hot loop); an unparseable cron clears `next_fire_at`, disarming the
  trigger until the next publish rewrites it.

## World isolation (design correction #10)

Contract: one world **Postgres database per agent version**, named
`ag_v_<first 12 hash chars>`, provisioned + bootstrapped on the first build of
a version (`src/build/world.ts`).

### ⚠️ Single writer per version hash (cross-WORKER constraint)

Database-per-version isolates VERSIONS from each other, but it does NOT make
it safe to run TWO agent processes of the SAME hash against one
`ag_v_<hash12>` database. Verified against `@workflow/world-postgres`
@5.0.0-beta.20:

- run-replay mutual exclusion is an in-process Map (`inflightWorkflowRuns` in
  its queue) — per PROCESS, not per database;
- `reenqueueActiveRuns` (recovery) enqueues graphile jobs with **no
  idempotencyKey and no graphile queueName**, so every boot of a second agent
  process creates DUPLICATE jobs for runs actively executing on the first —
  two pollers then replay the same run concurrently (non-memoized model calls
  and side-effecting tool calls execute twice; the run event log races).

Re-confirmed at `@workflow/world-postgres` @5.0.0-beta.32 (the eve 0.31.3
pin): it now passes a *namespace* into `reenqueueActiveRuns`, but
`@workflow/world` @5.0.0-beta.25 only uses it to prefix the QUEUE TOPIC — the
`runs.list({status})` scan behind it is still unfiltered, so the re-enqueue
still crosses agents sharing a world DB. Upstream has NOT fixed this; the
database-per-version isolation below remains required (REPORT finding 26).

**Hard constraint: at most one live agent process per version hash,
fleet-wide.** Note the agents-first pivot CONCENTRATES load on this
constraint: all of an agent's chat sessions AND all workflows delegating to
it ride its one published version hash — one world DB, one writer. The
platform enforces it operationally:

- the scheduler prefers the warm worker for a hash (affinity → warm → cold),
  and in-flight placement RESERVATIONS (runtime/scheduler.ts) keep a burst of
  cold placements from double-booting one hash;
- graceful drain flips the worker to `draining` FIRST (immediate heartbeat
  with `draining: true`), so no new placement lands on it while its agents
  finish;
- dead-worker FENCING: a worker whose heartbeat lapses is marked `dead`; its
  next heartbeat is answered **404 `worker_fenced`** and the worker STOPS ALL
  LOCAL AGENTS before re-registering (apps/worker registration `onFenced`) —
  a false-dead worker can therefore never keep executing a hash the sweeper
  already resumed elsewhere.

The residual race (fenced worker's agents live until its next heartbeat,
≤ ~10 s, while the sweeper boots the hash elsewhere) is accepted for now;
closing it fully needs jobKey/queueName support in the world factory (tracked
as the (b) fallback in PLAN correction 10).

Why a database and not a `search_path` schema: `@workflow/world-postgres`
@5.0.0-beta.20 hardcodes `pgSchema('workflow')` in its drizzle schema, so all
queries are schema-qualified and `search_path` cannot redirect them — a
per-version schema would LOOK isolated while every version still shared
`workflow.*` (the exact cross-agent re-enqueue bug from REPORT finding 11).
`packages/compiler/WORLD-ISOLATION.md` documents the same contract
(`ag_v_<hash12>` everywhere) and its gated test proves both halves live.

## Artifacts

- Key: `artifacts/<contentHash>.tar.gz` in the S3 bucket (`S3_BUCKET`,
  default `artifacts`).
- Contents: `.output/` (self-contained nitro server), `manifest.json`
  (`{contentHash, builtAt, appRoot, entry}`), and eve's compiled-agent
  manifest when present — which **eve 0.31 moved** from
  `<project>/.eve/compile/compiled-agent-manifest.json` to
  `.output/.eve/compile/compiled-agent-manifest.json`, with no fallback copy
  at the old path (REPORT finding 22). **No
  node_modules** — if the supervisor runs the `eve start` CLI instead of
  `node .output/server/index.mjs`, widen the tarball at integrate time.
- NOT path-relocatable (REPORT finding 13): extract to the exact
  `manifest.json.appRoot` = `<AGENT_BUILD_ROOT>/<contentHash>`;
  `AGENT_BUILD_ROOT` must be identical on build and worker hosts.

## Compiler seam

The control plane resolves preset→model and validates the model allowlist
BEFORE compiling (typed 422s), then calls an injected
`compile({definition, model, connections, skills, workspaceSlug,
agentSlug}) → {files, hash, compilerVersion, eveVersion}` where `definition`
is a pure `AgentDefinition` — no trigger, no instructions
(`src/build/compiler-contract.ts`). The production implementation is
`src/build/compiler-adapter.ts` over `@invisible-string/compiler` (wired as
the default in `createAppStack`); tests inject stubs.

**`model` is `{provider, modelId, reasoning}` — the REASONING EFFORT is
resolved here too, and it is not optional at this seam.**
`definition.model.reasoning` is an agent-level *override*; `undefined` means
inherit, and `runtime/model-resolution.ts` settles it in the same pass that
settles the model:

| Branch | Model | Effort |
|---|---|---|
| specific-model override (`model.modelId` set) | the override, provider from its allowlist row | `model.reasoning ?? "provider-default"` — never the preset's, and the preset is not even read |
| preset (`model.preset`) | the workspace's preset mapping | `model.reasoning ?? presetRow.reasoning` |

`compile()` hashes `deps.resolvedModel`, so the effort re-keys the artifact,
the world database `ag_v_<hash12>`, and the platform-JWT audience: **two
identical definitions inheriting different preset efforts get different
artifacts**, by design.

Consequences at DISPATCH: dispatch never re-reads `model_presets`. It runs the
model and effort **baked into the published version** (and re-validates only
that model against the current allowlist, below). **Re-pointing a preset — its
model or its effort — is therefore inert until each agent is published again**;
the same republish-to-migrate pattern as an eve or `COMPILER_VERSION` bump.
Settings → Models says so on the panel. Design:
`docs/superpowers/specs/2026-08-08-reasoning-effort-and-model-defaults.md`.

## Control-plane runtime env

`WORLD_DATABASE_URL`, `PLATFORM_JWT_SECRET`, `WORKER_SHARED_SECRET`,
`S3_ENDPOINT`/`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` (+ optional
`S3_BUCKET`, `S3_REGION`) enable the runtime API; optional:
`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_BASE_URL`,
`MAX_RUN_WALL_CLOCK_MS` (default 600000), `MAX_CONCURRENT_RUNS_PER_WORKSPACE`
(default 5), `WORKER_HEARTBEAT_TTL_MS` (default 30000), `NPM_CACHE_DIR`,
`AGENT_BUILD_ROOT` (default `/var/lib/agents`), `SSE_HEARTBEAT_MS`,
`SCHEDULER_MAX_AGENTS_PER_WORKER` (default 20), `WORKER_SWEEP_INTERVAL_MS`
(default = the heartbeat TTL), `WORKER_AUTH_MODE` (`shared-secret` default |
`worker-token`), `LOG_LEVEL` (debug|info|warn|error, default info),
`TRIGGER_RATE_LIMIT_PER_TOKEN_PER_MIN` (default 60),
`TRIGGER_RATE_LIMIT_PER_IP_PER_MIN` (default 120), `SCHEDULE_TICK_MS`
(default 30000 — the schedule ticker's scan cadence), and the Slack app
(`SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `SLACK_SIGNING_SECRET`,
`SLACK_APP_REDIRECT_URL`, optional `SLACK_API_BASE_URL`).

## Phase-3 additions — scheduler pool, failover, per-worker identity

**Scheduler (`runtime/scheduler.ts`).** `selectWorker(db, {versionHash,
affinityWorkerId?, heartbeatTtlMs, defaultMaxAgents})` picks in order:
session **affinity** (the sticky worker while live and able to host it) →
artifact-**warm** (a live worker already running the hash, from
`workers.capacity.runningHashes`) → any **live** worker with agent headroom
(`runningAgents < maxAgents`, per-worker cap ~20). Exhaustion is a typed 503:
`no_live_worker` (none live) or `no_capacity` (all full).

**Worker capacity report.** Register + every heartbeat now carry
`capacity = {maxAgents, runningAgents, activeRequests, runningHashes}`. The
scheduler reads `runningHashes` for the warm preference; `maxAgents` for the
per-worker cap.

**Liveness state machine + failover.** `workers.status` is
`live | draining | dead`. A control-plane sweeper (`runtime/worker-sweeper.ts`,
started at boot, interval `WORKER_SWEEP_INTERVAL_MS`) marks heartbeat-stale
`live`/`draining` workers `dead`, then for every non-terminal run stranded on a
dead worker: a PARKED (`waiting`) run has its session affinity **cleared** so
the user's approval reschedules elsewhere; a RUNNING run is **re-tailed** on a
freshly scheduled worker (`RunTailerManager.detach` stops the stale tail without
failing the run; the durable eve turn continues on the new worker); a run whose
session never got an eve session is failed (compare-and-swap: run terminal
statuses are STICKY — `RunStore.markRun` refuses to overwrite
succeeded/failed/canceled, so a sweeper decision and a late dispatch tail can
never resurrect each other's outcome). Graceful drain: the worker's `SIGTERM`
handler FIRST sends a heartbeat with `draining: true` (→ `workers.status =
'draining'`; the scheduler only picks `live`, so new work stops routing at
t≈0), then finishes/parks in-flight requests, stops its agents, and
`deregister`s (→ `dead`).

**Fencing (zombie-dead workers).** A heartbeat for a row already marked `dead`
is answered **404 `worker_fenced`** — never a silent 200. The worker reacts by
stopping ALL local agents (its runs may already be failed over) and
re-registering as a fresh epoch. A heartbeat 401/403 (expired per-worker
session token after a control-plane outage) likewise demotes the worker to
re-register with the bootstrap secret instead of retrying a dead credential
forever.

**Per-worker identity (`WORKER_AUTH_MODE=worker-token`; deferred from Phase 1).**
The bootstrap `x-worker-secret` authenticates ONLY the first `register`. In
`worker-token` mode the control plane then mints a short-lived per-worker HS256
**session token** (returned in the register response, rotated on each heartbeat
response) which the worker re-presents via `x-worker-token` + `x-worker-id` on
heartbeat/deregister; and a per-call **dispatch token** (`x-dispatch-token`,
audience `worker:<id>`, unique single-use `jti` — the worker keeps a replay
cache for the token TTL) on ensure-agent, verified by the worker. In
worker-token mode the dispatch token is the ONLY credential the control plane
sends on ensure (the bootstrap secret is NOT sent alongside — it would hand the
fleet-master secret to every worker on every call), and a worker configured
`worker-token` REJECTS the bootstrap secret on its inbound plane. Both secrets
are derived from the bootstrap secret + worker id (`packages/shared`
`worker-token-crypto.ts`), so no PKI is needed and a token captured for one
worker is useless against another. `shared-secret` mode (default) keeps the
Phase-1 single-credential behaviour.

**Registration allowlist.** `WORKER_ALLOWED_IDS` (comma-separated worker
UUIDs) on the control plane restricts which worker identities may register —
without it, a leaked bootstrap secret suffices to register a rogue worker URL
that would receive secret-bearing dispatches. Set it in any deployment where
worker ids are provisioned out of band (production); leave unset only in local
dev/CI where ids are random per boot.

**Clock skew.** Dispatch tokens (60 s TTL) and platform JWTs (exp ≤ 120 s) are
minted on the control-plane clock and verified on the worker/agent host clock
with 30 s of allowance — worker hosts MUST run NTP (chrony/systemd-timesyncd);
a host >~30 s ahead rejects every dispatch.

## Worker env (Phase-3 additions)

`WORKER_AUTH_MODE` (`shared-secret` default | `worker-token`),
`SANDBOX_REAPER_ENABLED=1` (default off; needs a docker daemon),
`SANDBOX_IDLE_STOP_MS` (default 1800000 = 30 min), `SANDBOX_LABEL` (default
`eve.session`), `DOCKER_BIN` (default `docker`). The **sandbox reaper**
(`apps/worker/src/sandbox-reaper.ts`, design correction 4) enumerates docker
containers carrying the eve-session label and stops those idle past the window —
eve gives sandboxes no idle timeout of its own. IDLE means "no proxied
`/eve/v1/session/:id/*` activity for that session since max(container start,
last proxy call)" — the supervisor stamps per-session activity on every
proxied call and the reaper joins it to the container's session label, so a
sandbox in continuous use is never stopped mid-run (the StartedAt
approximation alone would have been a 30-min lifetime cap). The reaper's last
scan count feeds `sandboxCount` in `/internal/health` + `/internal/status`.
Artifact LRU (20 GB) never evicts a running hash (unchanged).

The worker also enforces `WORKER_MAX_AGENTS` itself: `ensure` for a NEW hash
answers 503 `no_capacity` when running + boot-in-flight agents are at the cap
(authoritative backstop under stale scheduler snapshots).

## Observability (docs/PLAN.md Phase 3 task 5)

**Structured logs.** Both planes emit one JSON object per line via the shared
core (`createStructuredLogger`, `packages/shared/src/observability.ts`) wrapped
by each app's `src/log.ts` sink. Every line carries `at`, `level`, `event`
(stable `<area>.<verb>` slug), an optional `msg`, the correlation ids it knows
(`workspaceId`/`workflowId`/`workflowVersionId`/`sessionId`/`runId`/`workerId`),
and a redaction-safe `fields` object. **Secrets discipline:** the logger runs a
mandatory redaction pass over `fields` — any secret-shaped key (`*token*`,
`*secret*`, `*apikey*`, `authorization`, `*credential*`, …) is replaced with
`[redacted]` at any nesting depth, and URL credentials (`scheme://user:pass@`)
are stripped from every string value. The worker routes its legacy
`log(message)` calls through `stringLogAdapter` so all internal lines are JSON.
Startup emits ONE `*.ready` line with the resolved (non-secret) config.

**Control-plane `GET /internal/metrics`** (guarded by the same timing-safe
`x-worker-secret` as the rest of `/internal/*`; NEVER public). Body is the
shared `InternalMetricsResponse`: `queueDepth`, `activeRuns`, `runsByStatus`,
`activeSessions`, a run-duration histogram (`runDuration`, bucket edges in ms),
`workers[]` fleet utilization (running/max agents, `utilization` = running/max),
per-trigger-type `triggers{received,dispatched,failed}`,
`deliveries{delivered,failed}` (outbound Slack replies),
`schedule{due,dispatched,failed}` (ticker mechanics), and
`buildCache{hits,misses,hitRate}`. In-memory counters (no Prometheus dep; reset
on restart), fed by the dispatch path (trigger counts), the DeliveryService,
the schedule ticker, the run tailer (durations), and publish (cache hits). `?format=text` (or `Accept: text/plain`)
returns a minimal Prometheus-style exposition (`is_*` metric names) instead of
JSON.

**Health.** Control-plane `GET /api/health` → `{ ok: true }` (liveness, no IO);
`GET /api/health?deep=1` runs a readiness probe over Postgres + object store +
a live worker and answers **503** with per-check detail when any dependency is
degraded (skipped checks — runtime unconfigured — never fail the probe). Worker
`GET /internal/health` (guarded) → `{ ok, ready, draining, runningAgents,
sandboxCount, at }`: a draining worker is alive (200) but `ready:false`.
Worker `GET /internal/status` gains a `metrics` block (`runningAgents`,
`sandboxCount`, `maxAgents`, `activeRequests`, `cacheBytes`, `cacheMaxBytes`).

**Lifecycle.** Both planes handle SIGTERM/SIGINT: the control plane stops
accepting connections, drains live NDJSON tailers, and closes the Postgres
pool; the worker first flags itself `draining` (immediate heartbeat), drains
in-flight proxied requests, stops its agents, then deregisters.

## Deployment constraints (hard)

- **Exactly ONE control-plane instance.** Run-tail dedupe
  (RunTailerManager), the dead-worker sweeper, boot reconcile, the SSE
  RunEventBus, scheduler placement reservations, webhook idempotency, the
  Slack event dedup, and OAuth nonce single-use are all in-process. A second
  replica would double-tail runs (the (run_id, seq) PK then crash-loops one
  tail), double-sweep failovers, and split SSE subscribers from their run's
  tail. (The schedule ticker alone IS multi-instance-safe — its claims ride
  per-trigger advisory locks — but nothing else is.) HA needs leader
  election / shared state first — do not scale this process horizontally.
- **`/internal/*` must not be internet-reachable.** The worker-plane surface
  (register/heartbeat/deregister, `/internal/metrics`) and the agent-facing
  token broker (`/internal/connections/token`, platform-JWT-authed — see its
  section above) are mounted on the same listener as the tenant API and
  guarded only by bearer credentials; restrict the prefix at the ingress/L7
  layer (or bind a separate interface) so a leaked secret alone cannot be
  exercised from the internet.
- **NTP on every host** (see clock-skew note above).
- **Per-IP rate limiting and proxies:** set `TRUST_PROXY_HOPS=<n>` to the
  number of reverse proxies in front of the control plane. With 0 (default)
  `X-Forwarded-For` is ignored and the socket peer address is used; with n>0
  the rightmost-untrusted XFF entry is used — never the attacker-controlled
  leftmost one.
