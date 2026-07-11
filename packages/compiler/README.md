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
  resolvedModel: { provider: "openrouter", modelId: "deepseek/deepseek-v4-flash" },
  workspaceSlug: "acme",
  agentSlug: "software-engineer",
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

The artifact is **trigger-agnostic**: `agent/channels/eve.ts` is the only
channel — no trigger channels, no schedules, no outbound-delivery libs.
Chat and workflow dispatch both ride the default eve channel; schedule
firing and Slack reply delivery live in the control plane.

| Path | Content |
|---|---|
| `package.json` | name `agent--<ws>--<agent>`, `engines.node "24.x"`, EXACT pins from `versions.json`, per-provider dependency. **No lockfile** — the build service owns `npm install`. |
| `tsconfig.json` | strict NodeNext config (mirrors the spike). |
| `agent/agent.ts` | explicit `model` (never eve's default), `reasoning` from `definition.model.reasoning`, `experimental.workflow.world = "@workflow/world-postgres"`. openrouter: provider constructed **only when `OPENROUTER_API_KEY` is set** (construction throws keyless — spike friction 4), with `OPENROUTER_BASE_URL` passthrough for mock gateways; keyless falls back to the model-id string so `eve build`/boot stay alive. anthropic resolves its key/baseURL lazily. |
| `agent/instructions.md` | the persona with compile-time refs resolved, then — only when the agent has context — a `---`-separated generated "Workspace context" appendix (connection/skill descriptions for `connection_search`/`load_skill` routing). Nothing else — workflow instructions never appear here. |
| `agent/lib/platform-auth.ts` | `platformJwt()` AuthFn (`verifyJwtHmac`, HS256, `PLATFORM_JWT_SECRET`, iss `invisible-string` / version-bound aud `agent-version:<hash>`) + `localDev()` **only on `options.dev` builds**. |
| `agent/lib/env.ts` | `requireEnv()` helper (only when a connection needs env credentials). |
| `agent/channels/eve.ts` | default HTTP channel — the ONLY channel — with platform-JWT route auth and an `onMessage` hook injecting platform context blocks (identity line `Platform agent "<agent>" in workspace "<ws>"`; context is an onMessage **return**, never a `send()` option — PLAN correction 2). |
| `agent/connections/<slug>.ts` | `defineMcpClientConnection`: literal `url`/`description`; auth via env-token `getToken` or lazy `headers` callback; `tools` exactly-one `allow`/`block`; approval `never()`/`once()`/`always()` or a generated per-tool policy matching **qualified** names (`<slug>__<tool>`). |
| `agent/skills/<slug>.md` or `<slug>/SKILL.md` (+files) | SKILL.md convention with `description` frontmatter. |

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
  `agentSlug`, `workspaceSlug`, dev flag). This is a superset of the PLAN's
  "definition + compiler version + eve version" so a cached artifact can
  never go stale invisibly — e.g. editing a skill's markdown changes the
  hash even though the definition stores only its UUID.
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
| `NODE_ENV` | eve | Supervisor must pin `production` — `NODE_ENV=test` silently mocks authored models (spike finding 5). |

## Tests

```sh
bun test packages/compiler                     # unit + golden (fast, no gates)
UPDATE_GOLDEN=1 bun test src/golden.test.ts    # regenerate snapshots (review the diff!)
SPIKE_EVE_BUILD=1 bun test src/eve-build.test.ts
    # gated slow proof: renders every fixture to a temp dir, npm-installs
    # with Node 24 (mise), tsc --noEmit passes strict, and the basic
    # (default-eve-channel-only) + mcp-skill (packaged skill) fixtures
    # `eve build` KEYLESS to servable .output bundles.
TEST_DATABASE_URL=… bun test src/world-isolation.test.ts
    # gated proof of the isolation contract — see WORLD-ISOLATION.md.
```

Golden fixtures (`fixtures/<name>/`): `basic` (persona only), `mcp-skill`
(bearer connection + packaged skill), `custom-approval` (headers auth +
custom approval policy + tool filters), `flat-skill` (markdown-only skill →
flat `agent/skills/<slug>.md` + the seeded "powerful" preset model
z-ai/glm-5.2, pinning its context-window entry), `anthropic-model`
(anthropic provider + matching modelId override, dev build).
