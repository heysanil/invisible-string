# Build Prompt — Cloud Agent Workflow Platform (working name: **invisible-string**)

> This document is the brief you hand to Claude Code. It defines what to build, the
> architecture decisions already made, and a phased plan with acceptance criteria.
> Read the **eve documentation reading list** (§15) before writing code — eve is the
> agent runtime everything compiles down to, and its exact APIs are the source of truth.
> When an eve API detail in this brief and the live docs disagree, **the docs win** —
> note the discrepancy and use the documented API.

---

## 1. Mission

Build a cloud-hosted agent platform — "Claude Code / Cowork in the cloud." Users assemble
**workflows** in a chat-centric web UI. Each workflow is a configuration of four pillars:

1. **TRIGGER** — how the workflow starts (manual run, form, webhook, app integration e.g. Slack mention).
2. **CONTEXT** — which MCP servers and skills the agent can use.
3. **AGENT** — which agent persona/config runs (system prompt + model preset).
4. **INSTRUCTIONS** — the task prompt, with inline `@references` to trigger data and context.

A workflow **compiles to a self-hosted [eve](https://eve.dev) agent** and runs in the cloud.
Chat with a workflow is **multi-turn**: a chat thread maps to one durable eve session that
follow-up messages continue (§5). The platform is multi-tenant (workspaces + users) and ships
with an **AI copilot** that helps users build and edit workflows conversationally.

**Non-goals for v1:** billing/quotas as a product feature (safety caps only — §11), multi-step
DAG orchestration (a workflow is one agent, not a node graph), per-workspace BYOK provider
keys (the schema must leave room), mobile UI.

---

## 2. Locked decisions (do not relitigate)

| Decision | Choice |
|---|---|
| **Runner model** | **Compile-per-workflow on a scalable worker pool.** The **API host is the control plane**: it compiles each workflow version and runs `eve build`. **Stateless worker containers** each run *many* compiled agents concurrently (one `eve start` process per agent) and are scheduled by the control plane. |
| **First milestone** | **Full four-pillar scaffold** — data model + builder UI for all four pillars, with the compile→build→run loop working end to end. |
| **Backend** | **Bun + Elysia** (HTTP + WebSocket). |
| **Frontend** | **Vite + React** SPA. |
| **Auth** | **Better Auth** — email/password + **OIDC SSO** (generic, spec-compliant). Use its organization plugin for workspaces/memberships. CI validates SSO against a Dockerized test IdP (Dex or Keycloak); **Microsoft Entra ID** is the first production IdP target. |
| **Datastore** | **Postgres** (product data) + **`@workflow/world-postgres`** for eve durability. Object storage (S3-compatible) for build artifacts and trigger file payloads. |
| **Trigger path** | **Hybrid.** The control plane routes + authenticates inbound events and normalizes them into a `TriggerEvent`; the compiled agent's per-trigger **eve channel** receives that envelope, starts/continues the session, and **owns outbound delivery** (e.g. posting the Slack reply). See §8. |
| **Chat/session model** | **Multi-turn, sessions first-class.** A chat thread = one product `agent_session` = one eve session; follow-up messages continue it via eve continuations. |
| **Provider keys** | **Platform-owned** `ANTHROPIC_API_KEY` / `OPENROUTER_API_KEY` for v1, injected per agent process. No BYOK yet; don't preclude per-workspace keys later. |
| **User-scoped credentials** | **Run-as owner.** Every workflow has a `run_as` user (default: creator). Their user-scoped MCP connections are used for *all* trigger types. |
| **Sandbox topology** | **Mounted Docker socket** — workers mount the host dockerd socket; eve `docker()` sandbox containers run as siblings on **dedicated worker hosts**. Persistent volume(s) for agent `/workspace`; durability in the Postgres world (not worker-local disk). |
| **Artifact distribution** | **Object-store tarballs.** Control plane uploads the built `.output` as a tarball keyed by version hash; workers pull + extract on demand and cache locally (LRU). |
| **Model providers** | **Anthropic** (`@ai-sdk/anthropic`) + **OpenRouter** (`@openrouter/ai-sdk-provider`). |
| **Model presets** | Three workspace presets — **powerful / balanced / quick** — each mapping to a concrete model. **Seed defaults (via OpenRouter):** powerful → `z-ai/glm-5.2`, balanced → `deepseek/deepseek-v4-pro`, quick → `deepseek/deepseek-v4-flash`. Workspace-editable. Per-workspace **model allowlist**. Agent presets pick a preset, with optional specific-model-ID override. |
| **Slack integration** | **Single platform-level Slack app.** Workspaces install it via OAuth; inbound events route by Slack `team_id` + trigger bindings (§8). |
| **Worker tuning defaults** | Agent-process idle timeout **15 min**; sandbox idle eviction **30 min**; **~20** agent processes per worker; **20 GB** artifact cache per worker. All env-configurable. |
| **Context source** | MCP servers from the **official MCP registry** (`registry.modelcontextprotocol.io`) + a **custom server** escape hatch (URL + auth), at workspace and user scope. |
| **Skills** | **User-authored** markdown skills (workspace or user scope), editable in the UI, plus an optional seeded catalog. |
| **Copilot** | **In v1.** Runs on a platform-configured Claude model (platform key), independent of workspace presets/allowlist. |
| **Billing/quotas** | Deferred — but ship **safety caps** (§11): per-run wall-clock + turn limits, per-workspace concurrent-run cap. |

---

## 3. Why eve, and how the four pillars map to it

eve is a filesystem-first agent framework: an agent is a tree of files under `agent/` that
`eve build` compiles, and `eve start` serves as a normal Node HTTP service (Nitro output).
It already provides the hard parts — a durable, crash-safe session runtime that can pause for
human approval/OAuth and resume later, an isolated sandbox, MCP/OpenAPI connections with
secrets the model never sees, skills, and subagents. **We do not reimplement any of that.**
Our product is a GUI + a compiler that emits eve projects + an orchestrator that runs them.

> ⚠️ eve's happy path is Vercel deployment. We self-host (`eve build` + `eve start`). Validate
> self-hosted `eve start` + `@workflow/world-postgres` + `docker()` sandbox as a **Phase 0
> spike** before building anything on top (§13).

The mapping (this is the heart of the compiler):

| Pillar | eve primitive the compiler emits |
|---|---|
| **TRIGGER** | An eve **channel** under `agent/channels/*` per configured trigger type (or a **schedule** for time-based triggers). Compiled channels do **not** receive raw platform events — they receive the normalized `TriggerEvent` envelope (§8) from the control-plane dispatcher (authenticated via shared secret/JWT), then `send(message, { auth, continuationToken, state, context })` and **own outbound delivery** (e.g. the Slack thread reply). Manual/chat runs use the default eve HTTP channel directly. |
| **CONTEXT** | **Connections** under `agent/connections/*.ts` (`defineMcpClientConnection` from `eve/connections`) for MCP servers, plus **skills** under `agent/skills/*`. The compiler also translates each connection's tool allow/block list and **approval policy** into eve's tool-approval/HITL config — approvals are enforced by eve at runtime, not by our control plane. |
| **AGENT** | `agent/agent.ts` (`defineAgent` from `eve`: `model`, `reasoning`, `compaction`) + a base persona block in instructions. The `model` is resolved from the agent's model preset (§7). |
| **INSTRUCTIONS** | `agent/instructions.md`. Inline `@references` resolve to (a) literal text injected as the channel's `context: string[]`, or (b) trigger-data template variables resolved against `TriggerEvent.data` at dispatch time. |

The whole `agent/` tree → `eve build` → `.eve/` + `.output/` → `eve start` → a durable agent
reachable at `/eve/v1/*`. That running agent **is** one workflow.

---

## 4. System architecture

**Control plane (API host) + stateless worker pool.**

**A. Web app (Vite + React SPA).** Three surfaces:
- **Chat** — the primary interface. Start a session with a workflow, send follow-up messages,
  watch run streams live, answer human-in-the-loop prompts, browse session history.
- **Workflow builder** — a four-step editor (TRIGGER → CONTEXT → AGENT → INSTRUCTIONS) with
  `@`-reference autocomplete in the instructions editor and a side-panel **copilot**.
- **Settings** — workspace + user MCP config (registry browse/install + custom URLs), **skill
  authoring**, agent presets, **model presets + allowlist**, integrations.

**B. Control plane (Bun + Elysia on the API host).** Owns auth (Better Auth), all Postgres
product data, the REST/SSE/WS API, the **compiler**, `eve build`, artifact upload to object
storage, and the **scheduler** that assigns runs to workers. REST for CRUD; SSE for live run
streams; WS for copilot.

**C. Compiler (in the control plane).** Pure function: `WorkflowDefinition (DB) → eve project on disk`.
Deterministic codegen of `agent.ts`, `instructions.md`, `connections/*.ts`, `skills/*`, `channels/*`,
`package.json`/`tsconfig.json`. Resolves the model preset → concrete provider model (§7). No business
logic in the generated agent beyond what the pillars describe. **The version hash covers the pillar
config + compiler/template version + pinned eve version** — bumping the compiler or eve invalidates
the build cache naturally.

**D. Worker pool (stateless, horizontally scalable Docker containers).** Each worker runs a
**supervisor** that, on demand, fetches a built artifact by version hash from object storage and
launches a `PORT=<p> eve start` process for that agent — **many agents per worker, concurrently**.
The supervisor reverse-proxies inbound requests to the right local agent process (forwarding
**both** `/eve/` and `/.well-known/workflow/`), and stops idle agent processes (LRU). Workers
**register on boot and heartbeat** to the control plane with capacity (running agents, active
sessions); the scheduler only assigns to live workers and prefers warm ones. On SIGTERM a worker
**drains**: stops accepting new sessions, lets active runs finish or park, then exits. Because
workers are stateless, **all session durability lives in the shared Postgres world**, so any
worker can resume any parked session.

**E. Trigger dispatch (control plane).** Receives inbound events (form, webhook, Slack) on public
ingress → **authenticates them** (webhook token, Slack signing secret) → resolves the target
workflow + its **published version** → builds a normalized `TriggerEvent` → asks the scheduler
for a worker (respecting session affinity) → POSTs the envelope to the compiled agent's matching
channel on that worker. The channel starts/continues the eve session and owns delivery back to
the source. The control plane persists session/run rows and tails the eve NDJSON stream into
`run_events` + SSE to the SPA. Idle/LRU tuning defaults are locked in §2 (env-configurable).

```
React SPA ──HTTP/SSE/WS──> Control plane (Elysia API host) ──> Postgres (product data + Better Auth)
                             │
                             ├── Compiler ── emits ──> eve project (agent/ tree)
                             ├── eve build ── tarball (by version hash) ──> object store (S3)
                             ├── Scheduler ── liveness/affinity-aware assignment ──┐
                             └── Dispatcher ──TriggerEvent──> Worker[k]  (stateless, scalable)
                                                                └─ supervisor: PORT=p eve start  (agent A)
                                                                └─ supervisor: PORT=q eve start  (agent B)  … N agents
                                                                └─ docker() sandbox per session (host socket)
                             ┌──────────────── @workflow/world-postgres (shared durability) ────────────────┐
                             └ all workers read/write session state here, so runs resume on any worker ──────┘
```

---

## 5. Sessions, runs & chat

**Terminology:** Better Auth owns a `session` table (login sessions). The product's chat/agent
sessions live in **`agent_sessions`** to avoid the collision. "Session" below means agent session.

- **A chat thread = one `agent_session` = one eve session.** The first message creates it;
  follow-ups continue it via eve continuation tokens (`eve/client` continuations). Conversational
  triggers map the platform thread to the same session — e.g. replies in a Slack thread carry the
  thread's `continuationToken`, so the mention *and* its follow-ups are one conversation.
- **Sessions pin the workflow version at creation.** Publishing a new version affects new
  sessions only; in-flight conversations keep their compiled agent.
- **Runs.** Each inbound message/trigger event produces a **run** within a session. `runs`
  reference `agent_session_id`; the chat UI renders a session as its sequence of runs.
- **Affinity.** While a session has an active sandbox, it is **sticky** to the worker holding it
  (recorded on `agent_sessions.affinity_worker_id`). On idle eviction or worker death, durable
  state survives in the Postgres world and the session can resume on any worker; `/workspace` is
  re-seeded from skills + workspace seed files. **Anything that must outlive eviction belongs in
  eve world/state or an external store, never `/workspace`.** Make this data-loss semantic
  explicit in docs and tests.
- **HITL.** `input.requested` events render as approval/input prompts in chat (and are visible
  from any surface streaming that run); responses return via `POST /runs/:id/input` →
  `inputResponses`.

---

## 6. Runner & persistence — the critical path

**Lifecycle of a workflow version:**
1. Users edit the workflow **draft** (mutable, on `workflows`). **Publish** writes an immutable
   `workflow_version` with the full pillar config + content hash and sets `published_version_id`.
   Running a draft from the builder also snapshots a version — cheap, because an unchanged config
   yields the same hash and hits the build cache; every run is attributable to an immutable version.
2. Compiler renders the eve project to a directory keyed by the hash.
3. Control plane runs `eve build` **once per hash** (cache; identical config reuses the build) and
   uploads the artifact tarball to object storage.
4. On a run, the scheduler picks a worker (affinity → warm → any live); the supervisor pulls the
   artifact (if cold) and starts or reuses a `PORT eve start` process for that hash.
5. Dispatcher addresses the session through the worker — default HTTP channel for manual/chat,
   the compiled per-trigger channel for everything else (§8).

**Durability & state — make this stateless-safe:**
- Use **`@workflow/world-postgres`** as the eve Workflow world (configured in generated
  `agent/agent.ts` via `experimental.workflow.world`). All run state lives in Postgres, **not**
  worker-local `.workflow-data`, so a session that parks (waiting on approval/OAuth) can resume
  on a different worker.
- **Pin `@workflow/world-postgres` to the same `@workflow/*` beta line as the installed eve
  release** (currently `5.0.0-beta.x`). A mismatched world throws `ZodError: invalid_union` on
  run replay.
- `/workspace` semantics are defined in §5 (sticky-while-active, re-seed on cold resume).

**Two caveats that silently break runs if missed:**
- Every worker proxy/ingress **must forward both `/eve/` and `/.well-known/workflow/`**. The
  world delivers run callbacks to `/.well-known/workflow/v1/flow`; proxying only `/eve/` lets
  sessions start but stalls runs forever.
- Replace eve's scaffolded `placeholderAuth()` / `vercelOidc()` in generated channels with our
  own route auth (a shared-secret/JWT verifier the dispatcher presents). eve fails closed on
  unauthenticated browser traffic by default.

**Sandbox:** mounted host Docker socket (locked, §2). Worker hosts are dedicated — no untrusted
co-tenant workloads share them. If the container platform changes, the escape hatch is a custom
`SandboxBackend` adapter. Do not pin `vercel()`.

**Secrets:** MCP credentials and integration tokens are injected into agent processes as env and
referenced from generated `connections/*.ts` (`auth.getToken` / `headers`). They must never be
written into instructions or model context — eve's connection layer keeps tokens out of the
model; preserve that boundary. Encryption at rest: §11.

---

## 7. Model layer — presets, providers, allowlist

**Providers.** Support two from day one:
- **Anthropic direct** — `@ai-sdk/anthropic`, `anthropic("claude-...")`, reads `ANTHROPIC_API_KEY`.
- **OpenRouter** — `@openrouter/ai-sdk-provider`: `createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY }).chat("<provider/model>")`, one key for hundreds of models.

Keys are **platform-owned** in v1 (locked, §2); the compiler injects only the key matching the
resolved provider into that agent's process env.

eve's `defineAgent({ model })` accepts a provider-authored AI SDK `LanguageModel` object, so the
compiler emits the chosen provider call directly. Example generated `agent/agent.ts`:

```ts title="agent/agent.ts (generated)"
import { defineAgent } from "eve";
import { createOpenRouter } from "@openrouter/ai-sdk-provider";

const openrouter = createOpenRouter({ apiKey: process.env.OPENROUTER_API_KEY! });

export default defineAgent({
  model: openrouter.chat("deepseek/deepseek-v4-pro"), // resolved from preset/override
  reasoning: "medium",
  experimental: { workflow: { world: "@workflow/world-postgres" } },
});
```

**Three workspace presets** — `powerful`, `balanced`, `quick`. Each is a workspace-editable mapping
`preset → { provider, modelId }`. **Seed defaults (locked, §2), all via OpenRouter:**
powerful → `z-ai/glm-5.2`, balanced → `deepseek/deepseek-v4-pro`, quick → `deepseek/deepseek-v4-flash`.
Verify the slugs against OpenRouter's live model list at build time; presets let a workspace re-point
all its agents at once. Seed each workspace's **allowlist** with these three (admins extend it, e.g.
with Claude models via Anthropic direct).

