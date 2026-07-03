# invisible-string

A cloud-hosted agent workflow platform — "Claude Code / Cowork in the cloud."
Users assemble **workflows** from four pillars (TRIGGER · CONTEXT · AGENT ·
INSTRUCTIONS) in a chat-centric web UI; each workflow compiles to a
self-hosted [eve](https://eve.dev) agent that runs on a stateless worker pool
with Postgres-backed durability. Multi-tenant via Better Auth organizations,
with an AI copilot in the builder. See `INITIAL-SPEC.md` (build brief) and
`docs/PLAN.md` (master implementation plan).

## Quickstart

Requires [Bun](https://bun.sh) 1.3+, Docker, and Node 24 (for eve agents;
`mise install node@24`).

```sh
docker compose up -d postgres minio dex   # local stack: Postgres, MinIO, Dex IdP
bun install
bun test                                  # unit tests (DB-gated tests skip without TEST_DATABASE_URL)
bun run typecheck
```

Copy `.env.example` to `.env` and fill in secrets before running the apps.

## Repo map

```
apps/
  control-plane/   Bun + Elysia API host: auth, CRUD, compiler invocation,
                   eve build + artifact upload, scheduler, dispatcher, SSE
  worker/          Stateless worker: supervisor (eve start per agent),
                   reverse proxy, idle reapers
  web/             Vite + React SPA (chat, builder, settings)
packages/
  compiler/        Pure WorkflowDefinition -> eve project codegen
  db/              Drizzle schema, migrations, seeds (product DB)
  shared/          TriggerEvent, pillar schemas, eve event types, API contracts
infra/             docker-compose init scripts + Dex IdP config
docs/              Design spec + master plan
.github/           CI (typecheck + unit tests)
```
