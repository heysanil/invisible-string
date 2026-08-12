# @invisible-string/compiler

Pure agent → eve-project code generation — **the Agent is the compile unit**.
Input is an `AgentDefinition` (PERSONA · MODEL · CONTEXT from
`packages/shared`); workflows carry no builds. Triggers and workflow
instructions are NOT compile-time inputs: the control plane renders them into
the task message at dispatch (`renderTaskMessage` in `packages/shared`).

```ts
import { compile, RUNTIME_VERSIONS } from "@invisible-string/compiler";

const { files, hash } = compile(definition, {   // definition: AgentDefinition
  versions: RUNTIME_VERSIONS,          // versions.json — the ONLY pin source
  resolvedModel: {                      // preset/override ALREADY resolved
    provider: "openrouter",
    modelId: "~deepseek/deepseek-v4-flash-latest",
    reasoning: "max",                   // required; "provider-default" = omit
  },
  workspaceSlug: "acme",
  agentSlug: "software-engineer",
  connections,                          // resolved `connections` rows
  skills,                               // resolved `skills` rows
  options: { dev: false },
});
```

`compile()` is a **pure function**: no I/O beyond its inputs, deterministic
(same input → same `files`, same `hash`), and it throws a typed
`CompileError` on any internally inconsistent input. Model resolution and
allowlist validation happen in the **control plane before compile** — the
compiler receives the already-resolved `{ provider, modelId, reasoning }`.