**Agent presets reference a preset, not a hard model.** Each agent preset (General Purpose, Software
Engineer, Product Designer, …) stores a `model_preset` (default `balanced`) plus an optional
`model_id` override for a specific model.

**Allowlist.** Admin/workspace settings define which concrete models (and providers) agents may use.
The builder UI only offers allowlisted models; the compiler **rejects** a workflow whose resolved
model is not allowlisted. Resolution order at compile time:
`agent.model_id override → workspace preset mapping → provider+modelId → emit model: in agent.ts`.
**Re-validate at dispatch too**: a version built before an allowlist change must not run a
now-disallowed model — fail the run with a clear error rather than executing.

**Copilot model:** a platform-configured Claude model on the platform Anthropic key — independent
of workspace presets and allowlist.

---

## 8. Trigger-data abstraction & dispatch path

Define one normalized envelope so trigger types are pluggable:

```ts
type TriggerEvent = {
  workflowId: string;
  triggerType: "manual" | "form" | "webhook" | "slack" | string;
  message: string;                 // model-facing prompt / primary input
  data: Record<string, unknown>;   // structured fields @references resolve against
  files?: { name: string; mediaType: string; data: string | URL }[];
                                   // inline base64 for small payloads; object-store URL otherwise.
                                   // Enforce size caps at ingress.
  principal: { workspaceId: string; userId?: string; source: string };
                                   // who/what triggered. Credential resolution uses the
                                   // workflow's run_as user, NOT the principal (§2).
  continuationToken?: string;      // for conversational / threaded triggers
  context?: string[];              // extra blocks injected before the model sees `message`
};
```

