# invisible-string — Design (approved 2026-07-02)

Cloud-hosted agent platform: users assemble **workflows** from four pillars (TRIGGER · CONTEXT · AGENT · INSTRUCTIONS) in a chat-centric web UI; each workflow compiles to a **self-hosted eve agent** running on a stateless worker pool with Postgres-backed durability (`@workflow/world-postgres`). Multi-tenant via Better Auth organizations. AI copilot in the builder. Full build brief: `INITIAL-SPEC.md` (its §2 locked decisions are binding). Master implementation plan: `docs/PLAN.md`.

## Product decisions (brainstormed + approved)

| Area | Decision |
|---|---|
| App shell | Workspace rail: floating glass dock — 💬 Chat · ⚡ Workflows · 🧩 Context · ⚙ Settings; each section = list panel + main pane |
| Builder | Hybrid: left pillar-summary rail (live config cards, ✓/warning states, active card "solidifies"); center focused per-pillar editor (CodeMirror 6 instructions with `@` autocomplete); right docked copilot with structured Apply/Preview suggestions; Run draft + Publish in rail |
| Chat runs | Collapsible working block: steps stream live (tool + one-line result), folds to "Worked for Ns · N steps"; HITL renders as inline approval cards |
| Aesthetic | **E1 — monochrome ink × liquid glass (floating islands)**: warm-white wallpaper wash, frosted floating panels, capsule controls, ink-black primary; color only as meaning (green ✓ / amber ⏸ / red error) |
| Stack | Bun+Elysia · Vite+React · Drizzle · Tailwind v4 + shadcn/ui · TanStack Router/Query · CodeMirror 6 · TypeBox · bun:test + Playwright |
| Environments | Local-first docker-compose (Postgres, MinIO, Dex, control-plane, 2 workers) as acceptance target; GitHub Actions CI; production topology documented, not provisioned |

### E1 design tokens
- Wash `linear-gradient(135deg,#eef0f4,#e8eaef,#f0eeea)` + blurred blobs `#d7dbe3/#e3ded4/#cfd4de`
- Glass: `rgba(255,255,255,.50–.55)`, `backdrop-filter: blur(20–28px)`, border `rgba(255,255,255,.65–.7)`, shadow `0 8px 32px rgba(0,0,0,.08–.10)`, inset top highlight
- Ink `#111` (text + primary buttons); secondary `#555/#777/#999`; hairlines `rgba(0,0,0,.06)`
- Semantic-only color: `#16a34a` / `#f59e0b` / `#dc2626`
- Radii: panels 18–20, cards 12–14, controls capsule `999px`; type: system sans, headings 650–700 @ `-0.02em`; `ui-monospace` for tool names/`@refs`
- Fallbacks: `@supports not (backdrop-filter)` → solid `#f7f7f7`; honor `prefers-reduced-transparency`; virtualize chat threads

## Live-doc corrections (docs win over the brief)
1. eve default model is `anthropic/claude-sonnet-5`; compiler always emits an explicit `model` anyway.
2. `context: string[]` is an **eve-channel `onMessage` return**, not a `send()` option; custom trigger channels fold context into the message.
3. eve's Slack channel is Vercel-coupled → we emit custom channels; outbound via Slack Web API with platform creds.
4. Docker sandboxes: no idle timeout in eve (our supervisor reaps at 30 min), egress only allow-all/deny-all.
5. Exact version pinning: eve pinned platform-wide; `@workflow/world-postgres` beta matched to eve's bundled `@workflow/world`; lockfiles committed; never `@latest`.
6. Agents need Node 24.x; eve deps `eve, ai, zod`; `ai` major ↔ `@openrouter/ai-sdk-provider` major resolved empirically in Phase 0 (`openrouter('slug')` call style).
7. Channel auth: replace scaffolded `vercelOidc()/localDev()/placeholderAuth()` with a `verifyJwtHmac`-based AuthFn (+ `localDev()` dev-only).
8. Session ownership is the platform's job (map session→workspace; check on continue/stream/input/cancel).
9. Schedules fire only under `eve start` (Nitro task runner); never scale schedule-bearing agents to zero.
10. Proxies must forward **both** `/eve/` and `/.well-known/workflow/` (`/v1/flow`, `/v1/step`). ⚠️ `WORKFLOW_POSTGRES_JOB_PREFIX` does **NOT** isolate agents sharing a world DB — `reenqueueActiveRuns` ignores the prefix and re-drives other agents' runs on boot (spike/REPORT.md finding 11). Isolation plan of record: **one world Postgres schema per workflow version** (fallbacks: prefix-filtered world factory wrapper, or homogeneous agents per world); implemented with the Phase-1 compiler env-contract templates, before the Phase-3 worker pool.
11. eve HTTP API: `POST /eve/v1/session` → `{sessionId, continuationToken}`; follow-ups `POST /eve/v1/session/:id`; NDJSON stream with `?startIndex=`. Exact event JSON shapes frozen from live runs in Phase 0 → `packages/shared`.

