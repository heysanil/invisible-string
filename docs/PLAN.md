# invisible-string — Design & Master Implementation Plan (v1, Phases 0–4)

## Context

Greenfield build of a cloud-hosted agent platform ("Claude Code / Cowork in the cloud") per `INITIAL-SPEC.md`: users assemble **workflows** from four pillars (TRIGGER · CONTEXT · AGENT · INSTRUCTIONS) in a chat-centric web UI; each workflow **compiles to a self-hosted eve agent** run on a stateless worker pool with Postgres-backed durability. Multi-tenant (Better Auth orgs), with an AI copilot in the builder.

This plan is the outcome of a brainstorming pass: live eve/Better Auth/OpenRouter/world-postgres/MCP-registry docs were researched (12-agent workflow, 2026-07-02), all spec claims verified or corrected, and key product/visual decisions made interactively with mockups. The user approved the design (all four sections) and chose: **one master plan covering all phases in full detail**, **local-first + cloud-ready environments**, and the default implementation stack.

**Spec authority:** `INITIAL-SPEC.md` §2 locked decisions are honored throughout. Where live eve docs contradicted the spec, the docs win (per spec §0) — corrections listed below.

**2026-07-10 supersession:** the four-pillar, workflow-centric product model this plan was written against is superseded by the agents-first redesign (`docs/superpowers/specs/2026-07-10-agents-first-redesign.md`); Phases 0–4 below remain the historical record — see Phase 5 at the bottom.

---

## Decisions made in brainstorming (now locked)

| Area | Decision |
|---|---|
| Plan scope | Master plan, Phases 0–4 fully detailed (this file) |
| Environments | Local-first: docker-compose (Postgres, Garage, Dex IdP, control plane, 2 workers) is the acceptance target; CI on GitHub Actions; production compose provisioned (docker-compose.prod.yml; docs/DEPLOY.md) |
| Stack (open items) | Drizzle ORM + drizzle-kit · Tailwind v4 + shadcn/ui · TanStack Router + Query · CodeMirror 6 (instructions editor) · Elysia TypeBox validation · bun:test + Playwright · monorepo `apps/{control-plane,worker,web}` + `packages/{compiler,db,shared}` |
| App shell | **B — workspace rail**: floating glass dock with 💬 Chat · ⚡ Workflows · 🧩 Context · ⚙ Settings, each = list panel + main pane |
| Builder layout | **A+B hybrid**: left pillar-summary rail (live config cards with ✓/warning states; active card "solidifies"), center focused per-pillar editor, right docked copilot; Run draft/Publish in rail |
| Run rendering in chat | **C — collapsible working block**: steps stream live (tool name + one-line result), folds to "Worked for Ns · N steps" on completion; full detail one click away |
| Aesthetic | **E1 — monochrome ink × liquid glass, floating islands**: warm-white wallpaper wash, frosted floating panels, capsule controls, ink-black primary; color ONLY as meaning (green ✓ / amber ⏸ / red error) |

### E1 design tokens (for `apps/web` theme)
- Wash: `linear-gradient(135deg,#eef0f4,#e8eaef,#f0eeea)` + large blurred blobs `#d7dbe3 / #e3ded4 / #cfd4de`
- Glass panels: `rgba(255,255,255,.50–.55)` + `backdrop-filter: blur(20–28px)` + border `rgba(255,255,255,.65–.7)` + shadow `0 8px 32px rgba(0,0,0,.08–.10)` + inset top highlight `rgba(255,255,255,.8)`
- Ink: text/primary buttons `#111`; secondary `#555/#777/#999`; hairlines `rgba(0,0,0,.06)`
- Semantic only: `#16a34a` success · `#f59e0b` waiting/approval · `#dc2626` error/destructive
- Radii: panels 18–20px · cards 12–14px · all controls capsule (`999px`); dock is a floating vertical glass capsule
- Type: `-apple-system/SF Pro/Inter`, headings 650–700 weight, `-0.02em` tracking; `ui-monospace` for tool names and `@refs` (ink on 8% black chips)
- Resilience: `@supports not (backdrop-filter)` → solid `#f7f7f7` surfaces; honor `prefers-reduced-transparency`; virtualize chat threads (glass panes must not repaint per streamed token)

---

