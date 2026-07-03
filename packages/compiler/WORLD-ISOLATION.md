# World isolation — verified contract (design correction #10)

**Contract: ONE WORLD POSTGRES *DATABASE* PER WORKFLOW VERSION.**
The generated project reads `WORKFLOW_POSTGRES_URL` **as-is**; the control
plane provisions a dedicated database `ws_v_<hash12>` (first 12 hex chars
of the workflow-version hash) on the world Postgres server, runs the
world-postgres bootstrap against it once, and passes a URL whose *database
name* pins the version. `WORKFLOW_POSTGRES_JOB_PREFIX` is set for
observability only — it does **not** isolate.

## Why not schema-per-version via `search_path`? (verified — it does NOT work)

The plan of record was a schema `ws_v_<hash12>` pinned via the connection
string's `search_path`. Verified against the shipped package
(`spike/agent-project/node_modules/@workflow/world-postgres@5.0.0-beta.20`),
world-postgres does not honor it:

1. **Drizzle schema is hard-qualified.**
   `dist/drizzle/schema.js:13` → `export const schema = pgSchema('workflow')`.
   Every query the world issues references `"workflow"."workflow_runs"` etc.
   with an explicit schema qualifier; `search_path` is never consulted for
   qualified identifiers.
2. **Migrations are hard-qualified too.**
   `src/drizzle/migrations/0000_….sql` runs `CREATE SCHEMA "workflow"` and
   `CREATE TABLE "workflow"."workflow_runs" (…)` — bootstrap lands in
   `workflow` regardless of the URL's `options=-csearch_path=…`. (It also
   creates enum TYPES in `"public"`, another cross-schema leak.)
3. **No schema knob exists.** `dist/config.js` (`PostgresWorldConfig`) offers
   `connectionString`/`pool`, `jobPrefix`, `namespace`, concurrency — no
   schema option. graphile-worker likewise runs in its fixed
   `graphile_worker` schema.
4. The **gated test proves it live** (`src/world-isolation.test.ts`, part 1):
   bootstrapping with `?options=-csearch_path=ws_v_…,public` still creates
   every table in `workflow` and leaves the pinned schema empty. (Pinning
   the schema WITHOUT `public` fails harder: bootstrap crashes on the
   migration's unqualified `"status"` enum reference — the enum types live
   in `public` — so search_path cannot even complete a bootstrap, let alone
   isolate one.)

So the two candidate fallbacks resolved as:
- ~~schema-qualified via `options` param~~ — impossible; identifiers are
  compile-time qualified inside the package (drizzle `pgSchema` + raw SQL).
- **dedicated database per version** — chosen; provable, zero patching.

## Why isolation is load-bearing (not hygiene)

`eve start` re-enqueues **ALL** `pending`/`running` runs found in the
connected world storage on every boot: `dist/index.js:47` calls
`reenqueueActiveRuns(storage.runs, queue.queue, 'world-postgres')` from
`@workflow/world`, which lists active runs **with no job-prefix filter** and
re-drives them under the booting process's own queue prefix. Two different
agents sharing one world DB therefore steal each other's runs at boot
(observed live — spike/REPORT.md finding 11). A database boundary is the
unit Postgres actually enforces and the only input world-postgres accepts.

The **gated test proves the fix** (part 2): two databases on one server are
bootstrapped; an active (`running`) row planted in A is invisible to B's
`workflow_runs` — a booting agent pointed at its own `ws_v_<hash12>`
database can never see (or re-drive) another version's runs.

## Operational notes for the supervisor / build service (Phase-1/3 consumers)

- Naming + provisioning are implemented control-plane-side in
  `apps/control-plane/src/build/world.ts` (`worldNameForHash` →
  `ws_v_<first 12 hash chars>`); this document is the contract it satisfies.
- Provision: `CREATE DATABASE "ws_v_<hash12>"` (idempotent check first),
  then `node_modules/@workflow/world-postgres/bin/setup.js` with
  `WORKFLOW_POSTGRES_URL` pointing at it (runs drizzle migrations + the
  graphile-worker bootstrap; safe to re-run).
- Connection budget: each agent process opens its own pools — set
  `WORKFLOW_POSTGRES_MAX_POOL_SIZE` / `WORKFLOW_POSTGRES_WORKER_CONCURRENCY`
  per agent (spike finding 15) and budget `~20 agents/worker × pool size`
  against the server's `max_connections`.
- Old versions: dropping a retired version's database (`DROP DATABASE …
  WITH (FORCE)`) is the whole cleanup story — no cross-version rows exist.
  A later republish of the identical config is a build-cache hit, so the
  build service verifies the world DB still exists on the cached path and
  falls through to a full rebuild (which re-provisions) when it was dropped.
- Ownership guard: `ensure()` records the FULL content hash in a
  `_invisible_string_world_owner` table inside each world DB and fails
  loudly if an existing database belongs to a different hash — a 12-char
  truncation collision must never silently share a world.
- Same-version processes: multiple workers may serve the SAME version
  concurrently against its shared per-version DB; that is homogeneous and
  safe by design (re-enqueue re-drives only that version's runs).

## Re-verify on every eve / world-postgres bump

```sh
TEST_DATABASE_URL=postgres://dev:dev@localhost:5432/product \
  bun test packages/compiler/src/world-isolation.test.ts
```

(Needs `@workflow/world-postgres` installed — `npm ci` in
`spike/agent-project`, or point `WORLD_POSTGRES_PACKAGE_DIR` at any install —
and a DB user allowed to `CREATE DATABASE`.) If a future world-postgres
gains a real schema/namespace option or a prefix-filtered re-enqueue,
revisit this contract; until then database-per-version is the plan of
record.
