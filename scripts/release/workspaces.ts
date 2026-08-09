/**
 * Workspace enumeration for the release scripts. Expands the root
 * package.json `workspaces` globs (only the trailing-`/*` form this repo uses)
 * and reads each manifest's name and version.
 *
 * A workspace WITHOUT a version is deliberately excluded from versioning —
 * see the design spec §5.1. Callers use that absence, not a hard-coded list.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface Workspace {
  name: string;
  dir: string;
  version?: string;
}

interface Manifest {
  name?: string;
  version?: string;
  workspaces?: string[];
}

function readManifest(root: string, dir: string): Manifest {
  return JSON.parse(readFileSync(join(root, dir, "package.json"), "utf8")) as Manifest;
}

export function readWorkspaces(root: string): Workspace[] {
  const patterns = readManifest(root, ".").workspaces ?? [];
  const dirs = patterns.flatMap((pattern) => {
    if (!pattern.endsWith("/*")) return [pattern];
    const parent = pattern.slice(0, -2);
    return readdirSync(join(root, parent), { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => `${parent}/${entry.name}`);
  });

  return dirs
    .map((dir) => {
      const manifest = readManifest(root, dir);
      return { name: manifest.name ?? dir, dir, version: manifest.version };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}