## Live-doc corrections to the spec (compiler/runtime must follow these)

1. **Default model is `anthropic/claude-sonnet-5`** (not `claude-sonnet-4.6`) — irrelevant in practice: the compiler ALWAYS emits an explicit `model`.
2. **`context: string[]` is not a `send()` option.** `send(message, { auth, continuationToken, state?, title? })`. Context injection lives in the **eve channel's `onMessage` hook** (`return { auth, context: [...] }`). Custom trigger channels fold context blocks into the message content instead.
3. **eve's built-in Slack channel is Vercel-coupled** (`connectSlackCredentials` from `@vercel/connect`). We emit a **custom channel** for Slack triggers; outbound replies go through the Slack Web API with platform credentials from env.
4. **Docker sandboxes have no idle timeout in eve** and only `allow-all`/`deny-all` egress. The 30-min sandbox eviction is implemented by **our worker supervisor reaper**; threat model assumes full-egress sandboxes on dedicated hosts.
5. **Exact version pinning**: `@workflow/world-postgres` 5.0.0-beta.x pins sibling `@workflow/*` exactly. Pin exact `eve` version platform-wide; select the world-postgres beta whose transitive `@workflow/world` matches eve's bundled one (read from eve's lockfile in CI). Never `eve@latest` in generated projects; commit lockfiles.
6. **eve requires Node 24.x** for agents; deps `eve`, `ai`, `zod`. eve's `ai` major is undocumented → resolved empirically in Phase 0; `@openrouter/ai-sdk-provider@2.x` needs `ai@^6` (usage: `createOpenRouter({apiKey})` then `openrouter('z-ai/glm-5.2')`), fallback lines exist for older majors. Seed slugs verified live: `z-ai/glm-5.2`, `deepseek/deepseek-v4-pro`, `deepseek/deepseek-v4-flash` ✓.
7. **Auth scaffold**: `eve init` emits `eveChannel({ auth: [vercelOidc(), localDev(), placeholderAuth()] })`. We emit our own `AuthFn` built on `verifyJwtHmac` (helpers exist: `jwtHmac()`, `extractBearerToken`, from `eve/channels/auth`), plus `localDev()` only in dev builds.
8. **Session ownership is NOT enforced by eve route auth** — control plane must map session→workspace at create and check on every continue/stream/input/cancel.
9. **Schedules only fire under `eve start`** (Nitro task runner). Fine for us; never scale schedule-bearing agents to zero; dev-only trigger route exists for tests.
10. **Proxy must forward `/eve/` AND `/.well-known/workflow/`** (callbacks hit `/v1/flow` and `/v1/step`) — else runs stall silently. ⚠️ **`WORKFLOW_POSTGRES_JOB_PREFIX` does NOT isolate agents sharing a world DB** (spike REPORT finding 11: `reenqueueActiveRuns` ignores the prefix and re-drives OTHER agents' runs under the booting agent's queue). **Phase-1 isolation decision (plan of record): one world Postgres schema per workflow version** — the supervisor provisions/bootstraps a dedicated schema (`world_<hash>`, via per-agent `WORKFLOW_POSTGRES_URL` with `search_path`/database) before first boot. Fallbacks if schema-per-version proves unworkable: (b) wrap/patch the world factory to filter re-enqueue by prefix, or (c) homogeneous agents per world. This lands with the compiler env-contract templates, before the Phase-3 multi-agent worker pool.
11. eve channel HTTP API: `POST /eve/v1/session` → `{sessionId, continuationToken}`; `POST /eve/v1/session/:id` follow-ups; `GET /eve/v1/session/:id/stream` NDJSON with `?startIndex=` resume. Event types include `session.*, turn.*, step.*, message.*, input.requested, reasoning.*, authorization.*` — exact per-event JSON shapes are underdocumented; derive from live runs in Phase 0 and freeze in `packages/shared`.

**Top risks (mitigations built into phases):** @workflow beta-train skew (exact pins + replay smoke test in CI); world-postgres is a "reference implementation" calling back into the agent's own HTTP server (health = end-to-end turn checks, chaos test in Phase 0); `ai` major pairing (spike resolves); Vercel gravity on OAuth/Slack (custom channels; `defineInteractiveAuthorization` only if user-scoped OAuth MCPs land in scope); docs churn (treat TS types as contract; template changes gated by `eve build` + typecheck in CI).

