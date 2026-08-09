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
| `docs/superpowers/specs/2026-07-02-invisible-string-design.md` | Approved design: product decisions, E1 design tokens, eve live-doc corrections — as amended by the 2026-07-10 and 2026-08-07 specs (its eve API corrections are 0.19-era; the session-API surface is now the 2026-08-07 spec's) |
| `docs/superpowers/specs/2026-07-10-agents-first-redesign.md` | Agents-first redesign: concept model, IA, technical decisions, supersessions, vocabulary standard |
| `docs/superpowers/specs/2026-08-07-eve-0.31-upgrade-design.md` | eve 0.19.0 → 0.31.3 upgrade: version matrix, the forced session-API-v2 migration, republish-to-migrate, adopted 0.31 features |
| `docs/PLAN.md` | Master phase plan — update acceptance/status notes if scope shifts |
| `docs/runtime-worker-contract.md` | Control-plane ↔ worker protocol: identity, ensure/dispatch, proxy, reapers |
| `packages/compiler/README.md` + `WORLD-ISOLATION.md` | Codegen contract, `COMPILER_VERSION` discipline, world-DB isolation mechanism |
| `packages/design-tokens/README.md` | E1 design tokens source of truth (`tokens.css`), consumed by `apps/web` via `@invisible-string/design-tokens/tokens.css` |
| `spike/REPORT.md` | Empirical eve findings (numbered; later docs cite them) — append, don't rewrite |
| `packages/compiler/versions.json` | Pinned runtime version matrix + rationale notes (the source `mise.toml`'s `node` is derived from) |
| `mise.toml` | Pinned HOST toolchain (bun · node · wrangler) for dev machines and every CI job |
| `.env.example` | **Canonical inventory of every environment variable** — add new vars here with comments |
| `e2e/README.md` | Playwright harness operation |
| `docs/DEPLOY.md` | Production deployment: prod compose operation, Dokploy, external data services, backups, upgrades |
| `docs/superpowers/specs/2026-08-08-changesets-release-workflow-design.md` | Release flow: version model, changelog generation, tag/release/image pipeline |
| `.changeset/` + `CHANGELOG.md` | Pending release notes and the shipped changelog |
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

- **`mise.toml` at the repo root pins every host tool** — bun (runs the platform: control-plane, worker, web/site tooling, all tests), node (runs everything eve: `eve build` during a publish, and the compiled agent processes), and wrangler (the `apps/site` Cloudflare deploy). Setup is `mise trust && mise install`; CI does the same via `jdx/mise-action@v2`, which reads this file. Pins are EXACT, and `node` is DERIVED from `packages/compiler/versions.json` — bump both in the same commit (guard: `tests/integration/toolchain-pins.test.ts`, ungated).
- **Prefer config-driven mise invocations over fuzzy ones**: `mise install`, `mise where node`, `mise exec -- npm …` — never `node@24`. A fuzzy request resolves to the newest matching release, which may not be the pinned one, and would then win the "newest installed 24.x" race in `resolveNodeBinDir()`/`resolveNodeBin()` — silently bypassing the pin. In CI mise's shims are on `PATH`, so a bare `bun`/`node`/`npm`/`wrangler` in a workflow step is already the pinned version; no `mise exec` wrapper needed.
- At RUNTIME the apps never shell out to the mise binary: control-plane build steps and the worker both resolve a Node 24 binary directly (`BUILD_NODE_BIN`/`WORKER_NODE_BIN` override → newest mise install → PATH) — the prod images bake bare node + an `oven/bun` base and carry no mise (which is why the Dockerfiles' bun minor line is guarded against `mise.toml`). **Docker** for compose + `docker()` sandboxes.
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

E2E specs are `*.e2e.ts` under `e2e/specs/` precisely so root `bun test` never collects them. The eve spike (`spike/`) is standalone (not a workspace) — its suites run in the gated lane and are the upgrade gate for eve version bumps. One exception: `spike/tests/pins.test.ts` is deliberately UNGATED (no DB, no docker, no network) so the default lane catches spike-vs-`versions.json` drift; `spike/agent-project/package.json` is GENERATED from `versions.json` (`bun run spike/tests/sync-pins.ts`, then regenerate the lockfile with `npm install --package-lock-only` under Node 24 — never hand-edit either file).

## Releases (changesets)

Every behavior-affecting PR adds a changeset — same commit as the change, the same way docs move with code. Write the file directly rather than running `bun changeset`; the prompt walks all ten workspaces:

```md
<!-- .changeset/any-name.md -->
---
"@invisible-string/web": minor
---

Replace the markdown renderer with Streamdown.
```

- **Bump types while on 0.x**: breaking → `minor` (semver §4 — anything may change below 1.0), feature → `minor`, fix/chore → `patch`. **`major` is reserved for the deliberate 1.0.0 cut** and is not used before then.
- **Mark breaking changes** by starting the summary with `**Breaking:**`. That marker, not the bump type, is what routes an entry to the changelog's "Breaking changes" section — necessary precisely because a 0.x breaking change ships as a `minor`.
- **The summary is ONE line.** `parseChangeset` collapses the whole body into a single space-joined line, so bullets, sub-lists, and fenced code inside a summary come back out as a run-on sentence. Write one sentence (a few clauses at most) on one logical line.
- **The bold scope label in `CHANGELOG.md` is DERIVED, not authored** — it is the changeset's package names with `@invisible-string/` stripped, **sorted alphabetically**, comma-joined. Naming `web` and `shared` renders `**shared, web**`, never `**web**`; which packages you name is the only lever you have over it.
- **Name only shipped workspaces.** `@invisible-string/e2e` and `@invisible-string/integration-tests` have no `version` and are excluded. Naming one alone makes changesets exit 0 and silently never consume the file — a zombie that blocks nothing and fixes nothing; naming one alongside a shipped package fails with "Mixed changesets that contain both ignored and not ignored packages are not allowed". `bun run release:version` rejects both up front with a file-and-package message, and `tests/integration/changesets-config.test.ts` guards the config that makes the exclusion work.
- **All eight shipped workspaces share one version** (`fixed` globs), because `docs/DEPLOY.md` pins all three images with a single `IMAGE_TAG`.
- **Never `git clean -fd .changeset`.** A changeset you just wrote is untracked until you stage it, so the sweep that clears build junk deletes precisely the file the PR exists to carry — and it does so in the exact state you are in right after writing one.

Releasing is merging: pushes to `main` keep a PR titled **`chore(release): version packages`** (branch `changeset-release/main`) up to date; merging it bumps the manifests, writes `CHANGELOG.md`, tags `vX.Y.Z`, cuts the GitHub Release, and builds the GHCR images — in one workflow run, so no PAT is needed. Search for that exact title; the PR is opened by a shell step in `release.yml`, **not** by `changesets/action`, which is unusable here for the two reasons that step documents (an unguarded per-package `CHANGELOG.md` read that `changelog: false` makes fatal, and a checkout it leaves on the version branch) — do not "simplify" the step back into the action. Pushing a `v*` tag by hand still builds images, but the manifests must already be aligned to that version **in the tagged commit** or the number is burned — `release:tag` reads the comparison version out of the tag's own commit, so an alignment commit landed afterwards cannot repair it (recovery: `docs/DEPLOY.md` §10).

Two repository facts the flow depends on — check both before blaming the workflow:

1. **"Allow GitHub Actions to create and approve pull requests" must be ON** (Settings → Actions → General). This is merge-blocking, not a nicety: with it off, `gh pr create` fails with a permissions error that never names the setting, so the `version` job fails on every push that leaves changesets pending — i.e. effectively every push between releases — and releases go permanently red.
2. **The version PR runs no CI checks** — a `GITHUB_TOKEN`-opened PR does not trigger `pull_request` workflows. Benign while `main` has no branch protection; add a required status check and the version PR becomes unmergeable until the step is given a PAT or GitHub App token.

## Architecture (one screen)

`apps/control-plane` (Bun+Elysia): Better Auth (email/pw + OIDC SSO + orgs; workspace creation seeds starter Agents and fire-and-forget-publishes "General Purpose") · agent + workflow CRUD · compiler invocation + `eve build` + tarball → object store (Garage) (cache keyed by content hash = agent definition + compiler version + eve version + build-env epoch) · scheduler (session affinity → artifact-warm → any live worker; dead-worker sweep + fencing) · trigger ingress (`/t/:token`, Slack events with signature + replay window) + schedule ticker (advisory-locked cron claims, `SCHEDULE_TICK_MS`) → dispatcher (renders workflow instructions + trigger event into the task message → eve session create/continue, ID-addressed, with a version-bound JWT; the `TriggerEvent` envelope is stored on the run as provenance only) · outbound reply delivery (`DeliveryService`: Slack `chat.postMessage` off the run's terminal event, at-least-once with boot recovery) · NDJSON tailer → `run_events` → resumable SSE · copilot WS tool loop (agent + workflow editors).
`apps/worker` (stateless Bun supervisor; boots agents under Node 24; mounted docker.sock): register/heartbeat/drain, ensure-agent → pull/extract → per-agent boot of the compiled entrypoint (`node .output/server/index.mjs` directly — `eve start` is only a CLI wrapper; spike finding 6), streaming reverse proxy, reapers (process idle 15 m, sandbox idle 30 m, artifact LRU 20 GiB).
`apps/web`: the glass SPA. `apps/site`: standalone Vite + React static landing + docs SPA (MDX docs, E1 tokens via `packages/design-tokens`), deployed to Cloudflare Workers (assets-only Worker) at invisiblestring.io — no server, no compose service. `packages/{compiler,db,shared}` as labeled. Contract details: `docs/runtime-worker-contract.md`.

## Constraints that will bite you (learned empirically — full list in the design spec's "Live-doc corrections" + `spike/REPORT.md`)

- eve bakes **model routing at `eve build` time** — the build step injects a placeholder OpenRouter key so artifacts get external routing; never "clean up" that placeholder, and never let real keys into build env (allowlisted + `--ignore-scripts`).
- Proxies must forward **both** `/eve/` and `/.well-known/workflow/` or runs stall silently; world callbacks ride `/cb/<boot-token>/…` on the worker.
- **One world Postgres database per agent version** (`ag_v_<hash12>`); the graphile job prefix does NOT isolate. **Single writer per version hash** across workers — enforced by fencing + scheduler reservations; don't weaken either.
- eve sessions are **ID-addressed** (session API v2, eve 0.31): create is 202 async, follow-ups POST to `/eve/v1/session/:id` with `message` **XOR** `inputResponses`, and every session route 400s if the body carries a `continuationToken` key at all (an `in`-check, so `{continuationToken: null}` fails too). Continuation tokens are gone; `session.waiting.data.continuationToken` is a compat echo of the session id — never read it back. Shapes + guards: `packages/shared/src/eve-session-api.ts`; routes: `docs/runtime-worker-contract.md`.
- **Two 409s, opposite recoveries — never collapse them.** `session_busy` is the PLATFORM's one-run-per-session guard (`waiting` counts as busy) — transient, retry. `session_not_active` is eve's, and it is PERMANENT for that session id (unknown / terminal / reset / timed out): release the Slack thread claim and mint a fresh session; never retry. eve's truth can lag `agent_sessions.status` indefinitely, so this 409 is the second thread-key release trigger. Likewise `no_active_turn`/`no_active_session` (200 on the control routes) mean the SAME dead-session condition — not "nothing was running".
- Turn cancellation is real (`POST /eve/v1/session/:id/cancel`) and is **a user decision, never an error**: the stream settles `turn.cancelled` → `session.waiting`, the run lands `canceled` (never `failed`, and never `succeeded` — an unhandled `session.waiting` would classify it succeeded and post a truncated Slack reply). Cancellation is cooperative at durable step boundaries: an in-flight tool call still completes.
- eve 0.31 emits the compiled-agent manifest at **`.output/.eve/compile/compiled-agent-manifest.json`** (moved from the project root's `.eve/compile/`, no fallback copy) — anything reading it must use the new path.
- Compiled agents expose **only eve's default channel** — no per-trigger channels, no trigger codegen: every dispatch path (chat, webhook, form, Slack, schedule, manual run) speaks eve's session API with a control-plane-rendered task message; the `TriggerEvent` envelope never crosses the wire. Platform JWTs are per-version derived secrets (`HMAC(master, hash)`, audience `agent-version:<hash>`).
- Schedules fire from the **control-plane schedule ticker** (`SCHEDULE_TICK_MS`, per-trigger advisory-locked claims, advance-from-now = no backfill) — compiled schedule codegen is gone; it only ever ran under `eve start`, which workers never use (spike finding 6).
- Slack replies are delivered by the **control-plane DeliveryService** off the run's terminal event — `SLACK_BOT_TOKEN` must never enter agent env or generated code; agent env is identical across all dispatch paths.
- Tests never need a real provider key except the keyed lanes — the mock model rides `EVE_MOCK_AUTHORED_MODELS`; the copilot's scripted fake (`COPILOT_FAKE_SCRIPT`) is dropped in production builds.
- Version pins are exact (`packages/compiler/versions.json`): eve ↔ `@workflow/world-postgres` beta ↔ `ai@7` ↔ provider majors. Never `@latest` in generated projects; any eve bump must pass the spike suites first.
- The prod web gateway (`infra/nginx/web.conf`) enumerates the control plane's top-level route prefixes — adding a new prefix requires adding it there (else the SPA fallback swallows it).
- **Bun's default `idleTimeout` (~10 s of socket inactivity on Bun 1.3.x) must stay disabled on both servers** (`BUN_SERVE_OPTIONS` in `apps/control-plane/src/index.ts`, `idleTimeout: 0` in `apps/worker/src/server.ts`; guard: `index.test.ts`). The default kills quiet SSE run tails mid-response (heartbeats default to 15 s — `SSE_HEARTBEAT_MS`) and cuts chat dispatches awaiting a cold agent boot before headers are written, surfacing as instant gateway 502s in prod. Any new Bun server that streams or awaits >10 s needs the same treatment.
- **Adding a workspace requires adding its `package.json` COPY to every `infra/docker/*.Dockerfile`** — `bun.lock` covers all workspaces, so a missing manifest fails the in-image `bun install --frozen-lockfile` even when the image never builds that workspace (guard: `tests/integration/dockerfile-workspace-manifests.test.ts`).
- **`apps/web` markdown is Streamdown, and its Tailwind wiring fails SILENTLY.** `index.css` must `@source` `streamdown/dist/*.js` or Tailwind emits none of its utilities — prose renders unstyled and the streaming caret never appears, with no error anywhere. The path is relative to `apps/web/src/index.css` and bun does NOT hoist streamdown to the root `node_modules`, so the depth is `../node_modules/…`. Guard: `apps/web/src/__tests__/streamdown-wiring.test.ts`.
- **The seven shadcn→E1 aliases in `apps/web`'s `@theme inline` are load-bearing.** `--color-foreground`/`--color-muted*`/`--color-background`/`--color-border`/`--color-primary*` bridge streamdown's dist (written against shadcn tokens) onto the ink scale; nothing in this repo references them by name, so they look unused — deleting them silently flattens every border and muted label in a chat reply. Same guard.
- **Streamdown's `shikiTheme` prop is only a FALLBACK.** It resolves the theme as `plugins.code.getThemes() ?? shikiTheme`, so the stock `code` export of `@streamdown/code` (shiki's `github-light`/`github-dark`) silently wins and paints code blocks in a full-saturation palette E1 does not sanction — the prop then lies about what ships. Carry the themes on the plugin (`createCodePlugin({ themes })` in `apps/web/src/components/chat/Markdown.tsx`), at module scope like every other non-scalar streamdown prop. Guard: the min-theme assertion in `apps/web/src/__tests__/markdown-render.test.tsx`.

## CI (`.github/workflows/ci.yml`)

`unit` (typecheck + `bun test` + web build + site build) · `integration` (compose + gated lane incl. spike) · `acceptance` (phase-1, real eve build) · `phase3-acceptance` (multi-worker) · `e2e` (Playwright) · `prod-compose` (compose lint/drift + the prod-compose publish smoke: real images built from the tree, `eve build` runs inside the control-plane container). Keyed lanes are deliberately **not** in CI.

**Every job installs its host toolchain the same way: `- uses: jdx/mise-action@v2`, with no `with:` block** — the action reads the repo-root `mise.toml`, sets `MISE_TRUSTED_CONFIG_PATHS` + `MISE_YES`, and puts mise's shims on `PATH`, so the bare `bun`/`node`/`npm`/`wrangler` calls in later steps are the pinned versions. Do NOT add `oven-sh/setup-bun`, `actions/setup-node`, or `install_args:`/`tool_versions:` — a second toolchain or a fuzzy version defeats the pin, and `tests/integration/toolchain-pins.test.ts` fails the unit lane if one reappears. mise-action hashes `mise.toml` into its own cache key, so a version bump self-invalidates.

All jobs run on Namespace runners (`nscloud-ubuntu-24.04-amd64-*` labels). The eve npm cache (`~/.npm`) and Playwright browsers persist on a shared Namespace cache volume (tag `eve-npm`, mounted via `nscloud-cache-action` — no `actions/cache` tarball round-trips), and `release.yml` image builds use Namespace's pre-configured remote builders (no `setup-buildx-action`, no gha layer cache — cache lives builder-side). `release.yml`'s `version` job DOES need mise (it runs `bun`); its `images` job and all of `docs-sentinel.yml` do not, since neither runs a host toolchain binary.

`.github/workflows/site.yml` is a separate, deliberately non-Namespace workflow (`ubuntu-latest`): pushes to `main` touching `apps/site/**` or `packages/design-tokens/**` build the static site (`VITE_SITE_URL=https://invisiblestring.io`) and deploy it to Cloudflare Workers (assets-only Worker `invisible-string-site`, config in `apps/site/wrangler.jsonc`, SPA fallback with real 200s) via the wrangler mise pins (`npm:wrangler` in `mise.toml`, installed under mise's own data dir — not `cloudflare/wrangler-action`, whose npm fallback installs in-project and can't parse Bun's `workspace:*` protocol); pull requests touching the same paths upload a preview version (`wrangler versions upload --preview-alias <branch>`) and comment the preview URLs on the PR (fork PRs skip — no secrets). Secrets: `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID`. A static marketing/docs build needs no Namespace cache, and this keeps public-site deploys decoupled from the platform's CI runners.

## Known residuals (documented, deliberate)

Single-writer-per-hash world constraint (proper world-factory patch tracked; safe in the shipped single-worker prod compose) — and the agents-first pivot makes it HOTTER: all of an agent's chat sessions plus every workflow delegating to it concentrate on its one published version hash (one world DB, one writer) · Slack reply delivery is at-least-once (the `chat.postMessage` lands before the `delivery_status` marker settles — a crash in between re-posts the reply on boot recovery; the marker itself is CAS'd) · the schedule ticker runs in the single control-plane instance (its advisory-locked claims would survive replicas, but the rest of the control plane would not — see the runtime contract's deployment constraints) · worker PKI/mTLS attestation (allowlist + single-use dispatch tokens today) · `agent_sessions.continuation_token` and its partial index `agent_sessions_continuation_token_idx` are **dead but still in the schema**: eve 0.31 is ID-addressed so nothing writes the column, the index degenerates to empty, and per the additive-migrations rule no migration was taken — a later cleanup pass should drop both · the OpenRouter **keyed** round-trip is unproven on `@openrouter/ai-sdk-provider@3.0.0` (the spike's keyed lane is ported and typechecks but was not run — it costs real money); because 3.0.0 loads the key lazily, a keyed-path break would surface only at the first turn, so run the keyed lane before trusting a real-key deployment · no mailer (invites surface copyable links; email verification off by default locally) · build dedupe trusts `builds` rows without re-verifying the tarball still exists in the object store — wiping the store but not Postgres (e.g. a dev stack that predates the MinIO→Garage swap, or restoring a DB backup without the `garage-data` volume) strands `succeeded` builds pointing at missing artifacts until the stack is reset (`docker compose down -v`) or the rows are cleared · Better Auth session-atom staleness: no useSession subscriber lives on the auth screens, so a resolved-null snapshot survives the login/signup round-trip — the invite route probes authClient.getSession() directly, while _app/login/signup still trust snapshots (proper fix: a root-level session subscriber, then retire the per-route probe). If you resolve one, update this list and the docs that mention it.
