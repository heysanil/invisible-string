# AGENTS.md — working in this repo

Operational contract for anyone (human or agent) changing this codebase. `CLAUDE.md` is a symlink to this file. Read this first; it tells you what is load-bearing, how to verify changes, and which documents are the source of truth.

**invisible-string** is a multi-tenant cloud platform for AI agents: users build **Agents** (PERSONA · MODEL · CONTEXT — MCP connections & skills) in a chat-centric SPA; each **published Agent compiles to a self-hosted [eve](https://eve.dev) agent** (`packages/compiler` → `eve build` → tarball in object storage) that runs on a stateless worker pool with Postgres-backed durability (`@workflow/world-postgres`). Users chat with Agents directly, or delegate standing work with **workflows** (TRIGGER → AGENT → INSTRUCTIONS; webhook/form/Slack/schedule) — a workflow builds nothing: at dispatch the control plane renders its instructions + the trigger event into the task message for the bound agent version. An AI copilot lives in both editors.

---

## ⚠️ IMPORTANT: keep all documentation up to date

Documentation in this repo is treated as part of the code. **Any change that alters behavior, commands, environment variables, API surface, architecture, constraints, or workflows MUST update every affected document in the same commit.** Stale docs are bugs — a doc that lies is worse than no doc.

The living documents and what each owns:

| Document | Owns |
|---|---|
| `AGENTS.md` (this file) | Operational contract: commands, lanes, conventions, constraints |
| `README.md` | Quickstart, product surfaces, copilot, repo map |
| `INITIAL-SPEC.md` | The build brief — historical record, do **not** edit (its §2 locked decisions still bind, except where superseded per the 2026-07-10 spec's §4) |
| `docs/superpowers/specs/2026-07-02-invisible-string-design.md` | Approved design: product decisions, E1 design tokens, eve live-doc corrections — as amended by the 2026-07-10 spec |
| `docs/superpowers/specs/2026-07-10-agents-first-redesign.md` | Agents-first redesign: concept model, IA, technical decisions, supersessions, vocabulary standard |
| `docs/PLAN.md` | Master phase plan — update acceptance/status notes if scope shifts |
| `docs/runtime-worker-contract.md` | Control-plane ↔ worker protocol: identity, ensure/dispatch, proxy, reapers |
| `packages/compiler/README.md` + `WORLD-ISOLATION.md` | Codegen contract, `COMPILER_VERSION` discipline, world-DB isolation mechanism |
| `packages/design-tokens/README.md` | E1 design tokens source of truth (`tokens.css`), consumed by `apps/web` via `@invisible-string/design-tokens/tokens.css` |
| `spike/REPORT.md` | Empirical eve findings (numbered; later docs cite them) — append, don't rewrite |
| `packages/compiler/versions.json` | Pinned runtime version matrix + rationale notes |
| `.env.example` | **Canonical inventory of every environment variable** — add new vars here with comments |
| `e2e/README.md` | Playwright harness operation |
| `docs/DEPLOY.md` | Production deployment: prod compose operation, Dokploy, external data services, backups, upgrades |
| `docs/SLACK.md` | Platform Slack app: manifest (`infra/slack/manifest.template.json` + drift test), credential wiring, workspace connect, trigger binding |
| `apps/site/README.md` | Marketing/docs site: commands, Cloudflare Workers deploy, MDX authoring, token-extension rules |

If you add a subsystem, add its doc and list it here. If a doc contradicts the code, fix whichever is wrong — never leave them divergent.

---

## Golden rules

1. **Commit messages never mention AI assistance** — no Claude references, no `Co-Authored-By` trailers. Conventional style: `feat(scope): …`, `fix: …`, `integrate: …`, `test(e2e): …`.
2. **Secrets never touch git, logs, or model context.** `.openrouter-key` (local provider key) and `.env` are gitignored — keep them that way. Secrets at rest use AES-256-GCM envelope encryption with AAD tenant binding (`packages/shared/src/crypto.ts`); API responses expose `hasCredentials` booleans, never values. The structured logger redacts known secret keys — use it, not `console.*`, in control-plane/worker hot paths.
3. **Migrations are additive.** New columns/tables/indexes via `bun run --cwd packages/db generate`; never edit an applied migration. Schema and Better Auth tables live only in `packages/db` (control-plane re-exports).
4. **Compiler changes have a versioning ritual.** Any edit that changes emitted bytes requires bumping `COMPILER_VERSION` (`packages/compiler/src/version.ts`) — the golden-digest guard (`fixtures/.golden-digest.json`) fails CI otherwise, and `UPDATE_GOLDEN=1` refuses to run without the bump. Build-environment changes that alter artifacts bump `BUILD_ENV_EPOCH` (`apps/control-plane/src/build/steps.ts`), which flows **through** `compile()` into the content hash (the platform-JWT audience bakes the hash — never re-key outside `compile()`).
5. **The E1 design system is law in `apps/web` and `apps/site`.** Monochrome ink × liquid glass: tokens in `packages/design-tokens/tokens.css` (consumed via `@invisible-string/design-tokens/tokens.css` by both apps), primitives in `src/components/ui` (or `apps/site`'s local equivalents) — extend them, never fork one-off styles. Color only as meaning (`#16a34a` success · `#f59e0b` waiting · `#dc2626` error). Capsule controls, 150–200 ms ease-out, `focus-visible` everywhere, designed empty/loading/error states, `prefers-reduced-motion`/`-transparency` respected. Full tokens: design spec §E1.
6. **TypeScript strict everywhere; contracts live in `packages/shared`** (zod schemas mirroring db enums). API DTOs, WS frames, TriggerEvent, eve event types — server and web both import from shared; never let them drift.
7. **Workspace scoping is mandatory on every route**: resolve the Better Auth session + active organization + role (`requireWorkspace`), verify row ownership (sessions/runs map to workspaces — eve does not enforce this), and test the authz matrix (outsider 403, member vs admin/owner ops).
8. **Verify before you claim done**: typecheck + the test lanes relevant to your change (below). If you touched runtime/worker/compiler paths, run the acceptance suites.

## Toolchain & setup

- **Bun 1.3+** runs the platform (control-plane, worker, web tooling, all tests). **Node 24 via mise** runs everything eve on dev machines/CI (`mise install node@24`; the spike/compiler harnesses invoke `mise exec node@24 --` themselves). At RUNTIME the apps never shell out to the mise binary: control-plane build steps and the worker both resolve a Node 24 binary directly (`BUILD_NODE_BIN`/`WORKER_NODE_BIN` override → newest mise install → PATH) — the prod images bake bare node and carry no mise. **Docker** for compose + `docker()` sandboxes.
- `bun install` once at the root (single lockfile). `cp .env.example .env` and fill secrets for running apps (tests provision their own env).
- Local stack: `docker compose up -d postgres garage dex` (ports overridable: `POSTGRES_PORT`/`GARAGE_PORT`/`DEX_PORT`). Test harnesses spin their own compose **projects** (`p1acceptance`, `p2e2e`, `p3acceptance`, `pkeyed`…) on non-default ports — don't reuse those names.
- Dev servers: `bun run dev` at the root does it all — bootstraps `.env` with generated secrets on first run, `docker compose up --wait`, migrations, then API (:3000) + worker + SPA (:5173) with prefixed logs; Ctrl-C stops the apps, `bun run dev:down` stops infra. Individual apps: `bun run --cwd apps/<x> dev`. Backend-free UI preview: `VITE_FIXTURE_MODE=1`. The marketing/docs site (`apps/site`) is standalone — it needs no infra and is not part of `bun run dev`; run it with `bun run --cwd apps/site dev`.

## Test lanes (run the ones your change touches)

| Lane | Command | Needs |
|---|---|---|
| Unit (default) | `bun test` | nothing — DB/key-gated suites skip cleanly |
| Typecheck | `bun run typecheck` | nothing |
| DB-gated integration | `TEST_DATABASE_URL=postgres://dev:dev@localhost:5432/product bun test` | compose up + `DATABASE_URL=… bun run --cwd packages/db migrate` |
| Real `eve build` fixtures | add `SPIKE_EVE_BUILD=1` to the gated lane | Node 24, warm npm cache |
| Phase-1 acceptance (spine) | `TEST_DATABASE_URL=… bun test tests/integration/phase1-acceptance.test.ts` | compose; self-provisions |
| Phase-3 acceptance (2 workers, failover, triggers) | `TEST_DATABASE_URL=… PHASE3_AGENT_ROOT=/tmp/invisible-string-p3-agents bun test tests/integration/phase3-acceptance.test.ts` | compose; self-provisions |
| Keyed (real model, costs cents) | `KEYED=1 OPENROUTER_API_KEY=… TEST_DATABASE_URL=… bun test tests/integration/keyed-acceptance.test.ts` | key from `.openrouter-key` |
| Copilot real-model smoke | `COPILOT_KEYED=1 OPENROUTER_API_KEY=… bun test apps/control-plane/src/copilot/keyed.test.ts` | key |
| Browser E2E | `cd e2e && bunx playwright test` | chromium installed; harness self-manages its whole stack |
| Prod-compose smoke (in-container publish) | `PROD_SMOKE=1 bun test tests/integration/prod-compose-smoke.test.ts` | docker; builds the real images (`-p psmoke`, web on :8080) and publishes through them — the guard against code↔image drift |

E2E specs are `*.e2e.ts` under `e2e/specs/` precisely so root `bun test` never collects them. The eve spike (`spike/`) is standalone (not a workspace) — its suites run in the gated lane and are the upgrade gate for eve version bumps.

## Architecture (one screen)

`apps/control-plane` (Bun+Elysia): Better Auth (email/pw + OIDC SSO + orgs; workspace creation seeds starter Agents and fire-and-forget-publishes "General Purpose") · agent + workflow CRUD · compiler invocation + `eve build` + tarball → object store (Garage) (cache keyed by content hash = agent definition + compiler version + eve version + build-env epoch) · scheduler (session affinity → artifact-warm → any live worker; dead-worker sweep + fencing) · trigger ingress (`/t/:token`, Slack events with signature + replay window) + schedule ticker (advisory-locked cron claims, `SCHEDULE_TICK_MS`) → dispatcher (renders workflow instructions + trigger event into the task message → eve session create/continue with a version-bound JWT; the `TriggerEvent` envelope is stored on the run as provenance only) · outbound reply delivery (`DeliveryService`: Slack `chat.postMessage` off the run's terminal event, at-least-once with boot recovery) · NDJSON tailer → `run_events` → resumable SSE · copilot WS tool loop (agent + workflow editors).
`apps/worker` (stateless Bun supervisor; boots agents under Node 24; mounted docker.sock): register/heartbeat/drain, ensure-agent → pull/extract → per-agent boot of the compiled entrypoint (`node .output/server/index.mjs` directly — `eve start` is only a CLI wrapper; spike finding 6), streaming reverse proxy, reapers (process idle 15 m, sandbox idle 30 m, artifact LRU 20 GiB).
`apps/web`: the glass SPA. `apps/site`: standalone Vite + React static landing + docs SPA (MDX docs, E1 tokens via `packages/design-tokens`), deployed to Cloudflare Workers (assets-only Worker) at invisiblestring.io — no server, no compose service. `packages/{compiler,db,shared}` as labeled. Contract details: `docs/runtime-worker-contract.md`.

## Constraints that will bite you (learned empirically — full list in the design spec's "Live-doc corrections" + `spike/REPORT.md`)

- eve bakes **model routing at `eve build` time** — the build step injects a placeholder OpenRouter key so artifacts get external routing; never "clean up" that placeholder, and never let real keys into build env (allowlisted + `--ignore-scripts`).
- Proxies must forward **both** `/eve/` and `/.well-known/workflow/` or runs stall silently; world callbacks ride `/cb/<boot-token>/…` on the worker.
- **One world Postgres database per agent version** (`ag_v_<hash12>`); the graphile job prefix does NOT isolate. **Single writer per version hash** across workers — enforced by fencing + scheduler reservations; don't weaken either.
- eve session create is **202 async**; one run per session at a time (`409 session_busy`, and `waiting` counts as busy).
- Compiled agents expose **only eve's default channel** — no per-trigger channels, no trigger codegen: every dispatch path (chat, webhook, form, Slack, schedule, manual run) speaks eve's session API with a control-plane-rendered task message; the `TriggerEvent` envelope never crosses the wire. Platform JWTs are per-version derived secrets (`HMAC(master, hash)`, audience `agent-version:<hash>`).
- Schedules fire from the **control-plane schedule ticker** (`SCHEDULE_TICK_MS`, per-trigger advisory-locked claims, advance-from-now = no backfill) — compiled schedule codegen is gone; it only ever ran under `eve start`, which workers never use (spike finding 6).
- Slack replies are delivered by the **control-plane DeliveryService** off the run's terminal event — `SLACK_BOT_TOKEN` must never enter agent env or generated code; agent env is identical across all dispatch paths.
- Tests never need a real provider key except the keyed lanes — the mock model rides `EVE_MOCK_AUTHORED_MODELS`; the copilot's scripted fake (`COPILOT_FAKE_SCRIPT`) is dropped in production builds.
- Version pins are exact (`packages/compiler/versions.json`): eve ↔ `@workflow/world-postgres` beta ↔ `ai@7` ↔ provider majors. Never `@latest` in generated projects; any eve bump must pass the spike suites first.
- The prod web gateway (`infra/nginx/web.conf`) enumerates the control plane's top-level route prefixes — adding a new prefix requires adding it there (else the SPA fallback swallows it).
- **Bun's default `idleTimeout` (~10 s of socket inactivity on Bun 1.3.x) must stay disabled on both servers** (`BUN_SERVE_OPTIONS` in `apps/control-plane/src/index.ts`, `idleTimeout: 0` in `apps/worker/src/server.ts`; guard: `index.test.ts`). The default kills quiet SSE run tails mid-response (heartbeats default to 15 s — `SSE_HEARTBEAT_MS`) and cuts chat dispatches awaiting a cold agent boot before headers are written, surfacing as instant gateway 502s in prod. Any new Bun server that streams or awaits >10 s needs the same treatment.
- **Adding a workspace requires adding its `package.json` COPY to every `infra/docker/*.Dockerfile`** — `bun.lock` covers all workspaces, so a missing manifest fails the in-image `bun install --frozen-lockfile` even when the image never builds that workspace (guard: `tests/integration/dockerfile-workspace-manifests.test.ts`).

## CI (`.github/workflows/ci.yml`)

`unit` (typecheck + `bun test` + web build + site build) · `integration` (compose + gated lane incl. spike) · `acceptance` (phase-1, real eve build) · `phase3-acceptance` (multi-worker) · `e2e` (Playwright) · `prod-compose` (compose lint/drift + the prod-compose publish smoke: real images built from the tree, `eve build` runs inside the control-plane container). Keyed lanes are deliberately **not** in CI.

All jobs run on Namespace runners (`nscloud-ubuntu-24.04-amd64-*` labels). The eve npm cache (`~/.npm`) and Playwright browsers persist on a shared Namespace cache volume (tag `eve-npm`, mounted via `nscloud-cache-action` — no `actions/cache` tarball round-trips), and `release.yml` image builds use Namespace's pre-configured remote builders (no `setup-buildx-action`, no gha layer cache — cache lives builder-side).

`.github/workflows/site.yml` is a separate, deliberately non-Namespace workflow (`ubuntu-latest`): pushes to `main` touching `apps/site/**` or `packages/design-tokens/**` build the static site (`VITE_SITE_URL=https://invisiblestring.io`) and deploy it to Cloudflare Workers (assets-only Worker `invisible-string-site`, config in `apps/site/wrangler.jsonc`, SPA fallback with real 200s) via a pinned `npx -y wrangler@<x.y.z>` (not `cloudflare/wrangler-action` — its npm fallback can't parse Bun's `workspace:*` protocol); pull requests touching the same paths upload a preview version (`wrangler versions upload --preview-alias <branch>`) and comment the preview URLs on the PR (fork PRs skip — no secrets). Secrets: `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`. A static marketing/docs build needs no Namespace cache, and this keeps public-site deploys decoupled from the platform's CI runners.

## Known residuals (documented, deliberate)

Single-writer-per-hash world constraint (proper world-factory patch tracked; safe in the shipped single-worker prod compose) — and the agents-first pivot makes it HOTTER: all of an agent's chat sessions plus every workflow delegating to it concentrate on its one published version hash (one world DB, one writer) · Slack reply delivery is at-least-once (the `chat.postMessage` lands before the `delivery_status` marker settles — a crash in between re-posts the reply on boot recovery; the marker itself is CAS'd) · the schedule ticker runs in the single control-plane instance (its advisory-locked claims would survive replicas, but the rest of the control plane would not — see the runtime contract's deployment constraints) · worker PKI/mTLS attestation (allowlist + single-use dispatch tokens today) · `@openrouter/ai-sdk-provider` pinned to the only `ai@7`-compatible line (alpha) · no mailer (invites surface copyable links; email verification off by default locally) · build dedupe trusts `builds` rows without re-verifying the tarball still exists in the object store — wiping the store but not Postgres (e.g. a dev stack that predates the MinIO→Garage swap, or restoring a DB backup without the `garage-data` volume) strands `succeeded` builds pointing at missing artifacts until the stack is reset (`docker compose down -v`) or the rows are cleared · Better Auth session-atom staleness: no useSession subscriber lives on the auth screens, so a resolved-null snapshot survives the login/signup round-trip — the invite route probes authClient.getSession() directly, while _app/login/signup still trust snapshots (proper fix: a root-level session subscriber, then retire the per-route probe). If you resolve one, update this list and the docs that mention it.
