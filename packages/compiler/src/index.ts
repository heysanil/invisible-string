import { SHARED_PACKAGE, placeholderSchema } from "@invisible-string/shared";

/**
 * Compiler package — placeholder.
 *
 * Phase 1 adds the pure function
 * `compile(WorkflowDefinition, versions) → { files: Map<path, string>, hash }`
 * emitting the eve project (agent.ts, instructions.md, connections/*,
 * skills/*, channels/*, schedules/*) with the version hash covering pillar
 * config + compiler version + eve version. The runtime version matrix lives
 * in `versions.json` (recorded by the Phase 0 spike).
 */
export function compilerPlaceholder(): { dependsOn: string; valid: boolean } {
  return {
    dependsOn: SHARED_PACKAGE,
    valid: placeholderSchema.safeParse({ ok: true }).success,
  };
}