**Dispatch sequence (non-manual triggers):**
1. Public ingress authenticates the event — webhook token (`/t/:token`), Slack request signature
   + timestamp replay window (`/integrations/slack/events`).
2. The trigger **adapter** (`form`, `webhook`, `slack`, …) converts raw inbound → `TriggerEvent`.
   Raw platform parsing lives **only** here, never in compiled agents.
3. Resolve workflow → published version → session (a `continuationToken` maps to an existing
   `agent_session`; otherwise create one).
4. Scheduler picks a worker: session affinity first, then artifact-warm, then any live worker.
5. Dispatcher POSTs the envelope to the compiled agent's matching channel (shared-secret/JWT
   auth). The channel `send(...)`s into the session and **owns outbound delivery** (e.g. posts
   the Slack threaded reply).
6. Control plane persists the run, tails the eve NDJSON stream into `run_events`, serves SSE.

This mirrors eve's channel contract (normalize input → own the continuation token → decide
delivery). **Adding a trigger type = one control-plane adapter + one compiled channel template** —
not a runner or compiler-architecture change. Resolve instruction `@references` against `data` at
dispatch time.

**Slack (locked, §2):** one platform-level Slack app; workspaces install it via OAuth; inbound
events route to the right workspace/workflow by Slack `team_id` + trigger bindings.

