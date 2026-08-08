/**
 * Regenerates spike/agent-project/package.json's pins FROM
 * packages/compiler/versions.json, so repinning the spike is a derivation
 * rather than a retype. Run it after any versions.json change:
 *
 *   bun run spike/tests/sync-pins.ts
 *   cd spike/agent-project && mise exec node@24 -- npm install --package-lock-only --ignore-scripts
 *
 * The second step is mandatory: `pins.test.ts` also checks the committed
 * package-lock.json, because a package.json the lockfile disagrees with is
 * exactly the drift that let the spike gate eve 0.19 while versions.json
 * claimed 0.31.3. Never hand-edit package-lock.json.
 */
import { readFileSync, writeFileSync } from "node:fs";

import { AGENT_PROJECT_PACKAGE_JSON, expectedSpikePins } from "./pins.ts";

interface AgentPackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  engines?: Record<string, string>;
  [key: string]: unknown;
}

const expected = expectedSpikePins();
const manifest = JSON.parse(
  readFileSync(AGENT_PROJECT_PACKAGE_JSON, "utf8"),
) as AgentPackageJson;

const before = JSON.stringify({
  dependencies: manifest.dependencies,
  devDependencies: manifest.devDependencies,
  engines: manifest.engines,
});

manifest.dependencies = expected.dependencies;
manifest.devDependencies = expected.devDependencies;
manifest.engines = { ...manifest.engines, node: expected.enginesNode };

const after = JSON.stringify({
  dependencies: manifest.dependencies,
  devDependencies: manifest.devDependencies,
  engines: manifest.engines,
});

writeFileSync(AGENT_PROJECT_PACKAGE_JSON, `${JSON.stringify(manifest, null, 2)}\n`);

if (before === after) {
  console.log("[spike] pins already match packages/compiler/versions.json");
} else {
  console.log("[spike] rewrote spike/agent-project/package.json from versions.json:");
  for (const [pkg, version] of Object.entries({
    ...expected.dependencies,
    ...expected.devDependencies,
  })) {
    console.log(`  ${pkg}@${version}`);
  }
  console.log(`  engines.node ${expected.enginesNode}`);
  console.log(
    "[spike] NOW REGENERATE THE LOCKFILE: cd spike/agent-project && mise exec node@24 -- npm install --package-lock-only --ignore-scripts",
  );
}
