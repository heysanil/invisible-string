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

## Copilot (builder assistant)

The builder's docked right rail is an AI copilot (spec §12): it reads the
current draft definition plus the workspace inventory (MCP connections,
skills, agent presets, model presets, allowlist) and proposes edits as
**typed mutations** — `setTrigger`, `addContext`, `removeContext`,
`setAgent`, `setModelPreset`, `setInstructions` — streamed over
`WS /workspaces/:workspaceId/copilot` (shared frame protocol in
`packages/shared/src/copilot.ts`). Every proposal renders as a structured
Apply/Dismiss card with a preview (inline diff for instructions,
before→after otherwise); the server **never** mutates the draft — accepted
mutations are applied client-side through the builder controller (the same
reducer manual edits use, so autosave/dry-run/diagnostics just work), and
each accept/reject is fed back into the model's tool loop. Invalid tool
calls (unknown ids, non-allowlisted models, dangling `@references`) bounce
back to the model server-side and never reach the UI.

The copilot runs a Claude model via **OpenRouter on the platform key**
(`COPILOT_PROVIDER=openrouter`, default model `anthropic/claude-sonnet-5`);
a direct-Anthropic path exists but stays inactive without
`ANTHROPIC_API_KEY`. The socket is only mounted when a provider key (or the
scripted test fake) is available — keyless boots simply run without
`/copilot`. Config knobs (all optional): `COPILOT_MODEL`,
`COPILOT_PROVIDER`, `COPILOT_MAX_SESSIONS` (per-workspace cap, default 2),
`COPILOT_MAX_OUTPUT_TOKENS` (per-turn budget, default 8192),
`COPILOT_MAX_STEPS` (tool-loop round-trip cap, default 12), and
`COPILOT_FAKE_SCRIPT` (deterministic scripted LLM for tests). Unit and
integration suites use the scripted fake; the single real-model smoke is
gated behind `COPILOT_KEYED=1` + `OPENROUTER_API_KEY`.

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

Working in this repo (commands, test lanes, conventions, constraints):
see **`AGENTS.md`** (`CLAUDE.md` symlinks to it). Keep it — and every doc it
lists — up to date with your changes.
