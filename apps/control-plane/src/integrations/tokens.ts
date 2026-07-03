/**
 * Webhook/form ingress tokens (docs/PLAN.md Phase 3 task 3.1; INITIAL-SPEC.md
 * §8/§11 "webhook token hashes + rotation").
 *
 * SECRETS DISCIPLINE: the plaintext token is generated here, returned to the
 * caller ONCE, and never stored — only its SHA-256 hash lands on
 * `triggers.token_hash`. Ingress (`POST /t/:token`) hashes the presented token
 * and looks the trigger up by that hash (a unique-indexed equality on a
 * 256-bit-entropy secret's digest — no plaintext comparison, no per-character
 * timing signal). Rotation mints a new token and overwrites the hash.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Prefix marking a platform webhook/form ingress token. */
export const WEBHOOK_TOKEN_PREFIX = "whk_";

/** Random bytes of entropy in a minted token (256 bits). */
const TOKEN_ENTROPY_BYTES = 32;

/**
 * Mint a fresh ingress token: `whk_<43 url-safe base64 chars>` (256 bits).
 * URL-safe so it drops cleanly into `POST /t/:token`.
 */
export function generateIngressToken(): string {
  return WEBHOOK_TOKEN_PREFIX + randomBytes(TOKEN_ENTROPY_BYTES).toString("base64url");
}

/** SHA-256 hex digest stored on `triggers.token_hash`. */
export function hashIngressToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** Last 4 chars — a non-secret display hint ("…2345"). */
export function tokenSuffix(token: string): string {
  return token.slice(-4);
}

/**
 * Constant-time hex-digest comparison (defense in depth on top of the indexed
 * hash lookup). Unequal-length inputs are non-equal without leaking length via
 * an early return that skips the compare.
 */
export function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
