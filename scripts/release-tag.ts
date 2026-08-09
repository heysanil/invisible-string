/**
 * Tag the release, create its GitHub Release, and tell the workflow whether to
 * build images. Runs on main pushes only, after changesets/action.
 *
 * All decision logic lives in scripts/release/decide.ts; this file only gathers
 * git state and performs effects.
 *
 * Requires in CI: GH_TOKEN (gh auth) and a configured git user (annotated tag).
 */
import { appendFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { decide, extractLatestSection, type TagState } from "./release/decide";

const ROOT = join(import.meta.dir, "..");
const CHANGELOG = join(ROOT, "CHANGELOG.md");
const CARRIER = join(ROOT, "packages", "shared", "package.json");

function run(...args: string[]): { code: number; stdout: string } {
  const proc = Bun.spawnSync(args, { cwd: ROOT });
  return { code: proc.exitCode, stdout: new TextDecoder().decode(proc.stdout).trim() };
}

function mustRun(...args: string[]): string {
  const proc = Bun.spawnSync(args, { cwd: ROOT, stderr: "inherit" });
  if (proc.exitCode !== 0) {
    console.error(`✖ command failed: ${args.join(" ")}`);
    process.exit(1);
  }
  return new TextDecoder().decode(proc.stdout).trim();
}

function output(key: string, value: string): void {
  const file = process.env.GITHUB_OUTPUT;
  if (file) appendFileSync(file, `${key}=${value}\n`);
  console.log(`${key}=${value}`);
}

const version = (JSON.parse(readFileSync(CARRIER, "utf8")) as { version: string }).version;
const tag = `v${version}`;

function observeTag(): TagState {
  if (run("git", "rev-parse", "--verify", `refs/tags/${tag}`).code !== 0) {
    return { kind: "absent" };
  }
  const shown = run("git", "show", `${tag}:packages/shared/package.json`);
  const versionAtTag =
    shown.code === 0
      ? (JSON.parse(shown.stdout) as { version?: string }).version
      : undefined;
  const tagCommit = run("git", "rev-list", "-n", "1", tag).stdout;
  const head = run("git", "rev-parse", "HEAD").stdout;
  return { kind: "present", versionAtTag, pointsAtHead: tagCommit === head };
}

function ensureRelease(): void {
  if (run("gh", "release", "view", tag).code === 0) {
    console.log(`Release ${tag} already exists.`);
    return;
  }
  if (!existsSync(CHANGELOG)) {
    console.error(`✖ CHANGELOG.md missing — cannot build release notes for ${tag}`);
    process.exit(1);
  }
  const section = extractLatestSection(readFileSync(CHANGELOG, "utf8"));
  if (!section) {
    console.error(`✖ CHANGELOG.md has no "## " section — cannot build notes for ${tag}`);
    process.exit(1);
  }
  // Guard against a hand-edited changelog attaching the wrong notes.
  if (!section.heading.startsWith(tag)) {
    console.error(
      `✖ newest CHANGELOG.md section is "${section.heading}", expected it to start with ${tag}`,
    );
    process.exit(1);
  }
  const notes = join(ROOT, ".release-notes.md");
  writeFileSync(notes, `${section.body}\n`);
  mustRun("gh", "release", "create", tag, "--title", tag, "--notes-file", notes);
  console.log(`Created release ${tag}.`);
}

const decision = decide(version, observeTag());

switch (decision.action) {
  case "fail":
    console.error(`✖ ${decision.message}`);
    process.exit(1);
  case "noop":
    console.log(`No release: ${decision.reason}.`);
    output("released", "false");
    break;
  case "tag-and-release":
    mustRun("git", "tag", "-a", tag, "-m", tag);
    mustRun("git", "push", "origin", tag);
    ensureRelease();
    output("released", "true");
    output("version", tag);
    break;
  case "ensure-release":
    ensureRelease();
    output("released", "true");
    output("version", tag);
    break;
}