---

## 9. Data model (Postgres) — minimum tables

**Auth/orgs (Better Auth-managed):** `user`, `session` (login sessions — see naming note §5),
`account`, `verification`, plus the organization plugin's `organization` (= workspace), `member`,
`invitation`. Treat workspace = Better Auth organization; roles owner/admin/member.

**Product:**
- `mcp_connections` — scope (`workspace` | `user`), source (`registry` | `custom`), registry id /
  MCP URL, auth config (encrypted), tool allow/block list, approval policy (compiled into eve's
  tool-approval config). **Both workspace- and user-level required.**
- `skills` — user-authored markdown skills + optional files, scoped like MCPs (`workspace` | `user`).
- `model_presets` — workspace_id, slug (`powerful` | `balanced` | `quick`), provider, model_id.
  (Seeded per workspace.)
- `model_allowlist` — workspace_id, provider, model_id, enabled.
- `agents` — agent presets: name, base system prompt, reasoning effort, `model_preset` (default
  `balanced`), optional `model_id` override. Seed: **General Purpose, Software Engineer, Product
  Designer**; admins add more.
- `workflows` — name, workspace, `run_as_user_id` (default: creator; must remain a workspace
  member — compiler rejects otherwise), draft pillar config (trigger JSON, context refs, agent
  ref, instructions markdown w/ `@refs`), `published_version_id`.