---

## Architecture

```
apps/web (Vite+React SPA, glass UI)
   │ REST/SSE (runs) · WS (copilot)
apps/control-plane (Bun+Elysia)          Postgres (product data + Better Auth + eve world DB)
   ├─ Better Auth (email/pw, OIDC SSO via @better-auth/sso, org plugin)
   ├─ CRUD + authz (workspace scoping, roles)
   ├─ packages/compiler → eve project dir (keyed by version hash)
   ├─ eve build (once per hash) → tarball → Garage/S3
   ├─ scheduler (affinity → artifact-warm → any live worker)
   ├─ dispatcher (trigger adapters → TriggerEvent → compiled channel; session ownership)
   └─ event tailer (NDJSON → run_events → SSE, Last-Event-ID resume)
apps/worker (stateless, Node 24 image, mounted /var/run/docker.sock)
   ├─ supervisor: register/heartbeat/drain; ensure-agent(hash) → pull+extract tarball (20GB LRU) → PORT=p eve start
   ├─ reverse proxy: /agents/:hash/{eve/*, .well-known/workflow/*} → localhost:p  (BOTH prefixes)
   └─ reapers: agent-process idle 15m · sandbox idle 30m (docker ps filter by eve session labels)
```

- **Session model:** chat thread = `agent_sessions` row = one eve session; store `{eve_session_id, continuation_token, workflow_version_id, affinity_worker_id, origin, principal}`. Follow-ups: `POST /eve/v1/session/:id` with stored token (via `eve/client` continuations). Runs = one per inbound message/trigger; `run_events` normalized from NDJSON.
- **Compiled agent env (injected by supervisor, per agent):** `PORT`, `WORKFLOW_POSTGRES_URL` **pointing at that workflow version's dedicated world schema** (`world_<hash>` — the job prefix does NOT isolate agents; see correction 10), `WORKFLOW_POSTGRES_JOB_PREFIX=<workflow_version_hash>` (kept for observability/log grouping only), `PLATFORM_JWT_SECRET` (channel auth), exactly one provider key (`OPENROUTER_API_KEY` | `ANTHROPIC_API_KEY`), `MCP_<CONN>_TOKEN…` (decrypted at launch), safety-cap values.
- **@reference semantics:** instructions keep human-readable refs. Compile time: refs to skills/connections/agent fields become literal text in `instructions.md` (+ descriptions so `connection_search` finds them). Dispatch time: `@trigger.*` refs resolve against `TriggerEvent.data`; the channel injects resolved blocks — eve channel via `onMessage → context[]`, custom channels by prepending structured blocks to the message.

## Data model (Drizzle, `packages/db`)

Better Auth-managed: `user, session, account, verification, organization, member, invitation` (+ `session.activeOrganizationId`). Product tables exactly per spec §9: `mcp_connections` (scope, source, url/registry id, encrypted auth, tool allow/block, approval policy), `skills`, `model_presets` (seeded per workspace), `model_allowlist`, `agents` (presets; seed General Purpose / Software Engineer / Product Designer), `workflows` (draft pillar JSON, `run_as_user_id`, `published_version_id`), `workflow_versions` (immutable config + hash incl. compiler+eve versions + build status), `workflow_builds` (hash → artifact key, error log), `agent_sessions`, `runs`, `run_events (run_id, seq, event)`, `integrations` (Slack per `team_id`, encrypted), `triggers` (webhook token **hashes**, form schemas, bindings), `workers` (address, heartbeat, capacity, status live|draining|dead). Encryption: AES-256-GCM envelope (master key env, per-row data keys).

## API surface

Per spec §10 verbatim (Better Auth mount, workspace/user MCP + skills CRUD, registry search proxy, presets/allowlist/agents/workflows CRUD, publish, sessions/messages, `runs/:id/{stream,input,cancel}`, `/t/:token`, `/integrations/slack/events`, WS `/copilot`, internal worker endpoints with shared-secret auth).

---

## Phase 0 — Foundations + de-risking spike