**The reasoning effort is resolved upstream too.**
`definition.model.reasoning` is an OPTIONAL override (`undefined` = inherit —
the preset's effort, or `provider-default` behind a `modelId` override); the
compiler emits `deps.resolvedModel.reasoning` and only checks consistency (an
explicit definition effort must equal the resolved one, mirroring the
`modelId` `MODEL_MISMATCH` guard). Because the resolved effort is part of the
hash, two identical definitions inheriting different preset efforts get
different artifacts — and re-pointing a preset's effort takes effect on the
next **publish**, never for an already-published version.

The reference implementation for everything emitted here is the Phase-0
spike (`spike/agent-project` + `spike/REPORT.md`); the templates mirror what
it proved works against `eve@0.31.3` (the spike suites are the upgrade gate
for every eve bump — AGENTS.md).

## Emitted project layout

The artifact is **trigger-agnostic**: `agent/channels/eve.ts` is the only
channel — no trigger channels, no schedules, no outbound-delivery libs.
Chat and workflow dispatch both ride the default eve channel; schedule
firing and Slack reply delivery live in the control plane.

| Path | Content |
|---|---|
| `package.json` | name `agent--<ws>--<agent>`, `engines.node "24.x"`, EXACT pins from `versions.json`, per-provider dependency. **No lockfile** — the build service owns `npm install`. |
| `tsconfig.json` | strict NodeNext config (mirrors the spike). |
| `agent/agent.ts` | explicit `model` (never eve's default), the resolved reasoning effort (below), an explicit `limits` block (below), `experimental.workflow.world = "@workflow/world-postgres"`. openrouter: provider constructed **only when `OPENROUTER_API_KEY` is set**, with `OPENROUTER_BASE_URL` passthrough for mock gateways; keyless falls back to the model-id string, which is what makes eve bake **gateway** routing so `eve build`/boot stay alive. anthropic resolves its key/baseURL lazily. |
| `agent/instructions.md` | the persona with compile-time refs resolved, then — only when the agent has context — a `---`-separated generated "Workspace context" appendix (connection/skill descriptions for `connection_search`/`load_skill` routing). Nothing else — workflow instructions never appear here. |
| `agent/lib/platform-auth.ts` | `platformJwt()` AuthFn (`verifyJwtHmac`, HS256, `PLATFORM_JWT_SECRET`, iss `invisible-string` / version-bound aud `agent-version:<hash>`) + `localDev()` **only on `options.dev` builds**. |
| `agent/lib/env.ts` | `requireEnv()` helper (only when at least one connection authenticates — bearer/headers read env vars, and the OAuth platform-token lib imports it too). |
| `agent/lib/platform-token.ts` | `platformConnectionToken(connectionId)` — emitted only for OAuth connections; self-mints an HS256 platform JWT and fetches short-lived access tokens from the control-plane broker `POST /internal/connections/token` (reads `PLATFORM_API_URL` + `PLATFORM_JWT_SECRET` lazily inside the call so keyless `eve build` never crashes; no OAuth material in agent env). |
| `agent/channels/eve.ts` | default HTTP channel — the ONLY channel — with platform-JWT route auth and an `onMessage` hook injecting platform context blocks (identity line `Platform agent "<agent>" in workspace "<ws>"`; context is an onMessage **return**, never a `send()` option — PLAN correction 2). |
| `agent/connections/<slug>.ts` | `defineMcpClientConnection`: literal `url`/`description`; auth via env-token `getToken`, lazy `headers` callback, or broker-delivered `getToken` (`platformConnectionToken`, OAuth connections — no OAuth material in agent env); `tools` exactly-one `allow`/`block`; approval `never()`/`once()`/`always()` or a generated per-tool policy matching **qualified** names (`<slug>__<tool>`). |
| `agent/skills/<slug>.md` or `<slug>/SKILL.md` (+files) | SKILL.md convention with `description` frontmatter. |

### Reasoning effort: `extraBody` on OpenRouter, `reasoning:` on Anthropic

| Resolved effort | openrouter emits | anthropic emits |
|---|---|---|
| `max` | `openrouter(MODEL_ID, { extraBody: { reasoning: { effort: "max" } } })` | `reasoning: "xhigh"` (clamped) |
| any other effort | `…{ extraBody: { reasoning: { effort: "<effort>" } } }` | `reasoning: "<effort>"` |
| `provider-default` | `openrouter(MODEL_ID)` — **no settings object at all** | *field omitted entirely* |

The asymmetry is not stylistic. eve's `reasoning:` config reaches ai@7 as the
top-level `LanguageModelV4CallOptions.reasoning` call option, and
`@openrouter/ai-sdk-provider@3.0.0`'s `getArgs()` **never destructures it** —
through that route every OpenRouter agent's effort was silently dropped
(fixed in `COMPILER_VERSION` 4.0.0). The provider's own typed `reasoning`
*setting* does reach the wire, but its effort union is
`xhigh|high|medium|low|minimal|none` — no `max`, which is exactly the top
effort OpenRouter advertises for the seeded models. `settings.extraBody` is
spread **last** over the request body, so it wins. Anthropic keeps the config
route: `@ai-sdk/anthropic` is spec-v4 and eve maps the effort onto a thinking
budget.

Two accepted losses on OpenRouter: the **keyless/gateway** branch carries no
effort (there is no model object to hang settings on), and eve's agent-info
introspection route — which reports `config.reasoning` — no longer sees one.

`provider-default` exists because `ResolvedModel.reasoning` is required:
without it every artifact would send a reasoning block, including on the ~1/3
of catalog models with no reasoning support, where OpenRouter's behavior is
unverified.

### Explicit runtime limits

`agent/agent.ts` emits a `limits` block pinning the two defaults eve 0.31
applies **whether or not an agent configures them**:

| Field | Emitted | Why |
|---|---|---|
| `maxInputTokensPerSession` | `40_000_000` | eve's own root-session default. Crossing it is not fatal: a conversation-mode session parks on a deterministic Approve/Stop prompt (`input.requested`, `kind: "session-limit"`), answered through the normal HITL path; a task-mode run with no input channel fails the next model call with `SESSION_TOKEN_LIMIT_REACHED`. |
| `sessionTimeoutMs` | `2_592_000_000` (30 days) | eve's own default session lifetime. The deadline starts at session creation and survives restarts/redeploys; an in-flight turn settles, then eve emits `session.completed` and the next message starts a fresh session. |
| `maxOutputTokensPerSession` | *omitted* | eve applies **no** default (unset ≡ uncapped), so there is no silent default to pin. Omission and `false` are different values. |

Pinning them makes the runtime envelope part of the artifact: without the
block a future eve release could move every published agent's budget with no
`COMPILER_VERSION` bump, no rebuild, and no hash change. These are **platform
constants** — per-agent spend limits in the agent editor are out of scope.

### The keyless OpenRouter guard (do not simplify it)

`resolveModel()` builds the provider model only when `OPENROUTER_API_KEY` is
set and otherwise returns the model-id **string**. That conditional is
load-bearing and is no longer backstopped by a build-time failure:
`@openrouter/ai-sdk-provider@3.0.0` resolves the key **lazily**, so
`openrouter("<id>")` constructs fine without a key and raises
`AI_LoadAPIKeyError` only at the first model call. (The 6.0.0-alpha.1 line
threw at construction — that is what spike friction 4 recorded, and it no
longer holds.) Drop the guard and a keyless build would emit a provider model
with **external** routing baked in, `eve build` would exit 0, the agent would
boot — and its first turn would die. With the guard, keyless builds bake
**gateway** routing and are genuinely servable.

## @reference semantics

- In a **persona** (this package): `@<connection>` / `@skill.<slug>` resolve
  at **compile time** to readable literal text against the agent's own
  context; descriptions land in the instructions appendix. Unresolved refs
  are compile errors (`UNRESOLVED_REFERENCE`; drafts may be lenient,
  published versions may not). The grammar is purely lexical — prose
  `@words` parse as connection refs and fail compile unless they name a
  connection; the agent editor mirrors this as a draft warning.
- **Any `@trigger.*` ref in a persona is a compile error**
  (`TRIGGER_REF_NOT_ALLOWED`): agents are trigger-agnostic — `@trigger`
  references belong in workflow instructions, where the control plane
  resolves them against the trigger event at **dispatch time**
  (`renderTaskMessage`, packages/shared).
- An empty persona is a compile error (`EMPTY_PERSONA`) — valid as a draft,
  unpublishable.

## Version hash

`hash = sha256(canonicalJson({ buildEnv, compilerVersion, definition, resolved, versions }))`

- **Covers**: the `AgentDefinition`, `COMPILER_VERSION`, the caller's
  build-env epoch, the full `versions.json` content, and every resolved
  input that shapes the emitted files (connections, skills, model,
  `agentId`, `agentSlug`, `workspaceSlug`, dev flag). This is a superset of
  the PLAN's "definition + compiler version + eve version" so a cached
  artifact can never go stale invisibly — e.g. editing a skill's markdown
  changes the hash even though the definition stores only its UUID.
- **`agentId` is the IDENTITY input** (2026-08-11 lifecycle spec D1): the
  `agents.id` uuid, never emitted into a generated file. Two agents in one
  workspace with the same display name and the same definition must land on
  different artifacts — before D1 they hashed identically and shared one
  `ag_v_<hash12>` world database, and the only thing preventing that was the
  unique index `agents_organization_id_name_uidx` (now dropped). A display
  string is not identity.
- **`agentSlug` still participates too**, for a different reason: it is
  emitted (generated package name, the model-visible identity line in
  `agent/channels/eve.ts`), and no input that changes emitted bytes may
  leave the hash unmoved. So renaming an agent still re-keys its artifact,
  world DB, and JWT audience on the next publish — known churn, out of scope
  per the spec's §7.
- **`workspaceSlug` participates deliberately** (tenant isolation):
  identical agent configs in two workspaces must never share an artifact,
  world database, or JWT audience.
- **Ignores**: object key order and resolved-entry array order (both
  canonicalized).
- `computeAgentHash(definition, deps)` is exported for control-plane
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

**3.0.0 is the agents-first major**: compile unit `WorkflowDefinition` →
`AgentDefinition`, trigger channels/schedules/outbound libs deleted, JWT
audience `workflow-agent:` → `agent-version:`, hash inputs re-keyed — every
version hash changes.

**3.1.0 is the eve 0.31.3 minor**: the explicit `limits` block plus the
corrected keyless-guard comment (which ships inside the generated file, so it
is an emitted-bytes change, not a source-only edit). Semantics and env
contract are unchanged — the emitted limits equal what eve already enforced.

**4.0.0 is the reasoning-effort major**: the effort now comes from
`deps.resolvedModel.reasoning` (so inheritance participates in the hash)
instead of `definition.model.reasoning`, and on OpenRouter it moved from
eve's dropped `reasoning:` config onto the model's `extraBody` — a genuine
change in what the artifact sends. `provider-default` suppresses the field on
both providers, anthropic clamps `max` → `xhigh`, and
`OPENROUTER_CONTEXT_WINDOW_TOKENS` gained the two new seeded models
(`moonshotai/kimi-k3`, `~deepseek/deepseek-v4-flash-latest`) while keeping the
older entries so existing versions recompile byte-identically.
`BUILD_ENV_EPOCH` is deliberately untouched: the change is inside `compile()`,
which `COMPILER_VERSION` already re-keys.

**4.1.0 is the broker-delivered-OAuth minor**: oauth-auth connections
(`auth.kind === "oauth"`) emit an `auth.getToken` that calls the new
`agent/lib/platform-token.ts`, which self-mints an HS256 platform JWT and
fetches short-lived access tokens from the control plane's
`POST /internal/connections/token` (two lazy env reads — the new
`PLATFORM_API_URL` and the existing `PLATFORM_JWT_SECRET` — so keyless
`eve build` still never crashes; no OAuth material in agent env or generated
files). New emitted file → minor; bearer/headers/none emissions are
byte-identical, though every version hash shifts because `COMPILER_VERSION`
participates.

**5.0.0 is the agent-identity major**: `CompileDeps` gains a REQUIRED
`agentId` (the `agents.id` uuid) and the hash keys identity on it rather than
on the slugified display name alone. No template changed — the only emitted
bytes that move are the baked audience in `agent/lib/platform-auth.ts` — but
the compile INPUT gained a required field and **every** existing artifact is
re-keyed, so the first publish of each agent after deploy runs a real
`eve build` instead of hitting cache (operational note in `docs/DEPLOY.md`).
`agentSlug` keeps feeding codegen *and* the hash; `BUILD_ENV_EPOCH` is
untouched (the build environment is unchanged).

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
| `PORT` | eve | listen port. |
| `WORKFLOW_POSTGRES_URL` | world-postgres | **Must point at this agent version's DEDICATED world DATABASE** — see `WORLD-ISOLATION.md`. Read as-is; the generated project does no URL surgery. |
| `WORKFLOW_POSTGRES_JOB_PREFIX` | world-postgres | Observability/log grouping ONLY — it does **not** isolate (spike finding 11). |
| `WORKFLOW_LOCAL_BASE_URL` | world-postgres | Point at the worker proxy so `/.well-known/workflow/v1/*` callbacks traverse the same ingress. |
| `WORKFLOW_POSTGRES_MAX_POOL_SIZE` / `WORKFLOW_POSTGRES_WORKER_CONCURRENCY` | world-postgres | Budget Postgres connections at ~20 agents/worker (spike finding 15). |
| `PLATFORM_JWT_SECRET` | eve channel | HS256 secret, DERIVED per version by the control plane (never the platform master). The generated verifier's audience is version-bound: `platformJwtAudienceForHash(hash)` = `agent-version:<hash>`; iss exported as `PLATFORM_JWT_ISSUER`. |
| `OPENROUTER_API_KEY` **or** `ANTHROPIC_API_KEY` | agent.ts | Exactly one provider key per agent. |
| `OPENROUTER_BASE_URL` / `ANTHROPIC_BASE_URL` | agent.ts / provider | Optional gateway override (mock-model harness). |
| `MCP_<SLUG_UPPER>_TOKEN` | connections | Bearer token per bearer-auth connection (`connectionTokenEnvVar(slug)`). |
| custom `MCP_*` names | connections | Header-auth connections read the env vars named in their config. |
| `PLATFORM_API_URL` | platform-token lib (oauth connections) | Control-plane base URL as seen from the worker network; the broker-delivered `getToken` posts `/internal/connections/token` here. Optional — absent, oauth tool calls fail with a missing-env error, nothing else breaks. |
| `NODE_ENV` | eve | Supervisor must pin `production` — `NODE_ENV=test` silently mocks authored models (spike finding 5). |

## Tests

```sh
bun test packages/compiler                     # unit + golden (fast, no gates)
UPDATE_GOLDEN=1 bun test src/golden.test.ts    # regenerate snapshots (review the diff!)
SPIKE_EVE_BUILD=1 bun test src/eve-build.test.ts
    # gated slow proof: renders every fixture to a temp dir, npm-installs
    # with Node 24 (mise), tsc --noEmit passes strict, and the basic
    # (default-eve-channel-only) + mcp-skill (packaged skill) fixtures
    # `eve build` KEYLESS to servable .output bundles. Also runs the WIRE
    # PROBE (src/wire-probe.mjs) — see below.
TEST_DATABASE_URL=… bun test src/world-isolation.test.ts
    # gated proof of the isolation contract — see WORLD-ISOLATION.md.
```

Golden fixtures (`fixtures/<name>/`): `basic` (persona only; INHERITS its
effort — no `reasoning` in the definition — resolving to `max`), `mcp-skill`
(bearer connection + packaged skill; explicit `high`), `custom-approval`
(headers auth + custom approval policy + tool filters; `provider-default`,
pinning the OpenRouter suppression branch), `flat-skill` (markdown-only skill
→ flat `agent/skills/<slug>.md` + the seeded "powerful" preset model
z-ai/glm-5.2, pinning its context-window entry; keeps the legacy `medium`
effort so pre-existing definitions stay provably compilable),
`anthropic-model` (anthropic provider + matching modelId override, dev build;
`max`, pinning the → `xhigh` clamp), `oauth-connection` (oauth broker-delivered
connection via `platformConnectionToken` — pins the `agent/lib/platform-token.ts`
emission and the oauth `auth` branch no other fixture reaches; `balanced` preset,
`deepseek/deepseek-v4-pro`, `high`).

### The wire probe (`src/wire-probe.mjs`)

String assertions over emitted source cannot tell you whether the provider
puts the effort on the wire — that is exactly how the pre-4.0.0 no-op
survived. So the gated lane copies `wire-probe.mjs` into two rendered
projects, imports the emitted `agent/agent.ts` for real (Node 24 type
stripping), points the generated `OPENROUTER_BASE_URL` branch at a stub
gateway, and asserts the captured request **body**:

- `basic` (`max`) → `{"model":"deepseek/deepseek-v4-pro", …, "reasoning":{"effort":"max"}}`;
- the same call with `reasoning` passed as a CALL OPTION (eve's own route)
  produces a byte-identical body — the empirical half of spike finding 29;
- `custom-approval` (`provider-default`) → **no** `reasoning` key at all.

It does not boot eve's tool loop (that needs a world database and a platform
JWT), and it does not need to: eve's only contribution to the effort is the
call option the second assertion proves is dropped. What OpenRouter *does*
with a reasoning block on a model that advertises none is a separate,
still-open question that only a keyed lane can answer.
