# Phase-0 spike report — self-hosted eve runtime validation

Date: 2026-07-02 · eve **0.19.0** · Node **24.18.0** (mise) · Bun **1.3.5** (tests/proxy)

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
