# invisible-string

A cloud-hosted agent workflow platform — "Claude Code / Cowork in the cloud."
Users assemble **workflows** from four pillars (TRIGGER · CONTEXT · AGENT ·
INSTRUCTIONS) in a chat-centric web UI; each workflow compiles to a
self-hosted [eve](https://eve.dev) agent that runs on a stateless worker pool
with Postgres-backed durability, fired from chat or external triggers
(webhook · form · Slack). Multi-tenant via Better Auth organizations, with an
AI copilot in the builder. See `INITIAL-SPEC.md` (build brief) and
`docs/PLAN.md` (master implementation plan).

## Quickstart

Requires [Bun](https://bun.sh) 1.3+, Docker, and Node 24 (for eve agents;
`mise install node@24`).

```sh
bun install
bun run typecheck
bun test                                  # unit lane (DB-gated tests skip without TEST_DATABASE_URL)
```

Integration lane (full suite against the local stack):

```sh
docker compose up -d postgres minio dex   # local stack: Postgres, MinIO, Dex IdP

# apply migrations (Better Auth + product tables live in packages/db)
DATABASE_URL=postgres://dev:dev@localhost:5432/product bun run --cwd packages/db migrate

# full suite: db + control-plane integration tests and the eve spike suites
# (the spike reuses the same Postgres server's `world` DB and installs/builds
# its agent project with Node 24 on first run)
TEST_DATABASE_URL=postgres://dev:dev@localhost:5432/product bun test
```

The spike's keyed tests (real model calls) additionally require
`OPENROUTER_API_KEY` and skip cleanly without it. Tear down with
`docker compose down`.

Copy `.env.example` to `.env` and fill in secrets before running the apps.

## Web app

The SPA (`apps/web`, Vite + React + TanStack Router) is the whole product
surface, built on the E1 design system (`src/styles/tokens.css` +
`src/components/ui`). Four sections:

- **Chat** (`/chat`) — start a session with a published workflow and watch its
  runs stream live (working blocks, streamed reply, inline HITL approvals).
  Resumable SSE per run with `Last-Event-ID`; one active run per session
  (`session_busy` handled inline). "Edit workflow ↗" deep-links into the
  builder.
- **Workflows** (`/workflows`, `/workflows/:id`) — the hybrid builder: a
  pillar rail (TRIGGER · CONTEXT · AGENT · INSTRUCTIONS) with focused editors,
  `@`-reference autocomplete in the instructions (CodeMirror 6), debounced
  autosave → dry-run compile with diagnostics routed onto the pillar cards,
  and Publish / Run-draft (Run draft publishes then opens a new chat via
  `/chat?workflow=<id>`).
- **Context** (`/context`) — MCP connections (workspace + personal), the MCP
  registry browser + install (write-once encrypted secrets), and skills
  authoring with drag-drop attachments (packaged into the compiled agent —
  no more publish-time 422).
- **Settings** (`/settings`) — model presets, provider/model allowlist, agent
  presets, members (Better Auth organization roles), workspace rename, and
  **Integrations** (connect the platform Slack app, per-team bot tokens).

Run it against a live control plane:

```sh
# terminal 1 — API host
bun run --cwd apps/control-plane dev
# terminal 2 — SPA (reads VITE_API_URL, default http://localhost:3000)
bun run --cwd apps/web dev
```

Design/E2E preview without a backend: `VITE_FIXTURE_MODE=1 bun run --cwd
apps/web dev` renders the chat surface from canned fixtures.

Screenshots of each section live in `docs/screenshots/` (see the placeholder
there).

## Repo map

```
apps/
  control-plane/   Bun + Elysia API host: auth, CRUD, compiler invocation,
                   eve build + artifact upload, affinity/warm scheduler with
                   dead-worker failover, trigger ingress (webhook/form/Slack)
                   + dispatcher, SSE, /internal/metrics + deep health
  worker/          Stateless worker: supervisor (eve start per agent), reverse
                   proxy, idle + sandbox reapers, per-worker token identity
  web/             Vite + React SPA (chat, builder, settings + integrations)
packages/
  compiler/        Pure WorkflowDefinition -> eve project codegen
  db/              Drizzle schema, migrations, seeds (product DB)
  shared/          TriggerEvent, pillar schemas, eve event types, API contracts
infra/             docker-compose init scripts + Dex IdP config
docs/              Design spec + master plan (+ screenshots/)
.github/           CI (typecheck + unit tests + web build; gated integration)
```
