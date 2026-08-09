/**
 * The session can never take another message. Two codes mean this, with the
 * SAME recovery (start a new chat) and the OPPOSITE recovery from
 * `session_busy`:
 * - `session_not_active` — eve retired the id (terminal / timed out / reset).
 * - `session_not_continuable` — the platform row is closed or lost its eve
 *   session id. Control-plane-only, so there is no shared constant for it.
 *
 * Lifted out of ThreadContainer so the message queue and the container
 * classify the same error the same way by construction.
 */
import { isApiErrorCode, isSessionNotActive } from "../api-client";

export function isSessionOver(error: unknown): boolean {
  return (
    isSessionNotActive(error) || isApiErrorCode(error, "session_not_continuable")
  );
}
