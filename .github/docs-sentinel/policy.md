# invisible-string documentation policy

## The rule you are enforcing

> Documentation must stay current with every change: whenever a change alters a command, port,
> env var, schema, API route, or convention that an in-scope doc describes, the affected doc must
> be updated in the same change.

This repo states the rule itself in `AGENTS.md` ("stale docs are bugs — a doc that lies is worse
than no doc") and maintains a living-docs table there mapping each document to what it owns. That
table is your map: a behavior change must be reflected in every document whose "Owns" row covers it.

## Documentation in scope (the ONLY files you may edit)

- **`AGENTS.md`** (root) — the operational contract: commands, test lanes, toolchain versions,
  architecture one-screen, empirical constraints, CI job list, known residuals. (`CLAUDE.md` is a
  symlink to this file — always edit `AGENTS.md`, never the symlink path.)
- **`README.md`** (root) — quickstart, product surfaces, copilot description, repo map.
- **`docs/DEPLOY.md`** — production deployment: prod compose, Dokploy, external data services,
  backups, upgrades.
- **`docs/PLAN.md`** — master phase plan; update acceptance/status notes if scope shifts.
- **`docs/runtime-worker-contract.md`** — control-plane ↔ worker protocol: identity,
  ensure/dispatch, proxy routes, reapers.
- **`docs/SLACK.md`** — platform Slack app: manifest, credential wiring, trigger binding.
- **`docs/screenshots/README.md`** — what each product screenshot shows and the regeneration
  command.
- **`packages/compiler/README.md`** — codegen contract, `COMPILER_VERSION` discipline, version
  pins.
- **`packages/compiler/WORLD-ISOLATION.md`** — world-DB isolation mechanism.
- **`packages/design-tokens/README.md`** — E1 design tokens source of truth.
- **`e2e/README.md`** — Playwright harness operation.
- **`apps/site/README.md`** — marketing/docs site: commands, Cloudflare Workers deploy, MDX
  authoring.
- **`apps/site/src/content/docs/**/*.mdx`** — the user-facing product docs site (quickstart,
  concepts, building guides, platform/architecture pages).
- **`.env.example`** — the canonical inventory of every environment variable, per `AGENTS.md`.
  Edit only to add/correct variable entries with explanatory comments and placeholder values.
  NEVER write a real-looking secret, token, or key value here.

## Out of scope — never touch

- `INITIAL-SPEC.md` — locked historical build brief; explicitly "do not edit" per `AGENTS.md`.
- `docs/superpowers/**` — dated design specs and implementation plans; historical records.
- `spike/REPORT.md` — append-only numbered empirical findings that other docs cite by number.
- `spike/**` and `packages/compiler/fixtures/**` — any `.md` there (instructions, skills) is a
  test fixture or compiled input, not documentation; editing fixtures changes the compiler's
  emitted bytes and breaks the golden-digest CI guard.
- `packages/compiler/versions.json` — a version-pin config consumed by code, not a doc (read it
  to verify facts; never edit it).
- `CLAUDE.md` — symlink to `AGENTS.md`.
- Any `CHANGELOG.md`, license files, lockfiles, generated output.

## Triggers worth checking specifically

Cross-reference the diff against the docs when it touches any of:

- **`package.json` scripts** (root and any workspace) — commands are quoted throughout
  `AGENTS.md`, `README.md`, `e2e/README.md`, `apps/site/README.md`.
- **Environment variables** — new/renamed `process.env` / `Bun.env` reads anywhere in `apps/**`
  or `packages/**` must appear in `.env.example`; env vars are also named in `AGENTS.md` test
  lanes and `docs/DEPLOY.md`.
- **`packages/db/src/schema/`** — DB schema; mirrored by zod contracts in `packages/shared` and
  described in `docs/runtime-worker-contract.md`.
- **`packages/shared/src/`** — shared contracts (API DTOs, WS frames, TriggerEvent, event types)
  that `AGENTS.md` and the runtime contract doc describe.
- **`apps/control-plane/src/`** route additions — `AGENTS.md` warns that every new top-level
  route prefix must also be added to `infra/nginx/web.conf`; the architecture sections of
  `AGENTS.md`, `README.md`, and `apps/site/src/content/docs/platform/architecture.mdx` describe
  the route surface (`/t/:token`, `/eve/`, `/.well-known/workflow/`, `/cb/<boot-token>/`).
- **`docker-compose*.yml` and `infra/docker/*.Dockerfile`** — service names, ports (API :3000,
  SPA :5173, prod web :8080, Postgres :5432), and the "every workspace's `package.json` must be
  COPYed into every Dockerfile" rule documented in `AGENTS.md`.
- **`.github/workflows/*.yml`** — the CI job list and runner setup are documented in
  `AGENTS.md` (§CI) and `apps/site/README.md` (site deploy).
- **`packages/compiler/src/version.ts`, `packages/compiler/versions.json`,
  `apps/control-plane/src/build/steps.ts`** — the `COMPILER_VERSION` / `BUILD_ENV_EPOCH`
  discipline and pin matrix documented in `packages/compiler/README.md` and `AGENTS.md`.
- **`packages/design-tokens/tokens.css`** — token changes affect
  `packages/design-tokens/README.md` and the E1 rules quoted in `AGENTS.md`.
- **`apps/site/wrangler.jsonc`, `apps/site/vite.config.*`, `.github/workflows/site.yml`** —
  deploy facts documented in `apps/site/README.md` and `AGENTS.md`.
- **`e2e/**` harness changes** — compose project names, ports, and env gates documented in
  `e2e/README.md` and the `AGENTS.md` test-lane table.

## How to verify facts

Read the source directly with Read/Grep/Glob — never run build, install, or dev commands:

- Commands: root and workspace `package.json` `scripts` blocks.
- Env vars: `.env.example` (inventory) vs `Grep` for `process.env.` / `Bun.env.` in `apps/**`
  and `packages/**`.
- Ports and services: `docker-compose.yml`, `docker-compose.prod.yml`, `infra/nginx/web.conf`,
  app entrypoints (`apps/control-plane/src/index.ts`, `apps/web` vite config).
- Schema: `packages/db/src/schema/`; contracts: `packages/shared/src/`.
- Version pins: `packages/compiler/versions.json` and `packages/compiler/src/version.ts`.
- CI lanes: `.github/workflows/ci.yml`, `release.yml`, `site.yml`.

When a doc and the code disagree, the code as changed in this diff is the truth to document —
but if the diff itself looks like an accidental regression (e.g. a port changed only in one of
several places), say so in your report instead of "fixing" the doc to match a mistake.
