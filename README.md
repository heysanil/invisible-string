<div align="center">

# 🪢 invisible-string

**A multi-tenant cloud platform for AI agents — build, equip, delegate.**

Build an Agent — a persona, a model, and the tools it can use — and it compiles
into a self-hosted [eve](https://eve.dev) agent on a durable, Postgres-backed
worker pool. Chat with it directly, or delegate standing work with workflows
fired from webhooks, forms, Slack, or a schedule.

[![CI](https://github.com/heysanil/invisible-string/actions/workflows/ci.yml/badge.svg)](https://github.com/heysanil/invisible-string/actions/workflows/ci.yml)
![Runtime: Bun 1.3+](https://img.shields.io/badge/runtime-Bun%201.3%2B-14151a?logo=bun&logoColor=white)
![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-3178c6?logo=typescript&logoColor=white)
![eve 0.19.0](https://img.shields.io/badge/eve-0.19.0-6e56cf)
![Agents on Node 24](https://img.shields.io/badge/agents-Node%2024-5fa04e?logo=node.js&logoColor=white)

[Quickstart](#quickstart) · [How it works](#how-it-works) · [Product tour](#product-tour) · [Copilot](#copilot-the-editor-assistant) · [Development](#development) · [Docs](#documentation)

</div>

---

## What is this?

**invisible-string** is "Claude Code / Cowork in the cloud": a chat-centric web
app where you build **Agents** — a persona, a model, and the tools they can use — and put them to work.

**An Agent is a role you define:**

<div align="center">

| 🎭 PERSONA | 🧠 MODEL | 📚 CONTEXT |
|:---:|:---:|:---:|
| who it is and how it works | powerful / balanced / quick, within the workspace allowlist | the MCP connections & skills it's equipped with |

</div>

You **chat with Agents directly**. For standing work, delegate with a
**Workflow**:

<div align="center">

| ⚡ TRIGGER | → 🤖 AGENT → | 📝 INSTRUCTIONS |
|:---:|:---:|:---:|
| webhook, form, Slack event, or schedule | which Agent handles it | what to do when it fires, with `@trigger` references |

</div>

Every **published Agent** compiles to a real, self-hosted
[eve](https://eve.dev) agent (`packages/compiler` → `eve build` → tarball in
object storage). A workflow builds nothing of its own — when it fires, the
platform renders the trigger event *and its instructions* into the task
message for the bound agent version. Compiled agents run on a stateless worker
pool with Postgres-backed durability (`@workflow/world-postgres`), so runs
survive worker death and stream back to the browser over resumable SSE.
Multi-tenancy rides on Better Auth organizations (email/password + OIDC SSO),
and an AI copilot lives inside both editors.

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
    AG --- WPG[("world Postgres<br/>one DB per agent version")]
```

- **Control plane** (`apps/control-plane`) — auth & orgs, agent + workflow
  CRUD, compiler invocation + `eve build` + artifact upload (cache keyed by
  content hash), scheduler (session affinity → artifact-warm → any live
  worker, with dead-worker sweep + fencing), trigger ingress + schedule
  ticker → dispatcher (renders the workflow's instructions + trigger event
  into the task message and delivers it to the bound agent version over
  eve's session API, version-bound JWTs), outbound Slack reply delivery,
  NDJSON tailer → resumable SSE, and the copilot WebSocket tool loop.
- **Worker** (`apps/worker`) — a stateless Bun supervisor that pulls artifacts,
  boots each compiled agent under Node 24, reverse-proxies traffic to it, and
  reaps idle processes, idle sandboxes, and cold artifacts.
- **Compiler** (`packages/compiler`) — pure `AgentDefinition` → eve project
  codegen, golden-digest-guarded and versioned (`COMPILER_VERSION`).
- **Durability** — each agent version gets its own world Postgres database
  (`ag_v_<hash12>`) with a single writer enforced by fencing, so a mid-run
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
color only as meaning (`packages/design-tokens/tokens.css` + `src/components/ui`). Five
sections, in sidebar order:

**Onboarding:** a fresh account lands on a first-run screen to name its
workspace (creation seeds model presets, the model allowlist, and three
starter Agents via the org-creation hook — and auto-publishes "General
Purpose" in the background, so first chat needs no manual publish step).
Teammates join through invite links from Settings → Members
(`/accept-invitation/:id`) — signed-out recipients round-trip through
login/signup and land back on the invitation.

![First-run onboarding](docs/screenshots/onboarding.png)

### 💬 Chat — `/chat`
Pick a published Agent in the "New chat" picker and talk to it: working
blocks, streamed reply, inline human-in-the-loop approvals. Resumable SSE per
run with `Last-Event-ID`; one active run per session (`session_busy` handled
inline). Workflow-fired runs land here too, wearing origin +
workflow-provenance chips; "Edit agent ↗" deep-links into the agent editor.

![Chat surface](docs/screenshots/chat.png)

### 🤖 Agents — `/agents`, `/agents/:id`
Your agents at a glance. A card grid links into the agent editor — the
flagship surface: the persona document in a markdown editor, the Model
section (Powerful / Balanced / Quick preset, or a specific allowlisted model
plus reasoning effort), Context (equip MCP connections & skills, each with an
approval policy), and Access (which member's credentials it runs as) — with a
left rail of live section cards and lifecycle chips. **Publish** compiles the
Agent (the real `eve build` — Agents are the compile unit), and "Chat with
agent" drops you straight into `/chat`.

![Agent editor](docs/screenshots/agents.png)

### ⚡ Workflows — `/workflows`, `/workflows/:id`
Standing delegations: **trigger → Agent → instructions**. One focused column
with three sections — Trigger ("When this runs": webhook, form, Slack, or
schedule), Agent ("Who does the work": a published Agent), Instructions
("What they should do": CodeMirror with `@trigger.*` and the bound Agent's
`@skill.*` autocomplete). Publishing is **instant** — validate + snapshot, no
build (blocking diagnostics answer 422 and route onto the section cards) —
and the header's Run popover fires the published snapshot through the real
trigger-dispatch path.

![Workflow editor](docs/screenshots/workflow.png)

### 🔌 Context — `/context`
The library your Agents draw from: MCP connections (workspace + personal),
the MCP registry browser + install (write-once encrypted secrets), and skills
authoring with drag-drop attachments — equipped onto Agents in the agent
editor and packaged straight into the compiled agent.

![Context section](docs/screenshots/context.png)

### ⚙️ Settings — `/settings`
Model presets, provider/model allowlist, members (Better Auth organization
roles), workspace rename, and **Integrations** (connect the platform Slack
app, per-team bot tokens — app setup: [`docs/SLACK.md`](docs/SLACK.md)).

![Settings — model presets](docs/screenshots/settings.png)

All screenshots are captured from the real product by a gated Playwright spec
— regenerate them with one command (see [`docs/screenshots/`](docs/screenshots/)).

## Copilot (the editor assistant)

Both editors dock the same AI copilot on their right rail — one socket, two
surfaces. It reads the current draft (the Agent or the workflow) plus the
workspace inventory (published Agents, MCP connections, skills, model presets,
allowlist) and proposes edits as **typed mutations** — `setPersona`,
`setModel`, `addContext`, `removeContext` on the agent surface; `setTrigger`,
`setAgent`, `setInstructions` on the workflow surface — streamed over
`WS /workspaces/:workspaceId/copilot` (shared frame protocol in
`packages/shared/src/copilot.ts`; each turn names its surface).

![Copilot dock in the workflow editor — suggestion cards with inline diff preview](docs/screenshots/copilot.png)

Every proposal renders as a structured **Apply / Dismiss** card with a preview
(inline diff for instructions and persona, before→after otherwise). The server
**never** mutates the draft — accepted mutations are applied client-side
through the editor controller (the same reducer manual edits use, so
autosave/dry-run/diagnostics just work), and each accept/reject is fed back
into the model's tool loop. Invalid tool calls (unknown inventory ids,
non-allowlisted models, out-of-scope `@` references) bounce back to the model
server-side and never reach the UI.

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

CI runs typecheck + unit + web build + site build, the gated integration lane
(including the eve spike), both acceptance suites, Playwright E2E, and the
prod-compose publish smoke. Keyed lanes (real model calls) are deliberately
not in CI.

The marketing/docs site (`apps/site`) is standalone — no infra needed, run it
with `bun run --cwd apps/site dev`.

## Deploy

Production runs as one single-host Docker Compose stack (`docker-compose.prod.yml`)
— `web` (nginx SPA + same-origin API gateway) fronts `control-plane`, `worker`,
`postgres`, and `garage` on a private bridge, with GHCR images pinned by
`IMAGE_TAG`. Full runbook (Dokploy, external/managed data services, Cloudflare
Tunnel, backups, upgrades, smoke checklist): **[`docs/DEPLOY.md`](docs/DEPLOY.md)**.

The marketing/docs site (`apps/site`) deploys separately, to Cloudflare
Workers at [invisiblestring.io](https://invisiblestring.io), via
`.github/workflows/site.yml` — production on pushes to `main`, preview URLs
on pull requests.

## Repo map

```
apps/
  control-plane/   Bun + Elysia API host: auth, agent + workflow CRUD,
                   compiler invocation, eve build + artifact upload,
                   affinity/warm scheduler with dead-worker failover,
                   trigger ingress (webhook/form/Slack) + schedule ticker
                   + dispatcher, outbound Slack delivery, SSE,
                   /internal/metrics + deep health
  worker/          Stateless worker: supervisor (boots compiled agents under
                   Node 24), reverse proxy, idle + sandbox reapers,
                   per-worker token identity
  web/             Vite + React SPA (chat, agents, workflows, context, settings)
  site/            Standalone Vite + React landing + docs site (MDX docs,
                   E1 tokens), deployed to Cloudflare Workers — no server
packages/
  compiler/        Pure AgentDefinition -> eve project codegen
  db/              Drizzle schema, migrations, seeds (product DB)
  shared/          TriggerEvent, agent + workflow schemas, eve event types,
                   API contracts
  design-tokens/   Shared E1 tokens.css consumed by apps/web and apps/site
spike/             Standalone eve testbed — empirical findings in REPORT.md
e2e/               Playwright browser harness (self-manages its stack)
infra/             docker-compose init scripts + Dex IdP config
docs/              Design specs, master plan, runtime contract (+ screenshots/)
.github/           CI: unit · integration · acceptance · phase3 · e2e · prod-compose
```

## Documentation

| Document | What it covers |
|---|---|
| [`AGENTS.md`](AGENTS.md) | Operational contract: commands, test lanes, conventions, constraints |
| [`docs/superpowers/specs/2026-07-10-agents-first-redesign.md`](docs/superpowers/specs/2026-07-10-agents-first-redesign.md) | Agents-first redesign: concept model, IA, technical decisions, supersessions, vocabulary standard |
| [`docs/PLAN.md`](docs/PLAN.md) | Master phase plan |
| [`docs/runtime-worker-contract.md`](docs/runtime-worker-contract.md) | Control-plane ↔ worker protocol |
| [`packages/compiler/README.md`](packages/compiler/README.md) | Codegen contract & versioning discipline |
| [`spike/REPORT.md`](spike/REPORT.md) | Empirical eve findings (numbered, cited by later docs) |
| [`packages/compiler/versions.json`](packages/compiler/versions.json) | Pinned runtime version matrix + rationale |
| [`.env.example`](.env.example) | Canonical inventory of every environment variable |
| [`docs/DEPLOY.md`](docs/DEPLOY.md) | Production deployment guide (prod compose, Dokploy, external data, backups, upgrades) |
| [`apps/site/README.md`](apps/site/README.md) | Marketing/docs site: commands, Cloudflare Workers deploy, MDX authoring |

---

<div align="center">

Built with [Bun](https://bun.sh) · [Elysia](https://elysiajs.com) · [eve](https://eve.dev) · [Drizzle](https://orm.drizzle.team) · [Better Auth](https://better-auth.com) · [Vite](https://vite.dev) + [React](https://react.dev)

</div>
