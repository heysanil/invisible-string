/**
 * Render the body of the `chore(release): version packages` PR.
 *
 * release.yml's version step needs a file to hand `gh pr create --body-file`.
 * The body is the newest CHANGELOG.md section — byte-for-byte the notes
 * release:tag will later attach to the GitHub Release — so the PR shows
 * exactly what merging it publishes. Runs AFTER `bun run release:version`,
 * so the manifest and changelog already carry the new version.
 *
 * Usage: bun run scripts/release-pr-body.ts <outfile>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { extractLatestSection } from "./release/decide";

const ROOT = join(import.meta.dir, "..");
const CHANGELOG = join(ROOT, "CHANGELOG.md");
const CARRIER = join(ROOT, "packages", "shared", "package.json");

const out = process.argv[2];
if (out === undefined) {
  console.error("✖ usage: bun run scripts/release-pr-body.ts <outfile>");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync(CARRIER, "utf8")) as { version?: string };
if (!manifest.version) {
  console.error("✖ packages/shared/package.json has no version field");
  process.exit(1);
}

const section = extractLatestSection(readFileSync(CHANGELOG, "utf8"));
if (!section) {
  console.error(`✖ CHANGELOG.md has no "## " section — cannot build a PR body`);
  process.exit(1);
}

writeFileSync(out, `Merging this PR releases v${manifest.version}.\n\n${section.body}\n`);
console.log(`Wrote PR body for v${manifest.version} to ${out}.`);
