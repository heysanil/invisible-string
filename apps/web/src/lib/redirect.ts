/**
 * Validate a post-auth redirect target taken from the URL search string.
 * Only same-app absolute paths pass ("/x/y"); protocol-relative ("//host",
 * including the "/\\" form browsers normalize to it) and absolute/schemed URLs
 * are rejected so login/signup can never bounce a victim off-site
 * (open-redirect hardening for invite links).
 */
export function safeRedirectPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  if (!value.startsWith("/") || value.startsWith("//") || value.startsWith("/\\"))
    return undefined;
  return value;
}
