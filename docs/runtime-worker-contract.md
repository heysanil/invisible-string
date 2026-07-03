# Runtime ⇄ worker / compiler contract (Phase 1)

Written by the control-plane runtime build (apps/control-plane). The worker
supervisor and compiler were built in parallel — reconcile against this at the
Integrate stage. Code anchors are marked `NOTE(integration)` in source.

## Worker HTTP surface the control plane calls

### Internal plane (shared secret)

```
POST <worker>/internal/agents/<contentHash>/ensure
authorization: Bearer <WORKER_SHARED_SECRET>
{ "artifactUrl": "<presigned GET url of artifacts/<hash>.tar.gz>",
  "env": { ...full agent process env, secrets included... } }
→ 200 once the agent for <contentHash> is running & healthy (idempotent)
```

- `env` is spawn-time-only material. The supervisor must never write it to
  disk or logs, and must additionally pin `NODE_ENV=production` on the agent
  process (spike/REPORT.md finding 5 — bun/vitest NODE_ENV leaks flip eve
  into mock-model mode).
- Client: `apps/control-plane/src/runtime/worker-client.ts` (createWorkerClient).

### Agent proxy plane (platform JWT)

```
<worker>/agents/<contentHash>/eve/v1/*            → agent's eve routes
<worker>/agents/<contentHash>/.well-known/workflow/* → run callbacks
```

Both prefixes MUST be forwarded (PLAN correction 10). Calls carry
`authorization: Bearer <HS256 JWT>` minted per call with
`iss=invisible-string`, `aud=workflow-agent`, exp ≤ 120 s
(`src/runtime/jwt.ts`); compiled channels verify via eve's `verifyJwtHmac`
against `PLATFORM_JWT_SECRET`.

Used today by the control plane:

- `POST .../eve/v1/session` `{message}` → **202** `{sessionId, continuationToken}`
- `POST .../eve/v1/session/:id` `{continuationToken, message}` → 202
- `GET  .../eve/v1/session/:id/stream?startIndex=<n>` → NDJSON

## Env injected per agent (ensure-agent `env`)

| Var | Value |
|---|---|
| `WORKFLOW_POSTGRES_URL` | the version's **dedicated world database** (below) |
| `WORKFLOW_POSTGRES_JOB_PREFIX` | contentHash — observability ONLY, does not isolate |
| `PLATFORM_JWT_SECRET` | channel-auth secret |
| `OPENROUTER_API_KEY` **or** `ANTHROPIC_API_KEY` | exactly ONE, matching the version's resolved provider (`workflow_versions.model_provider`) |
| `OPENROUTER_BASE_URL` | passthrough when set (test harnesses) |
| `MCP_<NAME>_TOKEN` | decrypted MCP connection tokens; `<NAME>` = connection name upper-snaked (`src/runtime/agent-env.ts` `mcpTokenEnvName`) — compiler-emitted `connections/*.ts` must read the same names |

The supervisor adds `PORT` and `WORKFLOW_LOCAL_BASE_URL` (its own proxy
address for `<worker>/agents/<hash>`) itself.

## World isolation (design correction #10)

Contract: one world **Postgres database per workflow version**, named
`ws_v_<first 12 hash chars>`, provisioned + bootstrapped on the first build of
a version (`src/build/world.ts`).

Why a database and not a `search_path` schema: `@workflow/world-postgres`
@5.0.0-beta.20 hardcodes `pgSchema('workflow')` in its drizzle schema, so all
queries are schema-qualified and `search_path` cannot redirect them — a
per-version schema would LOOK isolated while every version still shared
`workflow.*` (the exact cross-agent re-enqueue bug from REPORT finding 11).
If packages/compiler's WORLD-ISOLATION.md lands with a different mechanism,
reconcile in `src/build/world.ts` (naming + provisioning are the only touch
points).

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
`compile({definition, model, connections, skills}) → {files, hash,
compilerVersion, eveVersion}` (`src/build/compiler-contract.ts`). Until the
real compiler is wired in `createAppStack` (src/index.ts), the default
placeholder fails publish with a typed `compile_failed` error.

## Control-plane runtime env

`WORLD_DATABASE_URL`, `PLATFORM_JWT_SECRET`, `WORKER_SHARED_SECRET`,
`S3_ENDPOINT`/`S3_ACCESS_KEY_ID`/`S3_SECRET_ACCESS_KEY` (+ optional
`S3_BUCKET`, `S3_REGION`) enable the runtime API; optional:
`OPENROUTER_API_KEY`, `ANTHROPIC_API_KEY`, `OPENROUTER_BASE_URL`,
`MAX_RUN_WALL_CLOCK_MS` (default 600000), `MAX_CONCURRENT_RUNS_PER_WORKSPACE`
(default 5), `WORKER_HEARTBEAT_TTL_MS` (default 30000), `NPM_CACHE_DIR`,
`AGENT_BUILD_ROOT` (default `/var/lib/agents`), `SSE_HEARTBEAT_MS`.