- `workflow_versions` — immutable pillar-config snapshot + content hash (config + compiler
  version + eve version) + build status.
- `workflow_builds` — version hash → build status, artifact ref (object-store key), error log.
  (Build cache.)
- `agent_sessions` — workflow_id, workflow_version_id, eve session id, continuation token,
  origin (`chat` | `slack` | `webhook` | `form` | `schedule`), principal, `affinity_worker_id`,
  status, timestamps.
- `runs` — agent_session_id, trigger_event (JSON), eve run id, status, timing, error.
- `run_events` — append-only `(run_id, seq, event JSON)` normalized from the eve NDJSON stream.
  Powers live SSE (resume via `Last-Event-ID`) and replay. Optionally archive raw NDJSON to
  object storage.
- `integrations` — installed app integrations (e.g. Slack) + encrypted credentials,
  workspace-scoped, keyed for inbound routing (e.g. Slack `team_id`).
- `triggers` — webhook token **hashes** (rotatable), form schemas, integration bindings routing
  inbound events to a workflow.
- `workers` — worker registry: id, address, last_heartbeat, capacity, status
  (`live` | `draining` | `dead`).

---

## 10. API surface (Elysia) — sketch

```
/api/auth/*                                      # Better Auth (email/pw + OIDC SSO, org plugin)
CRUD   /workspaces/:id/mcp-connections           # workspace context
CRUD   /me/mcp-connections                       # user context
GET    /mcp-registry/search?q=                   # proxies registry.modelcontextprotocol.io
POST   /workspaces/:id/mcp-connections/install   # install a registry server (or custom URL)
CRUD   /workspaces/:id/skills                    # user-authored skills (+ /me/skills)
CRUD   /workspaces/:id/model-presets             # powerful/balanced/quick mapping
CRUD   /workspaces/:id/model-allowlist           # allowed provider+model ids
CRUD   /workspaces/:id/agents                    # agent presets (model_preset + override)
CRUD   /workspaces/:id/workflows                 # workflow draft edit
POST   /workflows/:id/publish                    # snapshot version + compile + build (idempotent by hash)
POST   /workflows/:id/sessions                   # start a chat/manual session (first run)
POST   /sessions/:id/messages                    # follow-up message -> continues eve session (new run)
GET    /sessions/:id                             # session detail + runs
GET    /runs/:id/stream                          # SSE from run_events (resumable via Last-Event-ID)
POST   /runs/:id/input                           # human-in-the-loop response (-> inputResponses)
POST   /runs/:id/cancel                          # abort a run
POST   /t/:token                                 # webhook + form ingress -> TriggerEvent
POST   /integrations/slack/events                # Slack events (signature-verified) -> TriggerEvent
WS     /copilot                                  # builder copilot: streams draft edits
# internal control plane <-> worker (shared-secret/mTLS; never public)
POST   /internal/workers/register                # worker boot registration
POST   /internal/workers/:id/heartbeat           # liveness + capacity
POST   /internal/schedule                        # scheduler assigns a run to a worker
POST   /internal/workers/:id/agents              # supervisor: ensure agent (hash) is running
```

