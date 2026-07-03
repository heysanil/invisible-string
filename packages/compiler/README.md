# @invisible-string/compiler

Pure workflow → eve-project code generation (docs/PLAN.md Phase 1 task 2).

```ts
import { compile, RUNTIME_VERSIONS } from "@invisible-string/compiler";

const { files, hash } = compile(definition, {
  versions: RUNTIME_VERSIONS,          // versions.json — the ONLY pin source
  resolvedModel: { provider: "openrouter", modelId: "deepseek/deepseek-v4-flash" },
  workspaceSlug: "acme",
  workflowSlug: "release-notes",
  agentPreset,                          // resolved `agents` row (persona, reasoning default)
  connections,                          // resolved `mcp_connections` rows
  skills,                               // resolved `skills` rows
  options: { dev: false },
});
```

`compile()` is a **pure function**: no I/O beyond its inputs, deterministic
(same input → same `files`, same `hash`), and it throws a typed
`CompileError` on any internally inconsistent input. Model resolution and
allowlist validation happen in the **control plane before compile** — the
compiler receives the already-resolved `{ provider, modelId }`.

The reference implementation for everything emitted here is the Phase-0
spike (`spike/agent-project` + `spike/REPORT.md`); the templates mirror what
it proved works against `eve@0.19.0`.

## Emitted project layout

