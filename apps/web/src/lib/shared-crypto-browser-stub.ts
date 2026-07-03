/**
 * Browser stub for `@invisible-string/shared`'s `crypto.ts`.
 *
 * That module (AES-256-GCM envelope encryption for credentials) is SERVER-ONLY
 * — it imports `node:crypto` and uses Node's `Buffer` at module scope, neither
 * of which exist in the browser. The shared barrel re-exports it, so importing
 * ANY shared DTO/schema would otherwise drag it into the client bundle and
 * crash at load. The web app never encrypts/decrypts secrets client-side (the
 * control plane does; reads carry only a `hasCredentials` boolean), so Vite
 * redirects the module here (see vite.config.ts).
 *
 * Exports mirror crypto.ts's runtime surface so the barrel's `export *` stays
 * valid; each throws only if actually called (a bug), never on import. Types
 * still come from the real module (tsc doesn't follow the Vite alias).
 */
export const ENVELOPE_VERSION = 1 as const;

export class EnvelopeError extends Error {
  override readonly name = "EnvelopeError";
}

function serverOnly(name: string): never {
  throw new Error(`${name} is server-only and unavailable in the browser`);
}

export function parseMasterKey(): never {
  return serverOnly("parseMasterKey");
}
export function generateMasterKeyBase64(): never {
  return serverOnly("generateMasterKeyBase64");
}
export function encryptSecret(): never {
  return serverOnly("encryptSecret");
}
export function decryptSecret(): never {
  return serverOnly("decryptSecret");
}
export function rotateEnvelope(): never {
  return serverOnly("rotateEnvelope");
}
export function masterKeysEqual(): never {
  return serverOnly("masterKeysEqual");
}