**Repo/infra tasks**
1. `git init`; Bun workspaces monorepo scaffold; base tsconfig; `.gitignore` (incl. `.superpowers/`); CI skeleton (GitHub Actions: typecheck, test, compose-up integration job).
2. `docker-compose.yml`: Postgres (two DBs: `product`, `world`), Garage, Dex (test IdP with static user), control-plane, worker ×2 (profiles: `dev` minimal / `full`).
3. `packages/db`: Drizzle schema for all tables above + migrations; seed script (workspace, presets, allowlist, agent presets, demo user).
4. Better Auth in Elysia (`.mount(auth.handler)`): email/pw + org plugin + `@better-auth/sso` OIDC registered against Dex; workspace-scoping middleware (Elysia macro resolving session + active org + role); CI test: sign-up → create org → OIDC SSO login vs Dex.
5. `apps/web` shell: Vite + React + Tailwind v4 + shadcn/ui + TanStack Router/Query; E1 theme tokens (CSS custom properties + glass utility classes + reduced-transparency fallbacks); glass dock + empty section routes; login/signup pages.
6. Secrets envelope encryption module (AES-256-GCM) + tests.

**Spike (`spike/` dir, throwaway but CI-kept):** hand-written eve agent, exact-pinned versions.
7. Resolve version matrix: install `eve` (pin exact), read its lockfile → `@workflow/world` version → pick matching `@workflow/world-postgres` beta; read eve's `ai` dep major → pick `@openrouter/ai-sdk-provider` major. Record in `packages/compiler/versions.json` (single source for templates).
8. Agent: `defineAgent({ model: openrouter('deepseek/deepseek-v4-flash'), experimental.workflow.world })`; one MCP connection (any public MCP); one skill; one tool with `approval: always()`; customized `eve.ts` with `verifyJwtHmac` AuthFn + `localDev()`; one custom channel; one 1-minute schedule; docker sandbox.
9. `bootstrap` world DB (`setupDatabase`); `eve build`; `PORT=4101 eve start --host 0.0.0.0` behind a minimal Bun proxy forwarding `/eve/` + `/.well-known/workflow/`.
10. Drive with `eve/client`: create session → stream NDJSON → capture real event shapes into `packages/shared/eve-events.ts`.

**Acceptance (all scripted, `bun test spike/`):**
- Turn completes through the proxy; NDJSON stream resumes with `startIndex` after disconnect.
- Approval-gated tool parks session (`input.requested`, status `waiting`); **kill `eve start`, restart it; `inputResponses` resumes and completes the turn** (durability bet).
- Follow-up message via continuation token shares session memory.
- Sandbox `bash` writes `/workspace/file` via mounted socket; file persists across turns in-session.
- 1-minute schedule fires under `eve start` (not `eve dev`).
- Unauthenticated session POST → 401; JWT-signed → 200.
- Fallback decision gate: if world-postgres irreparably fails, switch design to local world on persistent volumes (workers lose statelessness; document and re-plan Phase 3).

## Phase 1 — Compiler + runner spine

1. `packages/shared`: `TriggerEvent`, pillar-config Zod/TypeBox schemas, frozen eve event types, API contracts.
2. `packages/compiler`: pure fn `compile(WorkflowDefinition, versions) → {files: Map<path,string>, hash}`. Emits: `package.json` (pinned)/`tsconfig`/`agent/agent.ts` (preset→provider model resolution; allowlist check → typed error)/`instructions.md` (persona block + instructions; compile-time ref resolution)/`connections/*.ts`/`skills/*`/`channels/eve.ts` (+ per-trigger channels)/`schedules/*`. Golden-file tests per pillar permutation; property test: same config → same hash; hash covers config + compiler version + eve version.
3. Build service in control plane: render to tmp dir → `bun install` (cached store) → `eve build` → tar `.output` + manifest → Garage by hash; `workflow_builds` cache (skip on hit); surface build errors to API.
4. `apps/worker` supervisor v1 (single worker): ensure-agent(hash) → pull/extract → spawn `eve start` (port pool) → readiness via `/eve/v1/health`; proxy both prefixes; 15-min idle stop; register/heartbeat.
5. Control plane runtime API: publish (snapshot+compile+build, idempotent), create session (scheduler stub picks the worker; POST `/eve/v1/session` with platform JWT; persist ids/tokens), follow-up messages, NDJSON tailer → `run_events` → SSE `GET /runs/:id/stream` (Last-Event-ID); session-ownership checks everywhere.
6. Safety caps v1: per-run wall-clock timer (cancel via abort/turn-limit config), per-workspace concurrent-run gate in dispatcher.

