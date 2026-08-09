/**
 * The `version` command for changesets/action.
 *
 * Validates pending changesets, runs `changeset version`, then writes the
 * single root CHANGELOG.md that `changelog: false` suppresses.
 *
 * Ordering matters: changesets DELETES the .changeset/*.md files, so they are
 * read and parsed before the bump, not after.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  parseChangeset,
  validateChangesets,
  type ChangesetEntry,
} from "./release/changesets";
import { insertSection, renderSection } from "./release/changelog";
import { readWorkspaces } from "./release/workspaces";

const ROOT = join(import.meta.dir, "..");
const CHANGESET_DIR = join(ROOT, ".changeset");
const CHANGELOG = join(ROOT, "CHANGELOG.md");
const CARRIER = join(ROOT, "packages", "shared", "package.json");

const fail = (message: string): never => {
  console.error(`✖ ${message}`);
  process.exit(1);
};

function currentVersion(): string {
  const manifest = JSON.parse(readFileSync(CARRIER, "utf8")) as { version?: string };
  return manifest.version ?? fail("packages/shared/package.json has no version field");
}

function pendingChangesets(): ChangesetEntry[] {
  return readdirSync(CHANGESET_DIR)
    .filter((f) => f.endsWith(".md") && f.toLowerCase() !== "readme.md")
    .sort()
    .map((f) => parseChangeset(f, readFileSync(join(CHANGESET_DIR, f), "utf8")));
}

const entries = pendingChangesets();

const errors = validateChangesets(entries, readWorkspaces(ROOT));
if (errors.length > 0) {
  for (const error of errors) console.error(`✖ ${error}`);
  process.exit(1);
}

if (entries.length === 0) {
  console.log("No changesets pending — nothing to version.");
  process.exit(0);
}

const before = currentVersion();

const result = Bun.spawnSync(["bunx", "changeset", "version"], {
  cwd: ROOT,
  stdout: "inherit",
  stderr: "inherit",
});
if (result.exitCode !== 0) fail(`changeset version exited ${result.exitCode}`);

const after = currentVersion();
if (after === before) {
  console.log(`Version unchanged at ${before} — leaving CHANGELOG.md alone.`);
  process.exit(0);
}

const date = new Date().toISOString().slice(0, 10);
const section = renderSection(after, date, entries);
const existing = existsSync(CHANGELOG) ? readFileSync(CHANGELOG, "utf8") : "";
writeFileSync(CHANGELOG, insertSection(existing, section));

console.log(`Wrote CHANGELOG.md section for v${after} (${entries.length} changesets).`);