---

## 11. Security & safety

- **Secrets at rest.** AES-256-GCM envelope encryption (master key from env/KMS, per-row data
  keys) for MCP auth configs, integration credentials, and trigger secrets. Never log plaintext.
- **Model-context boundary.** Tokens flow env → generated `connections/*.ts`
  (`auth.getToken`/`headers`) → never into instructions or model context. Preserve eve's boundary.
- **Ingress auth.** Per-trigger webhook tokens (store hashes, support rotation); Slack request
  **signature verification** with a timestamp replay window; rate limits + payload size caps on
  `/t/:token` and Slack ingress.
- **Worker-plane auth.** All `/internal/*` endpoints and dispatcher→channel calls authenticated
  (shared secret or short-lived JWT). This is what replaces eve's scaffolded `placeholderAuth()`.
- **Safety caps (billing deferred ≠ uncapped).** Per-run max wall-clock and max model turns;
  per-workspace concurrent-run cap. Platform-wide configurable defaults, enforced by the
  dispatcher/scheduler.
- **Authorization.** Everything workspace-scoped; role checks (owner/admin/member) on settings
  mutations; user-scoped resources visible only to their owner.

---

## 12. Copilot (in v1)

A side-panel assistant in the builder. It reads the current draft `WorkflowDefinition` and the
available context (workspace MCPs, skills, agent presets, allowlisted models) and proposes edits
to any pillar: suggest a trigger, pick MCPs/skills, choose an agent preset + model preset, and
**write/refine the instructions with valid `@references`**. Implement it as a tool-using Claude
loop whose tools are typed mutations on the draft (`setTrigger`, `addContext`, `setAgent`,
`setModelPreset`, `setInstructions`, …) so every suggestion is a structured, applyable diff the
UI previews and accepts. Stream tokens over `/copilot`. Model: §7.

