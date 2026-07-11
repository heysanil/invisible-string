/**
 * Generated project scaffolding: package.json (EXACT pins from versions.json)
 * and tsconfig.json (mirrors the spike's strict config — the proven
 * reference at spike/agent-project/).
 *
 * NO lockfile is emitted: the build service owns `npm install` (exact pins
 * make resolution reproducible) and commits/caches the lockfile with the
 * built artifact.
 */
import type { CompileDeps } from "../types";

function sortedRecord(record: Record<string, string>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}

export function emitPackageJson(deps: CompileDeps): string {
  const { versions, resolvedModel, workspaceSlug, agentSlug } = deps;
  const dependencies: Record<string, string> = {
    "@workflow/world-postgres": versions.worldPostgres,
    ai: versions.ai,
    eve: versions.eve,
    zod: versions.zod,
  };
  if (resolvedModel.provider === "openrouter") {
    dependencies["@openrouter/ai-sdk-provider"] = versions.openrouterProvider;
  } else {
    dependencies["@ai-sdk/anthropic"] = versions.anthropicProvider;
  }
  const manifest = {
    name: `agent--${workspaceSlug}--${agentSlug}`,
    private: true,
    type: "module",
    engines: { node: "24.x" },
    scripts: {
      build: "eve build",
      start: "eve start",
      typecheck: "tsc --noEmit",
    },
    dependencies: sortedRecord(dependencies),
    devDependencies: sortedRecord({
      "@types/node": versions.typesNode,
      typescript: versions.typescript,
    }),
  };
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

export function emitTsconfig(): string {
  const tsconfig = {
    compilerOptions: {
      target: "ES2023",
      module: "NodeNext",
      moduleResolution: "NodeNext",
      lib: ["ES2023"],
      types: ["node"],
      strict: true,
      noUncheckedIndexedAccess: true,
      exactOptionalPropertyTypes: true,
      forceConsistentCasingInFileNames: true,
      verbatimModuleSyntax: true,
      skipLibCheck: true,
      noEmit: true,
    },
    include: ["agent/**/*.ts"],
  };
  return `${JSON.stringify(tsconfig, null, 2)}\n`;
}
