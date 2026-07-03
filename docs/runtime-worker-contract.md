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
`AGENT_BUILD_ROOT` (default `/var/lib/agents`), `SSE_HEARTBEAT_MS`.