---

## 13. Phased build plan

**Phase 0 — Foundations + de-risking spike.** Bun-workspaces monorepo, Elysia control-plane
skeleton, Postgres + migrations, **Better Auth** (email/pw + generic OIDC + org plugin, with a
Dockerized test IdP — Dex or Keycloak — in the compose stack and CI), React+Vite shell,
object-store wiring, seed model presets per workspace. **Spike:** stand up a hand-written
eve agent **self-hosted** (`eve build` + `PORT eve start`) with `@workflow/world-postgres` and
the `docker()` sandbox on a socket mount, and drive it via `eve/client` — this validates the
entire runtime bet before any product code depends on it.

**Phase 1 — Compiler + runner spine.** `WorkflowDefinition → eve project` codegen (incl.
model-preset resolution → provider model), `eve build` with hash caching + tarball upload, and a
**single worker** running `eve start` agents with world-postgres durability. Sessions + runs
persisted; SSE streaming from `run_events`. Acceptance: create a workflow via API, publish it,
start a session, watch real eve events stream; **a follow-up message continues the same eve
session**.

**Phase 2 — Four-pillar data + builder UI.** Full CRUD for all four pillars; the four-step
builder UI; `@reference` autocomplete; **MCP registry** browse/install + custom URLs; **skill
authoring**; **model presets + allowlist** UI; workspace + user context settings. Acceptance:
a user builds a workflow with a **form trigger**, two registry MCPs, one authored skill, an
agent preset (balanced), and `@`-referenced instructions entirely in the UI, publishes it, runs
it from chat, and sees streamed output. (Slack trigger *config UI* may ship here; its adapter
lands in Phase 3.)

**Phase 3 — Worker pool + triggers + HITL.** Scheduler + stateless multi-agent workers
(register/heartbeat/drain, supervisor, LRU, sticky-while-active); form/webhook/Slack trigger
adapters on `TriggerEvent` + compiled channel delivery; run cancel; human-in-the-loop rendering +
response (`input.requested` → UI → `inputResponses`). Acceptance: runs spread across ≥2 workers;
each trigger type starts a run; **a Slack mention gets a threaded reply, and a reply in that
thread continues the same session**; a gated tool pauses and resumes from a UI approval; a parked
session resumes on a **different** worker; a draining worker hands off cleanly.

**Phase 4 — Copilot.** Builder copilot with structured draft-mutation tools. Acceptance: copilot
scaffolds a runnable workflow from a one-line description and edits an existing one.

**Cross-cutting (every phase):** build caching by hash; secrets encryption; safety caps; run
history + replay; **observability** — structured logs carrying workspace/workflow/session/run
ids, worker + scheduler metrics (queue depth, run duration, utilization); a verification pass
each phase (integration test that compiles, builds, runs, and asserts on streamed events).

---

## 14. Constraints & gotchas (carry into the code)

- **Self-host, not Vercel.** `eve build` + `PORT=… eve start --host 0.0.0.0`; do not pin
  `vercel()` sandbox or rely on `vercelOidc()`. eve's docs assume Vercel — expect friction; the
  Phase 0 spike exists to surface it early.
- **Stateless workers ⇒ durability in `@workflow/world-postgres`, not local disk.** Keep active
  sessions sticky to the worker holding their sandbox (§5).