## Architecture
- `apps/control-plane` (Bun+Elysia): Better Auth (email/pw + OIDC SSO + orgs), CRUD + workspace authz, compiler invocation, `eve build` + tarball → MinIO/S3 (cache by version hash = pillar config + compiler version + eve version), scheduler (affinity → warm → any live), dispatcher (trigger adapters → `TriggerEvent` → compiled channel, signed JWT), NDJSON tailer → `run_events` → resumable SSE.
- `apps/worker` (stateless, Node 24, mounted docker.sock): supervisor (register/heartbeat/drain; ensure-agent(hash) → pull/extract (20 GB LRU) → `PORT=p eve start`), reverse proxy (both prefixes), reapers (process idle 15 m, sandbox idle 30 m). ~20 agents/worker. Env-injected per agent: world DB URL scoped to the version's dedicated world schema (job prefix kept for observability only — it does not isolate; see correction 10), platform JWT secret, exactly one provider key, decrypted MCP secrets, cap values.
- `apps/web`: glass SPA per tokens above.
- `packages/compiler`: pure `WorkflowDefinition → {files, hash}`; `packages/db`: Drizzle schema/migrations; `packages/shared`: TriggerEvent, pillar schemas, frozen eve event types, API contracts.
- Session model: chat thread = `agent_sessions` row = one eve session (stores eve session id, continuation token, pinned workflow version, affinity worker, origin, principal). Run per inbound message/trigger.
- `@references`: compile-time (skills/connections → literal text) vs dispatch-time (`@trigger.*` → resolved from `TriggerEvent.data`, injected via `onMessage` context or message blocks).

## Data model
Better Auth tables + `mcp_connections, skills, model_presets, model_allowlist, agents, workflows, workflow_versions, workflow_builds, agent_sessions, runs, run_events, integrations, triggers (token hashes), workers`. AES-256-GCM envelope encryption for secrets. Seeds: presets (powerful `z-ai/glm-5.2` / balanced `deepseek/deepseek-v4-pro` / quick `deepseek/deepseek-v4-flash` via OpenRouter — slugs verified live), allowlist, agent presets (General Purpose, Software Engineer, Product Designer).

## Safety & security
Platform-owned provider keys; per-run wall-clock + turn caps and per-workspace concurrency (dispatcher/scheduler-enforced); webhook token hashes + rotation; Slack signature + 5-min replay window; rate limits + payload caps on ingress; role checks on mutations; secrets never in model context, logs, or `/workspace`.

## Phases (acceptance in docs/PLAN.md)
0 foundations + de-risking spike (kill-and-resume a parked run is the gate) · 1 compiler + runner spine · 2 four-pillar UI · 3 worker pool + triggers + HITL · 4 copilot. Cross-cutting: per-phase compose integration tests, Playwright E2E from Phase 2, replay chaos test as the eve-upgrade gate in CI.

---

## Superseded: agents-first pivot (2026-07-10)

The **four-pillar product model, app shell, builder layout, and session model** above are superseded by `docs/superpowers/specs/2026-07-10-agents-first-redesign.md`: the **Agent** (PERSONA · MODEL · CONTEXT) is now the first-class entity and the compile unit; chat targets Agents directly; a **Workflow** is a standing delegation (TRIGGER → AGENT → INSTRUCTIONS) with no builds of its own. That spec's §4 lists the precise sections of this document it supersedes.

The **E1 design tokens and the eve live-doc corrections above remain in force** — this was a product-model pivot, not a visual redesign or a runtime-facts change. Corrections that say "workflow version" now apply per **agent version** (one world DB per agent version; sessions pin the agent version).
