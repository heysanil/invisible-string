<div align="center">

# 🪢 invisible-string

**A multi-tenant cloud platform for agent workflows — assemble, compile, run.**

Describe a workflow in four pillars, and it compiles into a self-hosted
[eve](https://eve.dev) agent running on a durable, Postgres-backed worker pool —
fired from chat, webhooks, forms, or Slack.

[![CI](https://github.com/heysanil/invisible-string/actions/workflows/ci.yml/badge.svg)](https://github.com/heysanil/invisible-string/actions/workflows/ci.yml)
![Runtime: Bun 1.3+](https://img.shields.io/badge/runtime-Bun%201.3%2B-14151a?logo=bun&logoColor=white)
![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)
![eve 0.19.0](https://img.shields.io/badge/eve-0.19.0-6e56cf)
![Agents on Node 24](https://img.shields.io/badge/agents-Node%2024-5fa04e?logo=node.js&logoColor=white)

[Quickstart](#quickstart) · [How it works](#how-it-works) · [Product tour](#product-tour) · [Copilot](#copilot-the-builder-assistant) · [Development](#development) · [Docs](#documentation)

</div>

---

## What is this?

**invisible-string** is "Claude Code / Cowork in the cloud": a chat-centric web
app where users assemble **workflows** from four pillars —

<div align="center">

| ⚡ TRIGGER | 📚 CONTEXT | 🤖 AGENT | 📝 INSTRUCTIONS |
|:---:|:---:|:---:|:---:|
| chat, webhook, form, or Slack event that fires the run | MCP connections & skills the agent can reach | model preset + agent preset | the prompt, with `@`-references into context |

</div>

— and every published workflow **compiles to a real, self-hosted
[eve](https://eve.dev) agent** (`packages/compiler` → `eve build` → tarball in
object storage). Compiled agents run on a stateless worker pool with
Postgres-backed durability (`@workflow/world-postgres`), so runs survive worker
death and stream back to the browser over resumable SSE. Multi-tenancy rides on
Better Auth organizations (email/password + OIDC SSO), and an AI copilot lives
inside the builder.

## How it works

```mermaid
flowchart LR
    subgraph ingress [" Triggers "]
        T1([webhook /t/:token])
        T2([form])
        T3([Slack events])
    end

    WEB["apps/web<br/>glass SPA"] <-->|REST · SSE · WS| CP
    ingress --> CP

    CP["apps/control-plane<br/>Bun + Elysia"]
    CP -->|"compile → eve build"| GARAGE[("Garage<br/>artifact store")]
    CP -->|ensure + dispatch| WK

    subgraph pool [" Stateless worker pool "]
        WK["apps/worker<br/>supervisor + proxy"] --> AG["compiled eve agent<br/>Node 24"]
    end

    CP --- PG[("product<br/>Postgres")]
    AG --- WPG[("world Postgres<br/>one DB per version")]
```

- **Control plane** (`apps/control-plane`) — auth & orgs, pillar CRUD, compiler
  invocation + `eve build` + artifact upload (cache keyed by content hash),
  scheduler (session affinity → artifact-warm → any live worker, with
  dead-worker sweep + fencing), trigger ingress → dispatcher (version-bound
  JWTs), NDJSON tailer → resumable SSE, and the copilot WebSocket tool loop.
- **Worker** (`apps/worker`) — a stateless Bun supervisor that pulls artifacts,
  boots each compiled agent under Node 24, reverse-proxies traffic to it, and
  reaps idle processes, idle sandboxes, and cold artifacts.
- **Compiler** (`packages/compiler`) — pure `WorkflowDefinition` → eve project
  codegen, golden-digest-guarded and versioned (`COMPILER_VERSION`).
- **Durability** — each workflow version gets its own world Postgres database
  (`ws_v_<hash12>`) with a single writer enforced by fencing, so a mid-run
  worker crash resumes instead of corrupting.

The full control-plane ↔ worker protocol lives in
[`docs/runtime-worker-contract.md`](docs/runtime-worker-contract.md).

## Quickstart

**Prerequisites:** [Bun](https://bun.sh) 1.3+, Docker, and Node 24 for eve
agents (`mise install node@24` — harnesses invoke it themselves).

```sh
bun install
bun run typecheck
bun test            # unit lane — DB-gated tests skip cleanly without TEST_DATABASE_URL
```

### Run the full stack

```sh
bun run dev
```

One command: bootstraps `.env` on first run (generates the four platform
secrets; provider keys stay blank until you add them), starts Postgres, Garage,
and Dex and waits for health, applies migrations, then runs the API (:3000),
worker, and SPA (:5173) with prefixed logs in one terminal. Ctrl-C stops the
apps and leaves infra running; `bun run dev:down` stops the containers.

<details>
<summary>Manual, step-by-step equivalent (for debugging individual pieces)</summary>

```sh
# local infra: Postgres, Garage, Dex IdP
docker compose up -d postgres garage dex

# apply migrations (Better Auth + product tables live in packages/db)
DATABASE_URL=postgres://dev:dev@localhost:5432/product bun run --cwd packages/db migrate

# secrets for running the apps (tests provision their own env)
cp .env.example .env    # then fill in values
# a hand-built .env also needs the dev-only vars `bun run dev`'s bootstrap
# would add: uncomment ALLOW_INSECURE_WORKER_TRANSPORT, and set
# ARTIFACT_CACHE_DIR/AGENT_BUILD_ROOT to the same writable dir (see comments
# in .env.example)

# terminal 1 — API host (:3000)
bun run --cwd apps/control-plane dev
# terminal 2 — SPA (:5173, reads VITE_API_URL)
bun run --cwd apps/web dev
# terminal 3 — worker
bun run --cwd apps/worker dev
```

</details>

### Integration tests

```sh
# full suite: db + control-plane integration tests and the eve spike suites
# (the spike reuses the same Postgres server's `world` DB and installs/builds
# its agent project with Node 24 on first run)
TEST_DATABASE_URL=postgres://dev:dev@localhost:5432/product bun test
```

The spike's keyed tests (real model calls) additionally require
`OPENROUTER_API_KEY` and skip cleanly without it. Tear down with
`docker compose down`.

## Product tour

The SPA (`apps/web`, Vite + React + TanStack Router) is the whole product
surface, built on the **E1 design system** — monochrome ink × liquid glass,
color only as meaning (`src/styles/tokens.css` + `src/components/ui`). Four
sections:

### 💬 Chat — `/chat`
Start a session with a published workflow and watch its runs stream live:
working blocks, streamed reply, inline human-in-the-loop approvals. Resumable
SSE per run with `Last-Event-ID`; one active run per session (`session_busy`
handled inline). "Edit workflow ↗" deep-links into the builder.

![Chat surface](docs/screenshots/chat.png)

### 🛠 Workflows — `/workflows`, `/workflows/:id`
The hybrid builder: a pillar rail (TRIGGER · CONTEXT · AGENT · INSTRUCTIONS)
with focused editors, `@`-reference autocomplete in the instructions
(CodeMirror 6), debounced autosave → dry-run compile with diagnostics routed
onto the pillar cards, and Publish / Run-draft (Run draft publishes then opens
a new chat via `/chat?workflow=<id>`).

![Workflow builder](docs/screenshots/builder.png)

### 🔌 Context — `/context`
MCP connections (workspace + personal), the MCP registry browser + install
(write-once encrypted secrets), and skills authoring with drag-drop
attachments — packaged straight into the compiled agent.

![Context section](docs/screenshots/context.png)

### ⚙️ Settings — `/settings`
Model presets, provider/model allowlist, agent presets, members (Better Auth
organization roles), workspace rename, and **Integrations** (connect the
platform Slack app, per-team bot tokens).

![Settings — model presets](docs/screenshots/settings.png)

All screenshots are captured from the real product by a gated Playwright spec
— regenerate them with one command (see [`docs/screenshots/`](docs/screenshots/)).

## Copilot (the builder assistant)

The builder's docked right rail is an AI copilot: it reads the current draft
definition plus the workspace inventory (MCP connections, skills, agent
presets, model presets, allowlist) and proposes edits as **typed mutations** —
`setTrigger`, `addContext`, `removeContext`, `setAgent`, `setModelPreset`,
`setInstructions` — streamed over `WS /workspaces/:workspaceId/copilot`
(shared frame protocol in `packages/shared/src/copilot.ts`).

![Builder copilot — suggestion cards with inline diff preview](docs/screenshots/copilot.png)

Every proposal renders as a structured **Apply / Dismiss** card with a preview
(inline diff for instructions, before→after otherwise). The server **never**
mutates the draft — accepted mutations are applied client-side through the
builder controller (the same reducer manual edits use, so
autosave/dry-run/diagnostics just work), and each accept/reject is fed back
into the model's tool loop. Invalid tool calls (unknown ids, non-allowlisted
models, dangling `@references`) bounce back to the model server-side and never
reach the UI.

The copilot runs a Claude model via **OpenRouter on the platform key**
(`COPILOT_PROVIDER=openrouter`, default model `anthropic/claude-sonnet-5`); a
direct-Anthropic path exists but stays inactive without `ANTHROPIC_API_KEY`.
The socket is only mounted when a provider key (or the scripted test fake) is
available — keyless boots simply run without `/copilot`.

Config knobs (all optional):

| Variable | Default | Purpose |
|---|---|---|
| `COPILOT_MODEL` | `anthropic/claude-sonnet-5` | model slug |
| `COPILOT_PROVIDER` | `openrouter` | `openrouter` or `anthropic` |
| `COPILOT_MAX_SESSIONS` | `2` | per-workspace concurrent session cap |
| `COPILOT_MAX_OUTPUT_TOKENS` | `8192` | per-turn budget |
| `COPILOT_MAX_STEPS` | `12` | tool-loop round-trip cap |
| `COPILOT_FAKE_SCRIPT` | — | deterministic scripted LLM for tests |

Unit and integration suites use the scripted fake; the single real-model smoke
is gated behind `COPILOT_KEYED=1` + `OPENROUTER_API_KEY`.

## Development

Everything you need to work in this repo — commands, conventions, constraints,
and the empirically-learned eve gotchas — lives in **[`AGENTS.md`](AGENTS.md)**
(`CLAUDE.md` symlinks to it). The short version:

| Lane | Command |
|---|---|
| Unit | `bun test` |
| Typecheck | `bun run typecheck` |
| DB-gated integration | `TEST_DATABASE_URL=… bun test` |
| Real `eve build` fixtures | add `SPIKE_EVE_BUILD=1` |
| Phase acceptance suites | see [`AGENTS.md`](AGENTS.md#test-lanes-run-the-ones-your-change-touches) |
| Browser E2E | `cd e2e && bunx playwright test` |

CI runs typecheck + unit + web build, the gated integration lane (including
the eve spike), both acceptance suites, and Playwright E2E. Keyed lanes (real
model calls) are deliberately not in CI.

## Deploy

Production runs as one single-host Docker Compose stack (`docker-compose.prod.yml`)
— `web` (nginx SPA + same-origin API gateway) fronts `control-plane`, `worker`,
`postgres`, and `garage` on a private bridge, with GHCR images pinned by
`IMAGE_TAG`. Full runbook (Dokploy, external/managed data services, Cloudflare
Tunnel, backups, upgrades, smoke checklist): **[`docs/DEPLOY.md`](docs/DEPLOY.md)**.

## Repo map

```
apps/
  control-plane/   Bun + Elysia API host: auth, CRUD, compiler invocation,
                   eve build + artifact upload, affinity/warm scheduler with
                   dead-worker failover, trigger ingress (webhook/form/Slack)
                   + dispatcher, SSE, /internal/metrics + deep health
  worker/          Stateless worker: supervisor (boots compiled agents under
                   Node 24), reverse proxy, idle + sandbox reapers,
                   per-worker token identity
  web/             Vite + React SPA (chat, builder, context, settings)
packages/
  compiler/        Pure WorkflowDefinition -> eve project codegen
  db/              Drizzle schema, migrations, seeds (product DB)
  shared/          TriggerEvent, pillar schemas, eve event types, API contracts
spike/             Standalone eve testbed — empirical findings in REPORT.md
e2e/               Playwright browser harness (self-manages its stack)
infra/             docker-compose init scripts + Dex IdP config
docs/              Design spec, master plan, runtime contract (+ screenshots/)
.github/           CI: unit · integration · acceptance · phase3 · e2e
```

## Documentation

| Document | What it covers |
|---|---|
| [`AGENTS.md`](AGENTS.md) | Operational contract: commands, test lanes, conventions, constraints |
| [`docs/PLAN.md`](docs/PLAN.md) | Master phase plan |
| [`docs/runtime-worker-contract.md`](docs/runtime-worker-contract.md) | Control-plane ↔ worker protocol |
| [`packages/compiler/README.md`](packages/compiler/README.md) | Codegen contract & versioning discipline |
| [`spike/REPORT.md`](spike/REPORT.md) | Empirical eve findings (numbered, cited by later docs) |
| [`packages/compiler/versions.json`](packages/compiler/versions.json) | Pinned runtime version matrix + rationale |
| [`.env.example`](.env.example) | Canonical inventory of every environment variable |
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | Production deployment guide (prod compose, Dokploy, external data, backups, upgrades) |

---

<div align="center">

Built with [Bun](https://bun.sh) · [Elysia](https://elysiajs.com) · [eve](https://eve.dev) · [Drizzle](https://orm.drizzle.team) · [Better Auth](https://better-auth.com) · [Vite](https://vite.dev) + [React](https://react.dev)

</div>