- **Forward `/.well-known/workflow/` and `/eve/`** through every worker proxy.
- **Pin `@workflow/world-postgres`** to the eve release's `@workflow/*` line (`5.0.0-beta.x`).
- **Version hash must include compiler/template + eve versions**, not just pillar config —
  otherwise upgrades serve stale artifacts.
- **`docker()` sandbox via mounted host socket**; worker hosts are dedicated (host-level
  isolation boundary). Custom `SandboxBackend` is the escape hatch.
- **`defineAgent({ model })` takes a provider object** — emit `anthropic("...")` or
  `openrouter.chat("...")` and inject the matching API key into the agent process env. Validate
  against the allowlist at compile **and** dispatch.
- **eve naming is path-derived** — no `name`/`id` on `define*`; filename = identity
  (`connections/linear.ts` → `linear`, tools `linear__<tool>`).
- **Tools run in the app runtime with full env; only sandbox tools run in the sandbox.** Never
  leak secrets into model context.
- **`channels/` and `schedules/` are root-agent-only.** `instructions.md` is required on the
  root; `agent.ts` `model` is required when present (default `anthropic/claude-sonnet-4.6`).
- **Compiled channels receive `TriggerEvent` envelopes, not raw platform payloads.** Raw Slack/
  webhook parsing lives only in control-plane adapters (§8).
- **Naming collision:** Better Auth `session` (login) vs `agent_sessions` (chat/eve) — keep them
  distinct everywhere, including in code and API paths.

---

## 15. eve documentation — READ THESE FIRST (source of truth)

Fetch page-level Markdown (append `.md`).

- Orientation: `https://eve.dev/agents.md`, `https://eve.dev/sitemap.md`, full corpus `https://eve.dev/llms.txt`
- Layout & config: `/docs/reference/project-layout.md`, `/docs/reference/typescript-api.md`, `/docs/agent-config.md`, `/docs/instructions.md`
- Runtime: `/docs/concepts/execution-model-and-durability.md`, `/docs/concepts/sessions-runs-and-streaming.md`, `/docs/concepts/default-harness.md`, `/docs/concepts/security-model.md`, `/docs/human-in-the-loop.md`
- Triggers: `/docs/channels/overview.md`, `/docs/channels/custom.md`, `/docs/channels/eve.md`, `/docs/channels/slack.md`, `/docs/schedules.md`
- Context: `/docs/connections.md`, `/docs/connections/mcp.md`, `/docs/connections/openapi.md`, `/docs/skills.md`, `/docs/tools.md`
- Sandbox & state: `/docs/sandbox.md`, `/docs/guides/state.md`, `/docs/guides/session-context.md`, `/docs/guides/dynamic-capabilities.md`
- Driving it: `/docs/guides/client/overview.md` (+ `messages`, `streaming`, `continuations`, `output-schema`), `/docs/guides/deployment.md`, `/docs/guides/auth-and-route-protection.md`
- Multi-tenancy: `/docs/patterns/multi-tenant-auth.md`, `/docs/patterns/multi-tenant-approvals.md`, `/docs/patterns/multi-tenant-memory.md`

Other source-of-truth docs: **Better Auth** (organization + OIDC/SSO plugins), **OpenRouter AI SDK
provider** (`@openrouter/ai-sdk-provider`), **`@workflow/world-postgres`** (version pinning),
**official MCP registry API** (`registry.modelcontextprotocol.io`).

---

## 16. Previously open questions — now resolved (do not re-ask)

1. **Model preset seed IDs** — locked in §2/§7: `z-ai/glm-5.2` / `deepseek/deepseek-v4-pro` /
   `deepseek/deepseek-v4-flash` via OpenRouter, workspace-editable. Verify slugs against
   OpenRouter's live list at build time.
2. **Idle-eviction & LRU tuning** — locked in §2: 15 min process idle / 30 min sandbox idle /
   ~20 agents per worker / 20 GB artifact cache, all env-configurable.
3. **Slack app shape** — locked in §2/§8: single platform-level Slack app, routed by `team_id`.
4. **OIDC SSO** — generic spec-compliant OIDC via Better Auth; CI + local dev validate against a
   Dockerized test IdP (Dex or Keycloak); Microsoft Entra ID is the first production IdP target.

