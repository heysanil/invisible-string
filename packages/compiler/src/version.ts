/**
 * Compiler template version. Participates in the artifact hash, so BUMP IT ON
 * EVERY CHANGE to what compile() emits (templates, file layout, generated
 * code, instructions rendering) — otherwise previously built artifacts get
 * cache-hit for output that no longer matches the templates.
 *
 * Bump policy (documented in packages/compiler/README.md):
 * - patch: comment/formatting-only changes to generated files
 * - minor: new emitted files or new optional behavior
 * - major: changed generated-code semantics or env contract
 */
export const COMPILER_VERSION = "1.0.0";
