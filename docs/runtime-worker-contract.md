# Runtime ⇄ worker / compiler contract (Phase 1)

Reconciled at the Integrate stage — this document describes what the code
actually does on BOTH sides (apps/control-plane ⇄ apps/worker ⇄
packages/compiler). The end-to-end proof is
`tests/integration/phase1-acceptance.test.ts`.

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
VERSION-BOUND contract: audience `workflow-agent:<contentHash>` and signing
secret `derivePlatformJwtSecret(PLATFORM_JWT_SECRET, contentHash)` — the
compiler bakes the matching audience into the generated verifier and the
agent env receives only the derived secret, so a leaked agent env or token
is useless against any other workflow version. Compiled channels verify via
eve's `verifyJwtHmac`.

Used today by the control plane:

- `POST .../eve/v1/session` `{message}` → **202** `{sessionId, continuationToken}`
- `POST .../eve/v1/session/:id` `{continuationToken, message}` → 202
- `POST .../eve/v1/session/:id` `{continuationToken, inputResponses:[{requestId,optionId?,text?}]}` → 202
  (HITL resume — `POST /runs/:id/input` forwards a parked run's answer here)
- `GET  .../eve/v1/session/:id/stream?startIndex=<n>` → NDJSON

## Env injected per agent (ensure-agent `env`)

| Var | Value |
|---|---|
| `WORKFLOW_POSTGRES_URL` | the version's **dedicated world database** (below) |
| `WORKFLOW_POSTGRES_JOB_PREFIX` | contentHash — observability ONLY, does not isolate |
| `WORKFLOW_POSTGRES_MAX_POOL_SIZE` / `WORKFLOW_POSTGRES_WORKER_CONCURRENCY` | per-agent connection budget (defaults 5/5 — REPORT finding 15) |
| `PLATFORM_JWT_SECRET` | channel-auth secret, **derived per version** (`derivePlatformJwtSecret(master, contentHash)`) — never the platform master |
| `OPENROUTER_API_KEY` **or** `ANTHROPIC_API_KEY` | exactly ONE, matching the version's resolved provider (`workflow_versions.model_provider`) |
| `OPENROUTER_BASE_URL` | passthrough when set (test harnesses) |
| `MCP_<NAME>_TOKEN` | decrypted MCP connection tokens; `<NAME>` = connection name upper-snaked (`src/runtime/agent-env.ts` `mcpTokenEnvName`). The compiler-emitted `connections/*.ts` reads `MCP_<SLUG>_TOKEN` (`connectionTokenEnvVar(slugifyName(name))`) — the adapter (`src/build/compiler-adapter.ts`) asserts both sides agree at compile time |
| `EVE_MOCK_AUTHORED_MODELS` | TEST HARNESS ONLY passthrough (set on the control plane → forwarded per agent); eve serves turns with its built-in mock model |
| `SLACK_BOT_TOKEN` | Slack-triggered versions ONLY: the team's decrypted bot token, injected by the dispatcher at ensure-agent time so the compiled Slack channel (`agent/lib/slack.ts`) can post the terminal reply via `chat.postMessage`. Never baked into generated code. |
| `SLACK_API_BASE_URL` | Slack-triggered versions in non-production deployments: redirects the agent's outbound Slack calls at a stub (`SLACK_API_BASE_URL` on the control plane, forwarded only when non-default). |

## Phase-3 trigger ingress (control-plane public surface)

Trigger ingress lives on the control plane, not the worker. Public endpoints
authenticate by token/signature (no session):

- `POST /t/:token` — webhook + form ingress. The `:token` (plaintext, shown
  ONCE at mint) is SHA-256-hashed and matched against `triggers.token_hash`
  (constant-time indexed lookup; plaintext is never stored). Per-token +
  per-IP rate limits and a 256 KiB payload cap run BEFORE parsing. → 202
  `{accepted, runId, sessionId}`; the dispatcher POSTs a `TriggerEvent` to the
  compiled agent's `/eve/v1/platform/<trigger>` channel.
- `POST /integrations/slack/events` — Slack Events API. Missing auth headers,
  per-IP rate limit, and a 256 KiB body cap are checked BEFORE the HMAC;
  signature (`v0` HMAC) + 5-min replay window next; `event_id` dedup makes
  Slack retries idempotent; a `message` twin of an `app_mention` (one channel
  mention arrives as BOTH, with different event_ids) is dropped by its leading
  bot-mention prefix; routed by `team_id` → integration → bound workflows;
  `thread_ts ↔ agent_session` continuation via the indexed
  `agent_sessions.slack_thread_key` column (partial unique per workflow — two
  racing first-messages of a new thread resolve to one session). DMs
  (`channel_type: im`) key the session on the IM channel itself, so a 1:1
  conversation keeps one ongoing session without threading.

**One run per eve session at a time (hole closed):** `waiting` (parked HITL)
counts as busy alongside queued/running — a new message into a parked session
is 409 `session_busy` ("answer the pending approval first"), and
`POST /runs/:id/input` refuses while any OTHER run of the session is
dispatching. Exactly one tail per eve NDJSON stream at any instant.
- `GET /integrations/slack/{install,callback}` — single platform Slack app
  OAuth; per-team bot token stored envelope-encrypted, keyed by `team_id`.

`POST /runs/:id/cancel` stops the tailer and marks the run `canceled`
(idempotent). Best-effort re: eve's turn — eve exposes no session-cancel HTTP
route, so the platform stops streaming and records the cancellation while eve's
own turn parks/caps out server-side.

DISPATCH-TIME MODEL ALLOWLIST RE-VALIDATION (spec §7): before running, the
dispatcher re-checks the version's COMPILED model against the CURRENT workspace
allowlist; a now-disallowed model FAILS the run (a visible failed run, never
executed) rather than dispatching.

The supervisor adds `PORT`, `NODE_ENV=production` (REPORT finding 5) and
`WORKFLOW_LOCAL_BASE_URL=${publicUrl}/agents/<hash>` (its own proxy base —
REPORT finding 9; caller env may override) itself, plus the ambient
PATH/HOME/LANG/TMPDIR. Worker registration:
`POST /internal/workers/{register,heartbeat,deregister}` on the control
plane, `x-worker-secret`-guarded (`src/runtime/workers.ts`).

## World isolation (design correction #10)

Contract: one world **Postgres database per workflow version**, named
`ws_v_<first 12 hash chars>`, provisioned + bootstrapped on the first build of
a version (`src/build/world.ts`).

### ⚠️ Single writer per version hash (cross-WORKER constraint)

Database-per-version isolates VERSIONS from each other, but it does NOT make
it safe to run TWO agent processes of the SAME hash against one
`ws_v_<hash12>` database. Verified against `@workflow/world-postgres`
@5.0.0-beta.20:

- run-replay mutual exclusion is an in-process Map (`inflightWorkflowRuns` in
  its queue) — per PROCESS, not per database;
- `reenqueueActiveRuns` (recovery) enqueues graphile jobs with **no
  idempotencyKey and no graphile queueName**, so every boot of a second agent
  process creates DUPLICATE jobs for runs actively executing on the first —
  two pollers then replay the same run concurrently (non-memoized model calls
  and side-effecting tool calls execute twice; the run event log races).

**Hard constraint: at most one live agent process per version hash,
fleet-wide.** The platform enforces it operationally:

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
`packages/compiler/WORLD-ISOLATION.md` documents the same contract (both
built to it independently; reconciled at Integrate — `ws_v_<hash12>`
everywhere) and its gated test proves both halves live.

## Artifacts

- Key: `artifacts/<contentHash>.tar.gz` in the S3 bucket (`S3_BUCKET`,
  default `artifacts`).
- Contents: `.output/` (self-contained nitro server), `manifest.json`
  (`{contentHash, builtAt, appRoot, entry}`), and
  `.eve/compile/compiled-agent-manifest.json` when present. **No
  node_modules** — if the supervisor runs the `eve start` CLI instead of
  `node .output/server/index.mjs`, widen the tarball at integrate time.
- NOT path-relocatable (REPORT finding 13): extract to the exact
  `manifest.json.appRoot` = `<AGENT_BUILD_ROOT>/<contentHash>`;
  `AGENT_BUILD_ROOT` must be identical on build and worker hosts.

## Compiler seam

The control plane resolves preset→model and validates the model allowlist
BEFORE compiling (typed 422s), then calls an injected
`compile({definition, model, connections, skills, workspaceSlug,
workflowSlug}) → {files, hash, compilerVersion, eveVersion}`
(`src/build/compiler-contract.ts`). The production implementation is
`src/build/compiler-adapter.ts` over `@invisible-string/compiler` (wired as
the default in `createAppStack`); tests inject stubs.

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
`TRIGGER_RATE_LIMIT_PER_IP_PER_MIN` (default 120), and the Slack app
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
per-trigger-type `triggers{received,dispatched,failed}`, and
`buildCache{hits,misses,hitRate}`. In-memory counters (no Prometheus dep; reset
on restart), fed by the dispatch path (trigger counts), the run tailer
(durations), and publish (cache hits). `?format=text` (or `Accept: text/plain`)
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
  tail. HA needs leader election / shared state first — do not scale this
  process horizontally.
- **`/internal/*` must not be internet-reachable.** The worker-plane surface
  (register/heartbeat/deregister, `/internal/metrics`) is mounted on the same
  listener as the tenant API and guarded only by worker credentials; restrict
  it at the ingress/L7 layer (or bind a separate interface) so a leaked
  secret alone cannot be exercised from the internet.
- **NTP on every host** (see clock-skew note above).
- **Per-IP rate limiting and proxies:** set `TRUST_PROXY_HOPS=<n>` to the
  number of reverse proxies in front of the control plane. With 0 (default)
  `X-Forwarded-For` is ignored and the socket peer address is used; with n>0
  the rightmost-untrusted XFF entry is used — never the attacker-controlled
  leftmost one.