| Path | Content |
|---|---|
| `package.json` | name `agent--<ws>--<wf>`, `engines.node "24.x"`, EXACT pins from `versions.json`, per-provider dependency. **No lockfile** — the build service owns `npm install`. |
| `tsconfig.json` | strict NodeNext config (mirrors the spike). |
| `agent/agent.ts` | explicit `model` (never eve's default), optional `reasoning`, `experimental.workflow.world = "@workflow/world-postgres"`. openrouter: provider constructed **only when `OPENROUTER_API_KEY` is set** (construction throws keyless — spike friction 4), with `OPENROUTER_BASE_URL` passthrough for mock gateways; keyless falls back to the model-id string so `eve build`/boot stay alive. anthropic resolves its key/baseURL lazily. |
| `agent/instructions.md` | agent-preset persona block `---` user instructions with compile-time refs resolved `---` generated "Workspace context" appendix (connection/skill descriptions for `connection_search`/`load_skill` routing). |
| `agent/lib/platform-auth.ts` | `platformJwt()` AuthFn (`verifyJwtHmac`, HS256, `PLATFORM_JWT_SECRET`, iss `invisible-string` / version-bound aud `workflow-agent:<hash>`) + `localDev()` **only on `options.dev` builds**. |
| `agent/lib/trigger-event.ts` | inlined `TriggerEvent` envelope + parser + `{{trigger.*}}` resolution (generated projects cannot depend on workspace packages; mirrors `packages/shared/src/trigger-event.ts`). Only emitted for form/webhook/slack triggers. |
| `agent/lib/env.ts` | `requireEnv()` helper (only when a connection needs env credentials). |
| `agent/channels/eve.ts` | default HTTP channel with platform-JWT route auth and an `onMessage` hook injecting platform context blocks (context is an onMessage **return**, never a `send()` option — PLAN correction 2). |
| `agent/channels/<trigger>.ts` | form/webhook/slack trigger channel at `POST /eve/v1/platform/<trigger>` (locked convention — raw authored paths must ride the proxy's forwarded `/eve/` prefix, spike finding 7). Verifies the platform JWT, parses the TriggerEvent, folds `event.context` + resolved `{{trigger.*}}` values into a `<trigger-context>` block, `send()`s with continuation-token passthrough, and owns outbound delivery in `message.completed`: slack → Slack Web API `chat.postMessage` (`SLACK_BOT_TOKEN`, threaded via captured `thread_ts`); form/webhook → `POST PLATFORM_CALLBACK_URL` when configured. |
| `agent/schedules/schedule.ts` | schedule triggers → `defineSchedule({ cron, markdown })` task-mode prompt. Schedules fire only under `eve start` (PLAN correction 9); task mode cannot park for approvals. |
| `agent/connections/<slug>.ts` | `defineMcpClientConnection`: literal `url`/`description`; auth via env-token `getToken` or lazy `headers` callback; `tools` exactly-one `allow`/`block`; approval `never()`/`once()`/`always()` or a generated per-tool policy matching **qualified** names (`<slug>__<tool>`). |
| `agent/skills/<slug>.md` or `<slug>/SKILL.md` (+files) | SKILL.md convention with `description` frontmatter. |

## @reference semantics

- `@<connection>` / `@skill.<slug>` resolve at **compile time** to readable
  literal text; descriptions land in the instructions appendix.
- `@trigger.<path>` stays as a `{{trigger.<path>}}` marker; the generated
  trigger channel bakes the marker list and resolves it against
  `TriggerEvent.data` at **dispatch time**.
- Unresolved refs are compile errors (drafts may be lenient; published
  versions may not). Note the grammar is purely lexical — prose `@words`
  parse as connection refs and will fail compile unless they name a
  connection; the builder mirrors this as a draft warning.
- Trigger refs are rejected for `manual`/`schedule` triggers (no dispatch
  data); `form` refs must start with a form field key; `webhook`/`slack`
  refs accept any path.

## Version hash

`hash = sha256(canonicalJson({ compilerVersion, definition, resolved deps, versions }))`

- **Covers**: the definition, `COMPILER_VERSION`, the full `versions.json`
  content, and every resolved input that shapes the emitted files (persona,
  connections, skills, model, slugs, dev flag). This is a superset of the
  PLAN's "definition + compiler version + eve version" so a cached artifact
  can never go stale invisibly — e.g. editing a skill's markdown changes the
  hash even though the definition stores only its UUID.
- **Ignores**: object key order and resolved-entry array order (both
  canonicalized).
- `computeWorkflowHash(definition, deps)` is exported for control-plane
  build-cache lookups without rendering files.

### COMPILER_VERSION bump policy

`src/version.ts` participates in the hash. **Bump it on every template
change** (anything that alters emitted bytes), then regenerate goldens:

```sh
UPDATE_GOLDEN=1 bun test packages/compiler/src/golden.test.ts   # then review the diff
```

- patch: comments/formatting of generated files
- minor: new emitted files / optional behavior
- major: changed generated-code semantics or env contract

The bump is enforced MECHANICALLY: `fixtures/.golden-digest.json` commits a
sha256 over every fixture's emitted bytes paired with the `COMPILER_VERSION`
that produced it. A template change without a bump fails
`golden.test.ts` — and `UPDATE_GOLDEN=1` refuses to rewrite the digest until
`version.ts` is bumped in the same commit.

## Runtime env contract (what generated code reads)

Injected by the worker supervisor at spawn — **secrets never appear in
generated files or artifacts**:

| Var | Read by | Notes |
|---|---|---|
| `PORT` | eve | `eve start` listen port. |
| `WORKFLOW_POSTGRES_URL` | world-postgres | **Must point at this workflow version's DEDICATED world DATABASE** (`ws_v_<hash12>`) — see `WORLD-ISOLATION.md`. Read as-is; the generated project does no URL surgery. |
| `WORKFLOW_POSTGRES_JOB_PREFIX` | world-postgres | Observability/log grouping ONLY — it does **not** isolate (spike finding 11). |
| `WORKFLOW_LOCAL_BASE_URL` | world-postgres | Point at the worker proxy so `/.well-known/workflow/v1/*` callbacks traverse the same ingress. |
| `WORKFLOW_POSTGRES_MAX_POOL_SIZE` / `WORKFLOW_POSTGRES_WORKER_CONCURRENCY` | world-postgres | Budget Postgres connections at ~20 agents/worker (spike finding 15). |
| `PLATFORM_JWT_SECRET` | channels | HS256 secret, DERIVED per version by the control plane (never the platform master). The generated verifier's audience is version-bound: `platformJwtAudienceForHash(hash)` = `workflow-agent:<hash>`; iss exported as `PLATFORM_JWT_ISSUER`. |
| `OPENROUTER_API_KEY` **or** `ANTHROPIC_API_KEY` | agent.ts | Exactly one provider key per agent. |
| `OPENROUTER_BASE_URL` / `ANTHROPIC_BASE_URL` | agent.ts / provider | Optional gateway override (mock-model harness). |
| `MCP_<SLUG_UPPER>_TOKEN` | connections | Bearer token per bearer-auth connection (`connectionTokenEnvVar(slug)`). |
| custom `MCP_*` names | connections | Header-auth connections read the env vars named in their config. |
| `SLACK_BOT_TOKEN` | slack channel | Outbound `chat.postMessage`. |
| `PLATFORM_CALLBACK_URL` / `PLATFORM_CALLBACK_TOKEN` | form/webhook channels | Optional terminal-reply delivery callback. |
| `NODE_ENV` | eve | Supervisor must pin `production` — `NODE_ENV=test` silently mocks authored models (spike finding 5). |

## Tests

```sh
bun test packages/compiler                     # unit + golden (fast, no gates)
UPDATE_GOLDEN=1 bun test src/golden.test.ts    # regenerate snapshots (review the diff!)
SPIKE_EVE_BUILD=1 bun test src/eve-build.test.ts
    # gated slow proof: renders the form fixture to a temp dir, npm-installs
    # with Node 24 (mise), tsc --noEmit passes strict, `eve build` succeeds
    # KEYLESS, and the compiled manifest registers /eve/v1/platform/form.
TEST_DATABASE_URL=… bun test src/world-isolation.test.ts
    # gated proof of the isolation contract — see WORLD-ISOLATION.md.
```
