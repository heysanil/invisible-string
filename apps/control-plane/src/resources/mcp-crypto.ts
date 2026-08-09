/**
 * Connection auth encryption (write side). Values are encrypted with the
 * AES-256-GCM envelope, AAD-bound to the connection row so a relocated
 * envelope fails authentication. The plaintext NEVER leaves this module toward
 * a response — read DTOs carry only `hasCredentials`.
 *
 * The AAD binds to the row id, so a create must know its id BEFORE encrypting
 * (callers generate the `cn_` id up front and insert it explicitly).
 */
import { encryptSecret, type MasterKey, type McpAuthWrite } from "@invisible-string/shared";

import { errors } from "../runtime/errors";

/**
 * AAD context binding a `connections` (connectors redesign, spec §3) auth
 * envelope to its row. Table+column+row-id in the context means an envelope
 * lifted from the dead `mcp_connections` table — or another connection row —
 * fails authentication instead of decrypting.
 */
export function connectionAuthAad(connectionId: string): string {
  return `connections:auth_config:${connectionId}`;
}

/**
 * Encrypt an auth WRITE for the `connections` table, or `null` to clear
 * credentials. The stored plaintext is a discriminated union the
 * dispatch/compile paths read (agent-env `decryptMcpAuthConfig`): bearer
 * `{type,token}` / headers `{type,headers}` — AAD-bound to the row via
 * {@link connectionAuthAad}.
 */
export function encryptConnectionAuthConfig(
  auth: McpAuthWrite,
  masterKey: MasterKey | undefined,
  connectionId: string,
): string | null {
  if (auth.type === "none") return null;
  if (!masterKey) throw errors.encryptionKeyMissing();
  const config =
    auth.type === "bearer"
      ? { type: "bearer" as const, token: auth.values.token }
      : { type: "headers" as const, headers: auth.values };
  const envelope = encryptSecret(
    JSON.stringify(config),
    masterKey,
    connectionAuthAad(connectionId),
  );
  return JSON.stringify(envelope);
}
