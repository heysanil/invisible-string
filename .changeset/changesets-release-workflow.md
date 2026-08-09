---
"@invisible-string/control-plane": minor
---

Adopt changesets for releases: merging the `chore(release): version packages` PR now computes the version, writes `CHANGELOG.md`, tags `vX.Y.Z`, cuts the GitHub Release, and builds the GHCR images in one workflow run.
