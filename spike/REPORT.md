# Phase-0 spike report — self-hosted eve runtime validation

Date: 2026-07-02 · eve **0.19.0** · Node **24.18.0** (mise) · Bun **1.3.5** (tests/proxy)

> This header and findings 1–20 are the original 0.19.0 record and are kept
> verbatim (later docs cite the numbers). The suite now runs against eve
> **0.31.3** — see **[appended findings 21–28](#appended-findings--eve-0313-upgrade-2026-08-07)**,
> which supersede the version matrix below plus findings 3 and 4.

## Verdict

**The runtime bet holds.** A hand-written eve agent self-hosts cleanly
(`eve build` + `PORT=4101 eve start --host 0.0.0.0`) with
`@workflow/world-postgres` durability behind a minimal reverse proxy, and the
Phase-0 durability gate — approval-parked session survives `SIGKILL` of the
runtime and resumes on a fresh process via `inputResponses` — **passed with a
verified server-PID change**. The world-postgres fallback decision gate
(switch to local worlds on persistent volumes) is **not needed**.

One design assumption is broken and needs a Phase-1 decision before the worker
pool: **`WORKFLOW_POSTGRES_JOB_PREFIX` does not isolate agents sharing one
world DB** (finding 11).

## Exact version matrix (see `packages/compiler/versions.json` for rationale)

| Package | Version | Why |
|---|---|---|
| eve | 0.19.0 | exact npm latest; engines node >=24; peer `ai@^7` |
| ai | 7.0.14 | resolves eve's `ai@^7` peer |
| @workflow/world-postgres | 5.0.0-beta.20 | its `@workflow/world@5.0.0-beta.14` dep exactly matches eve 0.19.0's vendored world |
| @openrouter/ai-sdk-provider | 6.0.0-alpha.1 | only line installable next to ai@7 (latest 2.10.0 peer-requires ai@^6 → ERESOLVE); spec-v3 models, accepted by ai@7; `createOpenRouter({apiKey})` → `openrouter('provider/slug')` |
| @ai-sdk/anthropic | 4.0.7 | latest; provider-spec v4, same line as ai@7 |
| zod | 4.4.3 | what the eve/ai tree resolves |
| node | 24.18.0 | `mise install node@24`; host Node 22 fails eve's engines check |

`spike/agent-project/package-lock.json` is committed (exact pins).

## What was proven (all scripted; `bun test spike/tests/`, gated on TEST_DATABASE_URL)

Keyless (`keyless.test.ts`, real model mode — model calls fail as expected):
- `eve build` succeeds with no provider key (model falls back to a gateway-id string).
- `eve start` serves `/eve/v1/health` through the proxy; proxy rejects non-forwarded paths.
- Route auth fails closed: unauthenticated `POST /eve/v1/session` → 401; wrong-secret JWT → 401; platform-JWT (HS256 `verifyJwtHmac`, `PLATFORM_JWT_SECRET`) → session created.
- 1-minute schedule registered in `.eve/compile/compiled-agent-manifest.json` AND actually fires under `eve start` (Nitro task runner; marker file written at the minute boundary).
- world bootstrap created `workflow_{runs,events,steps,hooks,stream_chunks,waits}` (in the `workflow` schema).
- Live NDJSON event shapes captured (incl. `step.failed`/`turn.failed` from the credential-less model call).

Keyless-mocked (`mocked.test.ts`, `EVE_MOCK_AUTHORED_MODELS=1` — everything real except the LLM):
- Full turn completes **through the proxy**, proving `/.well-known/workflow/v1/flow` callbacks flow through it (`WORKFLOW_LOCAL_BASE_URL` pointed at the proxy).
- NDJSON stream resumes with `?startIndex=` after disconnect without replaying consumed events.
- Custom channel `POST /dispatch` (JWT-checked via `routeAuth`) starts a session via `send()`; unauthenticated → 401.
- **DURABILITY GATE**: `record_note` (`approval: always()`) parks the session (`input.requested` with approve/deny options → `session.waiting`); `eve start` is SIGKILLed (CLI + server child; new server PID asserted); fresh process resumes via `inputResponses: [{requestId, optionId: "approve"}]`; `action.result` status `completed`; the tool's side effect lands on disk from the NEW process.
- Follow-up via `continuationToken` continues the same durable session (no new `session.started`).
- `docker()` sandbox executes `bash` and writes `/workspace/proof.txt` (image `ghcr.io/vercel/eve:latest`, 645 MB).

Keyed (`keyed.test.ts`, REAL inference on `deepseek/deepseek-v4-flash` via
OpenRouter — verified green 2026-07-03 with a live key; skips with "requires
OPENROUTER_API_KEY" otherwise):
- Full turn completes through the proxy (real model reply, `message.completed`).
- NDJSON `?startIndex=` resume after disconnect (no replayed head events).
- **DURABILITY GATE with a real model**: approval-gated `record_note` parks the
  session; `eve start` SIGKILLed; fresh process (new server PID) resumes via
  `inputResponses` and the tool's side effect lands on disk from the NEW
  process.
- Follow-up via `continuationToken` shares session memory (real "codeword"
  recall — semantic memory the mock cannot prove).
- Live MCP: the model calls a `deepwiki__*` tool over the DeepWiki connection
  (`actions.requested`/`action.result` status `completed`).
- `docker()` sandbox bash writes `/workspace/proof.txt` under a real model.
- Prerequisite discovered (finding 20): keyed `eve build` needs the agent-level
  `modelContextWindowTokens` escape hatch.

Event inventory frozen in `packages/shared/src/eve-events.ts` (14 types live-observed, 13 docs-derived; raw captures in `spike/tests/fixtures/*.ndjson`).

## Friction log (feed into compiler templates & worker supervisor)

1. **eve.dev docs return 500 for `.md` paths.** The npm package ships the full
   docs under `node_modules/eve/docs/` — use those as source of truth.
2. **eve does not declare `@workflow/*` as dependencies.** It vendors the
   compiled workflow runtime; the bundled versions are only readable from
   eve's `package.json` devDependencies (`@workflow/world@5.0.0-beta.14`,
   `core@beta.26`, `world-local@beta.22`). CI should re-derive the matrix from
   there on every eve bump.
3. **OpenRouter provider pairing is awkward**: npm `latest` (2.10.0)
   ERESOLVEs against ai@7; the working line is `6.0.0-alpha.1` (alpha
   dist-tag, no `ai` peer, spec-v3 models — ai@7's `LanguageModel` union
   accepts V2/V3/V4). Revisit when a stable major targets ai@7.
4. **`openrouter('slug')` throws `AI_LoadAPIKeyError` at model CONSTRUCTION**
   when the key is missing. Generated `agent.ts` must construct the provider
   model only when the key exists (spike falls back to a gateway-id string);
   otherwise keyless `eve build`/boot dies.
5. **`NODE_ENV=test` silently switches eve to a mock model**
   (`shouldMockAuthoredRuntimeModels()`: `NODE_ENV === "test" ||
   EVE_MOCK_AUTHORED_MODELS === "1"`). Bun test exports NODE_ENV=test, and it
   leaked into the spawned runtime — turns "succeeded" with `Bootstrap reply`
   text. Worker supervisor must pin `NODE_ENV=production` for agent
   processes. Upside: the mock is a superb CI harness — it honors
   "Reply with exactly: X" fixtures and calls authored tools by name with
   anchored inputs (`note: 'value'`, backtick commands for bash), which is how
   the durability gate runs keylessly.
6. **`eve start` spawns the HTTP server as a child process**
   (`node .output/server/index.mjs`). Signaling only the CLI orphans the
   listener (PPID 1, port still bound). Supervisors must kill the process
   group / track the listener PID (spike harness uses `lsof -ti tcp:<port>`).
7. **Custom channel routes mount at the RAW authored path** (verified in
   eve's compiler: `urlPath = route.path`, no channel prefix). A route like
   `POST /dispatch` is unreachable through a proxy that forwards only `/eve/`
   + `/.well-known/workflow/`. RESOLVED — locked convention: trigger channels
   are authored under `/eve/v1/platform/<trigger>` (rides the forwarded
   `/eve/` prefix; no proxy change). The spike channel now lives at `POST
   /eve/v1/platform/dispatch` and is exercised THROUGH the proxy in
   spike/tests/mocked.test.ts.
8. **world-postgres bootstrap**: `node_modules/.bin/bootstrap` (or `npx
   --package=@workflow/world-postgres bootstrap`), reads
   `WORKFLOW_POSTGRES_URL`. Tables land in the `workflow` schema (plus
   `workflow_drizzle` migrations and `graphile_worker`) — not `public`.
9. **`WORKFLOW_LOCAL_BASE_URL`** overrides the base URL the queue uses for
   run callbacks (`${base}/.well-known/workflow/v1/*`). Point it at the
   worker proxy so callbacks traverse the same ingress as clients; without
   forwarding that prefix, sessions start but runs stall forever (as the
   design warned).
10. **Boot re-enqueue is aggressive**: every `eve start` boot re-enqueues ALL
    `pending`/`running` runs found in the world storage
    (`[world-postgres] Re-enqueued N active run(s) on startup`). Restarting a
    crashed worker automatically re-drives parked/incomplete runs — that is
    the durability bet working — but see 11.
11. **CRITICAL — `WORKFLOW_POSTGRES_JOB_PREFIX` does not isolate agents.**
    `@workflow/world`'s `reenqueueActiveRuns` lists ALL active runs with no
    prefix filter and re-enqueues them under the booting process's own
    prefix, so agent A's boot re-drives agent B's runs into A's queue
    (observed across spike suites sharing one world DB). The design's
    "shared world DB isolated by job prefix" assumption is unsafe for the
    worker pool. Phase-1 options: (a) one world **database** (or search_path
    schema) per workflow version, (b) patch/wrap the world factory to filter
    re-enqueue by prefix, (c) accept single-shared-world per worker process
    set where all agents are identical. Decide before Phase 3 multi-agent
    workers.
12. **Restart self-DoS window**: after boot, graphile-worker processes
    re-enqueued jobs before the HTTP listener binds, so first callback
    attempts fail (`attempt 1 of 3`) and retry. Harmless with retries; keep
    proxy/ingress returning 5xx (not hanging) so retries stay cheap.
13. **Build artifacts are not path-relocatable**: absolute `appRoot` paths
    are baked into `.output/server/index.mjs`,
    `_virtual/eve.schedule.mjs`, and `_libs/eve.mjs`. Workers must extract
    artifact tarballs to the SAME canonical path used at build time (e.g.
    build in `/var/lib/agents/<hash>` inside the build container), or Phase 1
    must verify which references are load-bearing.
14. **Approval parks close the turn**: the park emits `turn.completed` then
    `session.waiting`; the resume runs as a new turn (`turn_1`). Run
    bookkeeping (runs-per-message) must expect turn boundaries at parks.
15. **graphile-worker tuning**: warns `maxPoolSize (10) < concurrency (50)`.
    Set `WORKFLOW_POSTGRES_MAX_POOL_SIZE` / `WORKFLOW_POSTGRES_WORKER_CONCURRENCY`
    per agent process (design's ~20 agents/worker multiplies pools — budget
    Postgres connections).
16. **`localDev()` accepts loopback traffic** — fine in dev, wrong behind a
    local proxy in production. The spike gates it with
    `SPIKE_DISABLE_LOCAL_DEV=1`; compiled production channels must omit it.
17. **Schedules**: registered in `.eve/compile/compiled-agent-manifest.json`
    (`schedules[]` with cron), fire under `eve start` only (Nitro tasks;
    `eve dev` never fires cron; dev-only dispatch route
    `/eve/v1/dev/schedules/:id` is not mounted in production builds).
    Handler-form schedules (`run()`) need no model call — good for platform
    heartbeats.
18. **MCP**: `defineMcpClientConnection` to the public no-auth DeepWiki
    server (`https://mcp.deepwiki.com/mcp`, verified reachable) compiles and
    boots; tool discovery is lazy (no build-time dial-out). Live MCP tool
    calls remain key-blocked.
19. **npm blocked postinstall scripts** (`@openrouter/sdk` check-types,
    `cbor-extract` native build) under this environment's allow-scripts
    policy; both packages work without them (cbor-x falls back to pure JS).
20. **CRITICAL — model ROUTING is baked into the artifact at `eve build`
    time** (observed empirically under the real key, 2026-07-03). The
    compiled manifest records `config.model.routing` from whatever
    `resolveModel()` returned DURING BUILD:
    - key present at build → provider MODEL OBJECT → `{kind:"external",
      provider:"openrouter"}` + a `source` module reference; runtime turns go
      to OpenRouter. But eve derives the gateway id
      `openrouter/<slug>`, which the AI Gateway model catalog cannot resolve,
      so the build FAILS ("does not have known AI Gateway context window
      metadata") unless the agent config sets the documented
      `modelContextWindowTokens` escape hatch (the spike agent now does:
      1,000,000, the catalog value for `deepseek/deepseek-v4-flash`).
    - key absent at build → gateway-id STRING → `{kind:"gateway"}`, no
      module source; the runtime then calls the Vercel AI Gateway even when
      OPENROUTER_API_KEY IS present at runtime (every turn fails instantly
      with `step.failed`). Exporting the key to `eve start` does NOT rescue a
      keyless build.
    **Phase-1+ implication (product bug)**: the build service scrubs
    OPENROUTER_API_KEY (apps/control-plane/src/build/steps.ts allowlist)
    while the runtime provides it (runtime/agent-env.ts) — so
    compiler-generated agents are built keyless, bake gateway routing, and
    can never reach OpenRouter in production. Masked so far because both
    acceptance suites set EVE_MOCK_AUTHORED_MODELS=1. Fix options: make the
    generated agent.ts always construct the provider model (placeholder key
    at build) + emit `modelContextWindowTokens`, or pass the (or any) key to
    `eve build`, or override routing at runtime. Decide before first real
    keyed deployment.
    **RESOLVED in the product (2026-07-03)**: the eve-build step now sets a
    public placeholder OPENROUTER_API_KEY (steps.ts — bakes external routing;
    placeholder never reaches the artifact), the compiler emits
    `modelContextWindowTokens` verbatim (codegen/agent.ts, COMPILER_VERSION
    2.2.0), and a BUILD_ENV_EPOCH (steps.ts) participates in the content hash
    via the compiler adapter so build-env changes like this one can never
    cache-hit stale (gateway-routed) artifacts again. Verified end-to-end by
    tests/integration/keyed-acceptance.test.ts under a real key.

---

## Appended findings — eve 0.31.3 upgrade (2026-08-07)

Findings 1–20 above are the 0.19.0 record and are **not rewritten** (later docs
cite them by number). The items below are numbered continuations; where one
supersedes an earlier statement it says so explicitly. Design:
`docs/superpowers/specs/2026-08-07-eve-0.31-upgrade-design.md`. All of these
were produced by the ported spike suites running green against a real
eve 0.31.3 install (28 pass / 8 skip — the keyed suite skipped, no key).

21. **SUPERSEDES findings 3 and 4 — `@openrouter/ai-sdk-provider@3.0.0`: a
    stable `ai@7` line exists, and key loading is now LAZY.** Finding 3's
    "the working line is `6.0.0-alpha.1`" no longer holds: 3.0.0 is npm latest,
    declares peer `ai@^7.0.0`, installs with zero ERESOLVE and has no runtime
    deps. It preserves the `createOpenRouter({apiKey})` → `openrouter('slug')`
    call style our codegen emits, and moves `specificationVersion` v3 → v4
    (ai@7.0.58 drives it; a real `generateText()` round-trip against a stubbed
    endpoint completed). Finding 4 is now WRONG on its central claim:
    **`openrouter('slug')` no longer throws `AI_LoadAPIKeyError` at model
    CONSTRUCTION** — construction succeeds and the error is raised lazily at
    the first model call (`doGenerate`/`doStream`). Consequence: the codegen
    guard (construct the provider model only when `OPENROUTER_API_KEY` is set,
    otherwise emit the model-id STRING) is **more** load-bearing than under
    0.19, not less — dropping it would no longer fail the build, it would
    silently emit a model whose first turn fails at runtime. Proven end-to-end:
    a cold keyless build's manifest records
    `"routing":{"kind":"gateway","target":"deepseek"}` — the fallback branch —
    and that artifact then booted, served, streamed, parked, resumed after
    SIGKILL, cancelled a turn and ran the docker sandbox. Unproven and
    deliberately left open: the KEYED round-trip against real OpenRouter under
    3.0.0 (the keyed lane costs money and was not run); because the throw is
    lazy, a keyed-path break would surface only at the first turn.

22. **The compiled-agent manifest MOVED.** eve 0.31 emits it at
    `.output/.eve/compile/compiled-agent-manifest.json`; the 0.19 path
    `<project>/.eve/compile/compiled-agent-manifest.json` is simply ABSENT
    after a cold build (asserted in both directions in `keyless.test.ts`).
    `<project>/.eve/` now holds `agent-summary.json` (schemaVersion 3),
    `builds/<id>/`, `locks/`, `sandbox-cache/`. This supersedes the manifest
    paths quoted in the keyless proof list above and in finding 17 — schedule
    registration still lands in the manifest, just at the new location. Any
    reader of that file (build steps, artifact packaging, tests) must use the
    new path; there is no fallback copy.

23. **Session API v2 is ID-addressed — supersedes every "follow-up via
    `continuationToken`" statement above** (the keyless-mocked and keyed proof
    lists). Create answers **202** `{ok, sessionId, status:"accepted"}` with an
    `x-eve-session-id` header and **no continuation token**; follow-ups POST to
    `/eve/v1/session/:sessionId` with `message` **XOR** `inputResponses`
    (both → 400 "mutually exclusive", neither → 400, `inputResponses` on create
    → 400). An unknown or terminal id answers **409**
    `{ok:false, code:"session_not_active"}` — the only stable machine-readable
    code on this surface. Every session route (create, follow-up, cancel,
    clear, compact, reset) returns 400 if the body merely CONTAINS a
    `continuationToken` key: the guard is `"continuationToken" in body`, so
    `{continuationToken: null}` fails too (both directions asserted in
    `keyless.test.ts`). The durability gate was re-proven on this protocol —
    approval park → SIGKILL → fresh PID → resume by posting `{inputResponses}`
    alone to the session id, with the tool's on-disk side effect landing from
    the new process.

24. **Control routes: `cancel` / `clear` / `compact` / `reset`, and what their
    statuses actually mean.** All four accept a zero-byte POST body. Traps,
    all observed:
    - `no_active_turn` (cancel) and `no_active_session` (clear/compact/reset)
      do **not** mean "nothing was running". eve renders ONE condition — a dead
      session command hook — as `session_not_active` (send), `no_active_turn`
      and `no_active_session`. A cancel against a live-but-IDLE session answers
      **202 `accepted`**, so 202 never proves a turn was stopped and 200 is the
      same terminal condition a send reports as 409.
    - **Cancellation is cooperative at durable step boundaries.** A tool call
      in flight when the cancel lands runs to completion and still emits its
      `action.result`; the turn then ends with `turn.cancelled` INSTEAD of
      `turn.completed`, and `turn.cancelled` → `session.waiting` is the
      terminal pair (`turn.failed`/`session.failed` are absent — cancellation
      is a user decision, not an error). The session takes the next message
      normally. Capture: `spike/tests/fixtures/mocked-cancelled-events.ndjson`.
    - A cancel posted BEFORE `turn.started` is accepted (202) and consumed as a
      no-op; it does not arm a pending cancellation.
    - **Compacting an empty or already-cleared context emits no `compaction.*`
      events at all** — just `session.waiting`. The documented
      `compaction.requested → compaction.completed → session.waiting` sequence
      is the non-empty case; the 202 is the only reliable acknowledgement.
    - `reset` is the only route that never returns 202 (both outcomes are 200)
      and its id field is `previousSessionId`. The retired id afterwards 409s
      `session_not_active` on send and degrades to
      `no_active_turn`/`no_active_session` on all four control routes.

25. **NDJSON stream is version 21, and every event carries `meta.id`.**
    `x-eve-stream-version: 21` (was 16). `meta.id` is an `evt_`-prefixed ULID
    (`/^evt_[0-9A-HJKMNP-TV-Z]{26}$/`), unique within a session and **identical
    across a full rewind to `startIndex=0`** — that stability is what a
    tailer's dedupe depends on, and it is asserted in `mocked.test.ts`. It is a
    dedupe KEY, not a cursor: ULIDs are time-ordered but not totally ordered
    across steps, and a retried durable step re-emits under NEW ids with the
    same `turnId`/`stepIndex`/`sequence`, so `startIndex` stays authoritative.
    Also new/changed on the wire: `turn.cancelled`, `context.cleared` and
    `action.partial` event types; `input.requested` gained a REQUIRED `kind`
    discriminator (`tool-approval` | `question` | `session-limit` — the parked
    approval capture shows `"kind":"tool-approval"`); `session.waiting.data`
    still carries a `continuationToken`, but it is literally the session id
    echoed back for compatibility and is never accepted on any request — do not
    resurrect token persistence from it. `?startIndex=` resume is unchanged and
    now also accepts negative (tail-relative) values plus `includeTailIndex=1`,
    which adds an `x-eve-stream-tail-index` response header (`-1` on an empty
    stream) for bounded catch-up reads. Read from the shipped serializer (not
    yet exercised by a spike assertion): the response body opens with a bare LF
    before the first event, so a line splitter must skip empty lines and must
    not count them toward its cursor. Fresh 0.31.3 captures replace the 0.19
    ones in `spike/tests/fixtures/*.ndjson`; every event in them carries
    `meta.id` and every capture reports `eveVersion 0.31.3`.

26. **Finding 11 STILL HOLDS at `@workflow/world-postgres@5.0.0-beta.32` —
    upstream has NOT fixed it.** beta.32 now passes a *namespace* into
    `@workflow/world`'s `reenqueueActiveRuns`, which looks like the fix, but
    `@workflow/world@5.0.0-beta.25`'s `dist/recovery.js` only uses that
    namespace to prefix the QUEUE TOPIC — the `runs.list({status})` scan behind
    it remains unfiltered, so a booting agent still re-enqueues ALL active runs
    found in the world database. One world **database** per agent version
    (`ag_v_<hash12>`) is still required, and `WORKFLOW_POSTGRES_JOB_PREFIX`
    still does not isolate. (`WORKFLOW_QUEUE_NAMESPACE` is new in this line and
    unused by the platform — it is the topic prefix, not an isolation
    boundary.) This cross-references finding 11; that finding is unchanged.

27. **SUPERSEDES the version-matrix table at the top of this report.** That
    table is the frozen 0.19.0 record. The live matrix is
    `packages/compiler/versions.json` (with rationale in its `notes`): eve
    0.31.3 · ai 7.0.58 · `@workflow/world-postgres` 5.0.0-beta.32 (its
    `@workflow/*` deps — world beta.25, world-local beta.34, errors beta.16,
    utils beta.8 — match eve 0.31.3's bundled set exactly; the neighbours
    beta.30/.31 do not, so the pin is forced) · `@openrouter/ai-sdk-provider`
    3.0.0 · `@ai-sdk/anthropic` 4.0.36 · zod 4.4.3 · typescript 7.0.2 ·
    `@types/node` 26.1.0 · node 24.19.0. `spike/agent-project/package.json` is
    now GENERATED from that file (`spike/tests/sync-pins.ts`) and the drift is
    enforced by the ungated `spike/tests/pins.test.ts`, which runs in the
    default `bun test` lane — a repin is a regeneration, not a retype. Known
    and accepted: world-postgres declares `zod@~4.3.6` while the agent pins
    4.4.3, so npm installs a nested zod copy under
    `@workflow/world-postgres` — benign; do not "fix" it.

28. **Under `EVE_MOCK_AUTHORED_MODELS` the mock ignores prompted tool ARGUMENT
    values** and emits a stock schema-satisfying one (observed: `seconds: 1`
    regardless of the message). Raising a zod `min` above that stock value
    makes the mock's tool call fail validation, after which the model silently
    answers in prose and the tool is never called — the test then times out
    with a misleading message. Spike tools therefore keep wide schema bounds
    and enforce floors inside `execute()` (see `agent/tools/slow_task.ts`,
    added so a turn can be held open long enough to cancel one in flight —
    every other mocked flow settles in ~200 ms, and an approval park emits
    `turn.completed`, so a parked session has no active turn to cancel).

## How to run

```sh
mise install node@24
POSTGRES_PORT=5443 docker compose -p p0spike up -d postgres   # tests also do this on demand
TEST_DATABASE_URL=postgres://dev:dev@localhost:5443/product bun test spike/tests/
# keyed suite additionally needs OPENROUTER_API_KEY
docker compose -p p0spike down                                 # teardown
```

The suite bootstraps the world DB, truncates stale workflow state, runs
`eve build`, starts `eve start` (Node 24) behind `spike/proxy.ts` (:4100 →
:4101, forwarding only `/eve/` and `/.well-known/workflow/`), and tears the
processes down. Logs and captured NDJSON land in `spike/.artifacts/`
(gitignored); committed captures live in `spike/tests/fixtures/`.
