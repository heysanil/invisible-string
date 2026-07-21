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
 */
export const COMPILER_VERSION = "3.0.1";
