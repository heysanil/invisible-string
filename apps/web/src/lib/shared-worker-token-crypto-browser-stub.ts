/**
 * Browser stub for `@invisible-string/shared`'s `worker-token-crypto.ts`.
 *
 * That module mints and verifies the per-worker session and dispatch tokens —
 * it imports `node:crypto` (`createHmac`, `randomBytes`, `timingSafeEqual`) at
 * module scope, none of which exist in the browser. The shared barrel
 * re-exports it, so importing ANY shared DTO/schema would otherwise drag it
 * into the client bundle and crash at load. Worker tokens are a control-plane ↔
 * worker concern that the SPA never touches, so Vite redirects the module here
 * (see vite.config.ts and ./server-only-shared-modules.ts).
 *
 * Exports mirror the real module's runtime surface so the barrel's `export *`
 * stays valid; each throws only if actually called (a bug), never on import.
 * Types still come from the real module (tsc does not follow the Vite alias).
 */
function serverOnly(name: string): never {
  throw new Error(`${name} is server-only and unavailable in the browser`);
}

export function derivePerWorkerSecret(): never {
  return serverOnly("derivePerWorkerSecret");
}
export function mintWorkerSessionToken(): never {
  return serverOnly("mintWorkerSessionToken");
}
export function mintDispatchToken(): never {
  return serverOnly("mintDispatchToken");
}
export function verifyWorkerSessionToken(): never {
  return serverOnly("verifyWorkerSessionToken");
}
export function verifyDispatchToken(): never {
  return serverOnly("verifyDispatchToken");
}