**Acceptance (integration test in CI):** REST-create workflow (manual trigger, 1 MCP, 1 skill, balanced preset) → publish → session → real streamed eve events land in `run_events` and SSE → follow-up continues same eve session (verified by shared memory) → republish with changed instructions → old session keeps old version, new session uses new.

## Phase 2 — Four-pillar data + builder UI

1. CRUD APIs + UI for all pillars; MCP registry proxy (`GET /v0.1/servers?search=&version=latest`, filter active/latest) + install flow (map `remotes[].url`, env-var declarations → secret prompts, encrypted) + custom-URL path; skill authoring (CodeMirror markdown + file attachments); model presets + allowlist UI; agent presets UI.
2. Builder (hybrid layout, E1): pillar rail with live cards + ✓/warning validation (client mirror of compiler checks); focused editors — Trigger (manual/form/webhook/Slack config UI; Slack adapter itself lands Phase 3), Context (registry browser, per-connection tool allow/block + approval policy editor), Agent (preset picker + preset/model override within allowlist), Instructions (CodeMirror 6 with `@` autocomplete sourced from trigger schema + connections + skills); Run draft (snapshots version) + Publish.
3. Chat surface: session list w/ status; thread with collapsible working blocks (C) fed by SSE; approval cards → `POST /runs/:id/input`; composer; version/model chips; "Edit workflow ↗".
4. Settings: members/roles, integrations placeholder, workspace/user context tabs.
5. Playwright E2E begins here (compose stack): the §Acceptance flow below.

**Acceptance:** user builds a **form-trigger** workflow with 2 registry MCPs + 1 authored skill + balanced agent + `@`-referenced instructions entirely in UI → publish → run from chat → streamed output with working block → approval card round-trips.

## Phase 3 — Worker pool + triggers + HITL hardening

1. Scheduler: liveness (heartbeat TTL) + affinity (`agent_sessions.affinity_worker_id` while sandbox live) + artifact-warm preference + capacity caps (~20 agents/worker); worker drain on SIGTERM (stop accepting, finish/park, deregister); dead-worker failover (affinity cleared, resume elsewhere).
2. Sandbox reaper (30-min idle) + artifact LRU (20GB) on workers; env-tunable.
3. Trigger ingress: `/t/:token` (hash lookup, rate limits, payload caps; form + webhook adapters → `TriggerEvent`), Slack: OAuth install flow (platform app, store per-`team_id` creds encrypted) + `/integrations/slack/events` (signature + 5-min replay window; mention/DM/thread-reply adapters; thread_ts ↔ continuation mapping) → dispatcher → compiled channel POST (JWT) → channel `send()` + outbound threaded reply via Slack Web API; `x-slack-retry` idempotency.
4. Run cancel API + UI; dispatch-time model-allowlist re-validation (fail run with clear error).
5. Observability: structured logs (workspace/workflow/session/run ids), scheduler metrics (queue depth, run duration, worker utilization) exposed via `/internal/metrics`.

**Acceptance:** runs spread across ≥2 workers; each trigger type starts a run; Slack mention → threaded reply, thread reply continues same session; gated tool pauses → UI approval resumes; parked session resumes on a **different** worker after its home worker is killed; draining worker hands off cleanly.

## Phase 4 — Copilot

1. WS `/copilot`: Claude on platform key (claude-api skill for SDK specifics at implementation time); tool loop with typed draft mutations `setTrigger/addContext/removeContext/setAgent/setModelPreset/setInstructions` (TypeBox-validated, applied to draft only via optimistic UI diff-preview → accept/reject); context = current draft + workspace MCPs/skills/presets/allowlist.
2. Builder integration: suggestion cards (as mocked), Apply/Preview/Dismiss; copilot can explain validation warnings from pillar cards.

**Acceptance:** copilot scaffolds a runnable workflow from a one-line description (compiles + publishes clean); edits an existing workflow (e.g. "gate email sends behind approval") producing a valid diff.

---

