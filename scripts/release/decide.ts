/**
 * The release decision, as a pure function over observed git state.
 *
 * Two values drive everything:
 *   V  — the version in packages/shared/package.json (what this commit CLAIMS
 *        to be)
 *   Vt — the version recorded at the tag's own commit (what the tag MARKED)
 *
 * Comparing them is what separates "this release already finished" — the
 * common case on every ordinary push to main — from "this tag marks something
 * else entirely", which is a genuine inconsistency worth stopping for.
 *
 * The tag is deliberately NOT the sole no-op key: it is the first side effect,
 * so keying solely on its existence would make any failure after tagging
 * unrecoverable (a re-run would skip everything, and re-pushing an existing
 * tag is a no-op). Image pushes are idempotent, so re-running is safe.
 */
export type TagState =
  | { kind: "absent" }
  | { kind: "present"; versionAtTag?: string; pointsAtHead: boolean };

export type Decision =
  | { action: "tag-and-release" }
  | { action: "ensure-release" }
  | { action: "noop"; reason: string }
  | { action: "fail"; message: string };

export function decide(version: string, tag: TagState): Decision {
  if (tag.kind === "absent") return { action: "tag-and-release" };

  // Every tag from v0.1.3 to v0.2.0 predates the `version` field entirely, so
  // `git show <tag>:packages/shared/package.json` succeeds with no version key.
  if (tag.versionAtTag === undefined) {
    return {
      action: "noop",
      reason: `tag v${version} predates versioned manifests — nothing to release`,
    };
  }

  if (tag.versionAtTag !== version) {
    return {
      action: "fail",
      message:
        `tag v${version} already exists but marks a commit whose version is ` +
        `${tag.versionAtTag}, not ${version}. A hand-pushed tag likely burned this ` +
        `number — align the manifests to it (docs/DEPLOY.md §10) before releasing.`,
    };
  }

  if (tag.pointsAtHead) return { action: "ensure-release" };

  return { action: "noop", reason: `v${version} was already released` };
}

/** The newest release section: everything from the first `## ` to the next. */
export function extractLatestSection(
  changelog: string,
): { heading: string; body: string } | undefined {
  const first = changelog.startsWith("## ") ? 0 : changelog.indexOf("\n## ") + 1;
  // Mirrors insertSection's hasHeading split — `indexOf(...) + 1` conflates
  // "missing" with "at offset 0", so the found bit must be carried separately.
  const hasHeading = changelog.startsWith("## ") || first > 0;
  if (!hasHeading) return undefined;

  const rest = changelog.slice(first);
  const newlineIndex = rest.indexOf("\n");
  const heading = rest.slice(3, newlineIndex === -1 ? undefined : newlineIndex).trim();

  // Same -1 case as the heading above: `rest.slice(-1 + 1)` would echo the whole
  // heading back as the body when the file ends on the heading line.
  const after = newlineIndex === -1 ? "" : rest.slice(newlineIndex + 1);
  const nextIndex = after.indexOf("\n## ");
  const body = (nextIndex === -1 ? after : after.slice(0, nextIndex)).trim();

  return { heading, body };
}
