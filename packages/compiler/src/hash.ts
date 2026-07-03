/**
 * Deterministic workflow-version hash.
 *
 * PLAN.md Phase 1 asks for "canonicalized definition + compiler version +
 * versions.json content". We hash a strict SUPERSET: the FULL canonicalized
 * compile input (definition + every resolved dependency that shapes the
 * emitted files) so a cached artifact can never go stale invisibly — e.g.
 * editing a skill's markdown or a connection URL changes the hash even
 * though the definition (which stores only UUIDs) is unchanged.
 *
 * Guarantees:
 * - same input → same hash (key order never matters — objects are
 *   canonicalized by sorting keys recursively)
 * - any change to the definition, resolved deps, versions.json content, or
 *   COMPILER_VERSION changes the hash
 */
import { createHash } from "node:crypto";

import type { WorkflowDefinition } from "@invisible-string/shared";

import type { CompileDeps } from "./types";
import { COMPILER_VERSION } from "./version";

/**
 * Canonical JSON: recursively sorts object keys; arrays keep their order;
 * `undefined` object values are dropped (JSON semantics). Rejects values
 * JSON cannot represent losslessly so hashes never silently collapse
 * distinct inputs.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  switch (typeof value) {
    case "string":
    case "boolean":
      return JSON.stringify(value);
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError(`cannot canonicalize non-finite number ${value}`);
      }
      return JSON.stringify(value);
    case "object":
      break;
    default:
      throw new TypeError(`cannot canonicalize value of type ${typeof value}`);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  const entries = Object.keys(record)
    .sort()
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
  return `{${entries.join(",")}}`;
}

/**
 * sha256 hex over the canonicalized full compile input. Exported separately
 * from compile() so the control plane can cheaply pre-compute the version
 * hash for build-cache lookups.
 */
export function computeWorkflowHash(
  definition: WorkflowDefinition,
  deps: CompileDeps,
  compilerVersion: string = COMPILER_VERSION,
): string {
  const canonical = canonicalJson({
    compilerVersion,
    definition,
    resolved: {
      agentPreset: deps.agentPreset,
      // Resolved-entry array order is an input artifact, not semantics —
      // normalize by slug so equivalent inputs hash identically.
      connections: [...deps.connections].sort((a, b) =>
        a.slug < b.slug ? -1 : 1,
      ),
      options: { dev: deps.options?.dev === true },
      resolvedModel: deps.resolvedModel,
      skills: [...deps.skills].sort((a, b) => (a.slug < b.slug ? -1 : 1)),
      workflowSlug: deps.workflowSlug,
      workspaceSlug: deps.workspaceSlug,
    },
    versions: deps.versions,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}