## Cross-cutting (every phase)
- **Testing:** unit (bun:test) everywhere; compiler golden files; per-phase compose integration test (compile→build→run→assert streamed events); Playwright E2E from Phase 2; replay/kill-resume chaos test from Phase 0 stays in CI as the eve-upgrade gate.
- **Security:** envelope encryption from Phase 0; plaintext never logged; JWT worker-plane auth; ingress rate limits + size caps; role checks on settings mutations; user-scoped resources owner-only.
- **Docs-in-repo:** `docs/` — runtime version matrix + upgrade playbook, `/workspace` data-loss semantics (sticky-while-active, re-seed on cold resume; durable state belongs in eve world/state or external stores), trigger-adapter authoring guide.

## Verification (end-to-end)
1. `docker compose up` → `bun test` (unit + integration) green locally and in CI.
2. Phase-0 spike suite proves the seven acceptance bullets (esp. kill-resume).
3. Phase-1: `curl` script: create→publish→session→SSE shows `step.*`/`message.*` events; follow-up shares memory.
4. Phase-2+: Playwright run of the full builder→publish→chat→approval flow against compose.
5. Phase-3: `docker compose stop worker-1` mid-parked-session → approval from UI → run completes on worker-2 (asserted in integration test).
6. Manual: Slack mention in a sandbox workspace → threaded reply → reply continues session.

## Execution kickoff (first steps after plan approval)
1. `git init` + initial commit of `INITIAL-SPEC.md` + this plan; materialize the approved design as `docs/superpowers/specs/2026-07-02-invisible-string-design.md` (content = this file's design sections) and commit. Commits never reference Claude (user rule).
2. Save visual-decision + preference notes to memory (user prefers Apple liquid-glass monochrome aesthetics; detailed large mockups).
3. Follow superpowers flow: `writing-plans` skill expands Phase 0 into a TDD task list, then `executing-plans`/`subagent-driven-development` per phase; `verification-before-completion` before each phase sign-off.

---

## Phase 5 — Agents-first re-architecture (2026-07-10)

**Design record:** `docs/superpowers/specs/2026-07-10-agents-first-redesign.md` (concept model, IA, technical decisions, supersessions of INITIAL-SPEC §2 rows and the 2026-07-02 spec, vocabulary standard). **Status: in progress.**

The Agent (PERSONA · MODEL · CONTEXT) becomes the first-class entity and the compile unit; workflows simplify to standing delegations (TRIGGER → AGENT → INSTRUCTIONS) with no builds of their own. Scope:

1. **Contracts + data** — `packages/shared` (`AgentDefinition`, `WorkflowConfig`, shared `renderTaskMessage`, re-keyed DTOs, surface-discriminated copilot frames) + `packages/db` (migration 0005: `agents` expanded in place, `agent_versions`/`builds` replace `workflow_versions`/`workflow_builds`, workflows simplified with `publishedAgentId`, trigger `cron`/`nextFireAt`, session/run re-keys; destructive — dev stacks reset with `docker compose down -v`).
2. **Compiler** — `compile(AgentDefinition)`; artifact emits only the default eve channel (trigger channels, compiled schedules, and outbound-delivery codegen deleted); world prefix `ag_v_`; JWT audience `agent-version:<hash>`; `COMPILER_VERSION` 3.0.0 + golden regen.
3. **Control plane** — agent CRUD + publish/build lifecycle; chat sessions target Agents; workflow publish = validate + snapshot + trigger sync (no build); dispatch renders the task message and drives eve's native session API; control-plane Slack DeliveryService (at-least-once) + schedule cron ticker; copilot two surfaces; seeded-agent auto-publish. Worker: zero code changes.
4. **Web SPA** — Agents top-level section + flagship agent editor; chat agent picker; single-column workflow editor with manual Run; Settings loses agent presets.
5. **Acceptance + e2e rewrite, then docs/site messaging pivot** (README, MDX docs tree, landing) per the vocabulary standard.

**Acceptance:** the full lane matrix (unit/typecheck, DB-gated integration incl. `SPIKE_EVE_BUILD=1`, phase-1 and phase-3 acceptance re-keyed agent-first + schedule + control-plane Slack delivery proofs, keyed lanes manual, Playwright e2e, prod-compose smoke) green in its documented lanes.
