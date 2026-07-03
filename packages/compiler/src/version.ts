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
 */
export const COMPILER_VERSION = "2.2.0";
