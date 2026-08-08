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
 */
export const COMPILER_VERSION = "3.1.0";
