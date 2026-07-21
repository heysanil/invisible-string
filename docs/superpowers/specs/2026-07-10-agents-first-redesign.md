# Agents-first redesign — Design (approved 2026-07-10)

**Date:** 2026-07-10 · **Status:** approved, in progress · **Scope:** platform-wide re-architecture — the Agent becomes the first-class entity and the compile unit; workflows simplify to standing delegations; docs and marketing pivot in the same effort.

This spec amends `docs/superpowers/specs/2026-07-02-invisible-string-design.md` (its **E1 design tokens and eve live-doc corrections remain in force**) and supersedes specific `INITIAL-SPEC.md` §2 locked decisions — the exact supersessions are enumerated in §4. Master plan: `docs/PLAN.md` Phase 5. No production usage exists yet, so there is **no data migration and no back-compat**: dead concepts are deleted, not deprecated.

## §1 Motivation + concept model

Today the platform is workflow-centric: users assemble **workflows** from four pillars (TRIGGER · CONTEXT · AGENT · INSTRUCTIONS), each published workflow compiles to its own eve artifact, and chat targets published workflows. "Agents" exist only as thin **agent presets** (persona + model defaults) picked inside the AGENT pillar. That inverts how people actually delegate work: you don't rebuild an assistant for every task — you set one up, equip it, and hand it work.

The canonical concept block (replaces the four-pillar table everywhere — README, docs, landing):

> **An Agent is a role you define:**
>
> | PERSONA | MODEL | CONTEXT |
> |---|---|---|
> | who it is and how it works | powerful/balanced/quick within the allowlist | MCP connections & skills it's equipped with |
>
> You **chat with Agents directly**. For standing work, delegate with a **Workflow**:
>
> | TRIGGER | → AGENT → | INSTRUCTIONS |
> |---|---|---|
> | webhook, form, Slack event, or schedule | which Agent handles it | what to do when it fires, with `@trigger` references |
>
> Every **published Agent** compiles to a real, self-hosted eve agent. A workflow builds nothing — when it fires, the platform dispatches the trigger event *and its instructions* to the bound agent version as the task message.

The **delegation metaphor is load-bearing**: an Agent is a capable assistant you equip ("Software engineer" with context7 + Figma MCP; "Compliance reviewer" with legal positioning); a Workflow is a standing delegation, the way you'd brief an assistant: "watch these Slack messages and prepare a report." The voice is acceleration-first — agents take work off people's plates; employment/replacement framing ("hire") is retired.

Approved product decisions:
1. **The Agent is the compile unit.** Workflow instructions render at **dispatch time** as the task message — publishing a workflow builds nothing.
2. **Chat binds one Agent per conversation.** New chat opens an agent picker; chat-with-workflow is deleted.
3. **Workflows attach no extra context.** The Agent's own equipment (connections, skills) is the context; instructions may reference it, never extend it.
4. **Sidebar IA** per §2.

## §2 Information architecture

