/**
 * Compiler template version. Participates in the artifact hash, so BUMP IT ON
 * EVERY CHANGE to what compile() emits (templates, file layout, generated
 * code, instructions rendering) — otherwise previously built artifacts get
 * cache-hit for output that no longer matches the templates.
 *
 * MECHANICAL GUARD: golden.test.ts hashes every fixture's emitted bytes into
 * `fixtures/.golden-digest.json` (paired with this version). A template
 * change without a version bump fails CI — and UPDATE_GOLDEN=1 refuses to
 * rewrite the digest until the bump lands in the same commit.
 *
 * Bump policy (documented in packages/compiler/README.md):
 * - patch: comment/formatting-only changes to generated files
 * - minor: new emitted files or new optional behavior
 * - major: changed generated-code semantics or env contract
 *
 * 3.0.0 — MAJOR: the agent is the compile unit. compile() takes an
 * AgentDefinition (persona · model · context) instead of a four-pillar
 * WorkflowDefinition; artifacts emit ONLY the default eve channel (trigger
 * channels, schedules, and the Slack/callback outbound libs are gone —
 * `@trigger.*` resolution and outbound delivery moved to the control-plane
 * dispatcher); the JWT audience is `agent-version:<hash>` and the hash
 * inputs re-keyed, so EVERY version hash changes.
 *
 * 3.0.1 — patch: no template change. The golden FIXTURE SET grew
 * (flat-skill fixture pinning the flat `agent/skills/<slug>.md` emission
 * branch and the z-ai/glm-5.2 context-window entry that no other fixture
 * reached), and the digest guard requires a bump in the same commit as any
 * digest rewrite. (Baked JWT audiences shift anyway — the version
 * participates in every content hash.)
 *
 * 3.1.0 — MINOR: new optional behavior in `agent/agent.ts` for the eve
 * 0.19.0 -> 0.31.3 bump. Both provider templates now emit an EXPLICIT
 * `limits` block (`maxInputTokensPerSession: 40_000_000`,
 * `sessionTimeoutMs: 2_592_000_000`) pinning the two defaults eve 0.31
 * applies whether or not an agent asks for them, so the runtime envelope
 * becomes part of the artifact instead of drifting with the runtime. The
 * openrouter template's in-file doc comment was corrected in the same pass:
 * under @openrouter/ai-sdk-provider@3.0.0 the missing-key
 * AI_LoadAPIKeyError moved from model CONSTRUCTION to the first model CALL,
 * which makes the keyless guard MORE load-bearing, not redundant — that
 * comment ships inside the generated file, so correcting it changes emitted
 * bytes. Generated-code semantics are otherwise unchanged (the emitted
 * limits equal what eve already enforced) and the env contract is
 * untouched, hence minor rather than major. Every version hash changes
 * regardless — versions.json moved in the same commit.
 *
 * 4.0.0 — MAJOR: changed generated-code semantics for the reasoning effort.
 * The effort is no longer read from `definition.model.reasoning` (which is
 * now an OPTIONAL override — `undefined` means inherit) but from the
 * control-plane-resolved `deps.resolvedModel.reasoning`, so two identical
 * definitions inheriting different preset efforts now hash — and build —
 * differently. On the OPENROUTER branch the effort moved OFF eve's
 * `reasoning:` config and onto the model's `extraBody`
 * (`openrouter(MODEL_ID, { extraBody: { reasoning: { effort } } })`): eve
 * forwards its config to ai@7 as a top-level call option that
 * @openrouter/ai-sdk-provider@3.0.0's getArgs() never destructures, so every
 * OpenRouter agent built before this version ran at the provider's default
 * effort no matter what its definition said. `provider-default` emits a bare
 * `openrouter(MODEL_ID)` with no settings at all. The ANTHROPIC branch keeps
 * `reasoning:` (spec-v4 provider; eve maps the effort to a thinking budget)
 * but clamps `max` → `xhigh` and omits the field for `provider-default`.
 * OPENROUTER_CONTEXT_WINDOW_TOKENS also gained the two new seeded models
 * (moonshotai/kimi-k3, ~deepseek/deepseek-v4-flash-latest); the previous
 * entries stay so older versions keep recompiling to identical bytes.
 * BUILD_ENV_EPOCH is deliberately NOT bumped — the byte change is inside
 * compile(), which this version already re-keys.
 *
 * 4.1.0 — MINOR: new emitted file + new optional behavior for broker-
 * delivered OAuth connections (connectors redesign spec §6). Connections
 * with `auth.kind === "oauth"` emit an `auth.getToken` that calls the new
 * `agent/lib/platform-token.ts`: an in-process-cached (60 s expiry margin)
 * fetch of a short-lived access token from the control plane's
 * `POST /internal/connections/token`, authenticated with a self-minted
 * HS256 platform JWT (hand-rolled on node:crypto — generated projects take
 * no new runtime deps) under the version-bound audience platform-auth.ts
 * already bakes. The generated project reads TWO env vars for this —
 * PLATFORM_API_URL (new; injected by the dispatcher's env assembly) and the
 * existing PLATFORM_JWT_SECRET — both lazily inside the call, so keyless
 * `eve build` still never crashes. No OAuth material (tokens, client
 * secrets, refresh tokens) ever appears in generated files or agent env.
 * Existing bearer/headers/none emissions are byte-identical; hashes still
 * shift for every version because COMPILER_VERSION participates.
 */
export const COMPILER_VERSION = "4.1.0";
