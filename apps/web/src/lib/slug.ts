/**
 * Better Auth organizations require a unique slug the product never shows
 * (slugs surface nowhere in the UI). Derive one from the workspace name and
 * append a random suffix so two workspaces can share a display name without
 * colliding — no user-facing slug field, no collision retry loop.
 */
export function workspaceSlug(name: string): string {
  const base = name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32)
    .replace(/-+$/, "");
  const suffix = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  return base ? `${base}-${suffix}` : `workspace-${suffix}`;
}