- **Sidebar:** Chat · **Agents** · Workflows · Context · Settings. Agents is a new top-level section (`/agents`, `/agents/:agentId`).
- **Agents** — list (card grid: monogram, name/description, model chip, equipment count, Published/Draft/Build-failed status) + the flagship **agent editor**. The editor inherits the old builder's grammar (left rail + center editor + docked copilot) because that is the "durable thing with a draft→publish lifecycle" grammar, and the Agent is now the thing that builds. Sections: **Persona · Model · Context · Access** (run-as); rail carries "Chat with agent" and Publish-with-build-progress.
- **Workflows** — the builder collapses to a single focused column that reads like a delegation memo: *when it happens* (Trigger) → *who handles it* (Agent — card radio-group of published Agents) → *what they should do* (Instructions, with `@` autocomplete sourced from the **selected Agent's** context). Header: manual "Run now" + instant Publish (no build UI).
- **Chat** — targets Agents: picker of published Agents, thread header shows agent identity; trigger-origin sessions keep an origin chip + workflow-name provenance chip.
- **Context** — unchanged surface, reframed as the library Agents are equipped from.
- **Settings** — loses "Agent presets" (the section and its routes are deleted). Model presets + allowlist remain workspace settings.

## §3 Technical decisions

| Area | Decision |
|---|---|
| **Compile unit** | The **agent version**. Publishing an Agent compiles `AgentDefinition` (persona · model · context) → eve project → `eve build` → artifact tarball. `agent_versions` + `builds` replace `workflow_versions` + `workflow_builds`. Workflows compile nothing. |
| **Content hash** | `computeAgentHash` over definition + resolved deps (connections, skills, resolved model, options) + `agentSlug` + **`workspaceSlug`** + compiler/eve versions + build-env epoch. workspaceSlug **stays in the hash** — it is the tenant-isolation boundary for the world DB and the JWT audience. `COMPILER_VERSION` → **3.0.0** (golden fixtures regenerate in the same commit; `BUILD_ENV_EPOCH` stays 1; `versions.json` unchanged — no eve bump, so no spike re-run). |
| **World DB** | One world Postgres database per **agent version**; prefix `ws_v_` → **`ag_v_`** (`ag_v_<hash12>`). Single-writer-per-hash fencing unchanged — and hotter, since one popular Agent now carries all its chats and workflows on one world DB (Known residuals). |
| **Platform JWT** | Audience `workflow-agent:<hash>` → **`agent-version:<hash>`**; per-version derived secrets (`HMAC(master, hash)`) unchanged; the compiler's `platform.ts` stays the single source the control plane imports. |
| **Artifact shape** | Emits **only the default eve channel** (`agent/channels/eve.ts`) — no custom trigger channels, no compiled schedules, no callback or outbound-delivery code. `instructions.md` = persona + workspace-context appendix only; any `@trigger.*` in a persona is a compile error. |
| **Dispatch** | The control plane renders `taskMessage = renderTaskMessage(instructions, {message, data})` — `@trigger.*` resolves against the event data, `@connection`/`@skill` become prose literals — then drives eve's **native session API**: `createEveSession(taskMessage)`, or `continueEveSession` for Slack thread continuations. `renderTaskMessage` lives in `packages/shared` so the SPA can preview it. |
| **TriggerEvent** | **Storage-only provenance** persisted on `runs` — never sent to agents. `postTriggerEvent` is deleted from the worker client. (Webhook/form callback delivery was dead code — `PLATFORM_CALLBACK_URL` was never injected; only Slack outbound was live.) |
| **Outbound Slack delivery** | Control-plane **DeliveryService**: the tailer's terminal event carries the last stop-message; delivery posts the threaded Slack reply and marks `runs.deliveryStatus`; a boot-time recovery sweep re-delivers `pending` from persisted `run_events`. Semantics: **at-least-once** (documented residual). Moving delivery off the agent also fixes the latent bug where a warm agent process never received `SLACK_BOT_TOKEN` injected on a later ensure. |
| **Schedules** | Control-plane **cron ticker**: `cron` + `nextFireAt` on trigger rows (synced at workflow publish), fired under `pg_advisory_xact_lock` with `nextFireAt` advanced **before** dispatch (no backfill); internal pure 5-field UTC cron evaluator (no new dependency); `SCHEDULE_TICK_MS` (default 30 s). Compiled schedules were **inert in production**: they fire only under `eve start` (spike finding 17), and workers spawn `node .output/server/index.mjs` directly (spike finding 6). |
| **Workflows have no builds** | Publish = **validate** (agent exists + published; instructions non-empty; `@trigger` refs legal for the trigger type/form fields; `@connection`/`@skill` ⊆ the agent's published context) + **snapshot** `draft`→`published` + **sync trigger rows** (type, Slack binding, cron/nextFireAt). **Floating agent binding**: dispatch resolves the Agent's *current* published version; sessions and runs pin the exact `agentVersionId` used. Agent republish can strand workflow `@refs` — surfaced as a staleness diagnostic on workflow GET, never a dispatch failure. |
| **Run-as** | Moves to Agents: `agents.runAsUserId` (notNull, default creator) replaces `workflows.run_as_user_id`. Every dispatch — chat or trigger — resolves user-scoped credentials via the Agent's run-as user. |
| **Copilot** | One WS route, two surfaces: `user_message` gains `surface: "workflow" \| "agent"`. Workflow toolset `setTrigger`/`setAgent`/`setInstructions`; agent toolset `setPersona`/`setModel`/`addContext`/`removeContext`. |
| **Worker** | **Zero code changes** — the contract is `{versionHash, artifactUrl, env}` + `/agents/:hash` proxying, already agent-shaped. `WORKFLOW_POSTGRES_*` env names are the world package's contract and never rename. |

## §4 Supersessions

### INITIAL-SPEC.md §2 locked decisions

| §2 row | Locked text (abridged) | Status |
|---|---|---|
| **Runner model** | "**Compile-per-workflow on a scalable worker pool.** The **API host is the control plane**: it compiles each workflow version and runs `eve build`. **Stateless worker containers** each run *many* compiled agents concurrently (one `eve start` process per agent) and are scheduled by the control plane." | **Partially superseded.** The compile unit is now the **agent version**, not the workflow version. Control-plane compile + `eve build`, artifact caching, the stateless worker pool, and scheduling survive unchanged. (The "one `eve start` process per agent" clause was already amended empirically — workers spawn the compiled entrypoint directly; spike finding 6.) |
| **First milestone** | "**Full four-pillar scaffold** — data model + builder UI for all four pillars, with the compile→build→run loop working end to end." | **Superseded** (and historically met). The four-pillar model is retired; the product model is Agent (PERSONA · MODEL · CONTEXT) + Workflow (TRIGGER → AGENT → INSTRUCTIONS) per §1. |
| **Trigger path** | "**Hybrid.** The control plane routes + authenticates inbound events and normalizes them into a `TriggerEvent`; the compiled agent's per-trigger **eve channel** receives that envelope, starts/continues the session, and **owns outbound delivery** (e.g. posting the Slack reply)." | **Partially superseded.** Control-plane ingress survives verbatim (routing, authentication, normalization into `TriggerEvent` — now storage-only provenance). The second half dies per §3: the artifact has **no per-trigger channels**, dispatch drives eve's native session API with the rendered task message, and outbound Slack delivery moves to the control-plane DeliveryService. |
| **Chat/session model** | "**Multi-turn, sessions first-class.** A chat thread = one product `agent_session` = one eve session; follow-up messages continue it via eve continuations." | **Superseded in target.** Multi-turn, sessions-first-class, and eve continuations survive verbatim — but a chat thread now binds an **Agent** (chat-with-workflow is deleted); sessions record `agentId` + the pinned `agentVersionId`, with `workflowId` as nullable provenance. |
| **User-scoped credentials** | "**Run-as owner.** Every workflow has a `run_as` user (default: creator). Their user-scoped MCP connections are used for *all* trigger types." | **Reframed.** Run-as moves to the Agent (`agents.runAsUserId`, notNull, default creator); credential resolution is unchanged in mechanism but keyed off the Agent for every dispatch path. |
| **Model presets** | "…Agent presets pick a preset, with optional specific-model-ID override." | **Final clause superseded.** Agent presets are deleted. Workspace model presets (powerful/balanced/quick) and the allowlist survive; the Agent's own definition now carries `model: {preset, modelId?, reasoning}`. |

Every other §2 row still binds. `INITIAL-SPEC.md` itself remains an unedited historical record.

### 2026-07-02 design spec (`2026-07-02-invisible-string-design.md`)

| Section | Status |
|---|---|
| Intro (:3) — "users assemble **workflows** from four pillars…" | Superseded by §1's concept model. |
| Product decisions · App shell (:9) — dock 💬 Chat · ⚡ Workflows · 🧩 Context · ⚙ Settings | Superseded by §2: Agents becomes top-level (Chat · Agents · Workflows · Context · Settings). |
| Product decisions · Builder (:10) — left pillar-summary rail, center per-pillar editor, docked copilot | Superseded: that grammar now belongs to the **agent editor**; the workflow editor is a single delegation-memo column (§2). |
| Architecture · Session model (:42) — "chat thread = `agent_sessions` row = one eve session (… pinned workflow version …)" | Superseded: sessions pin the **agent version**; workflow is nullable provenance (§3). |
| Data model (:46) — `workflows, workflow_versions, workflow_builds`; "agent presets (General Purpose, Software Engineer, Product Designer)" | Superseded: `agent_versions` + `builds` replace the version/build tables; `agents` is a full entity (definition draft, published version, run-as) — not a preset table; the three seeds become full Agents. |
| Phases (:52) — "…2 four-pillar UI…" | Phase naming stays as historical record; new work is `docs/PLAN.md` **Phase 5**. |

Everything else in the 2026-07-02 spec — **the E1 design tokens and the eve live-doc corrections in particular — remains in force**; corrections that said "workflow version" now apply per agent version.

## §5 Vocabulary standard (normative)

| Term | Meaning | Where used |
|---|---|---|
| **Agent** (capital A) | The product entity: persona + model + context (MCP connections, skills). "You build an Agent." | All product/marketing/docs prose |
| **agent version** | Immutable published snapshot of an Agent, identified by content hash. The compile unit. Replaces "workflow version" everywhere. | Runtime/infra docs |
| **compiled agent** / **artifact** | The eve build output (tarball) of an agent version | Runtime/infra docs |
| **agent process** | The running `node .output/server/index.mjs` instance on a worker | Runtime/infra docs |
| **Workflow** | A standing delegation: trigger → Agent → instructions. Has no builds of its own. | All prose |

Rules:
1. In runtime docs, never write bare lowercase "agent" where entity-vs-process is ambiguous — pick a term from the table.
2. No environment-variable renames follow from vocabulary (`WORKFLOW_POSTGRES_*` is the world package's contract).
3. **Retired terms** (never used outside historical specs): *pillar*, *four pillars*, *agent preset*, *workflow version* (as compile unit), *chat with a workflow*, *hire* (as marketing verb).
4. Marketing verb set: **describe / build / equip / delegate** (voice principle: accelerate people's work — never employment/replacement framing; "hire" is a retired term). Tagline triplet: **"Describe. Delegate. Done."**
5. The delegation metaphor is the load-bearing explanation — lead with it.
