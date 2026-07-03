/**
 * MCP connection auth encryption (write side). Values are encrypted with the
 * AES-256-GCM envelope, AAD-bound to the connection row so a relocated
 * envelope fails authentication. The plaintext NEVER leaves this module toward
 * a response — read DTOs carry only `hasCredentials`.
 *
 * The AAD binds to the row id, so a create must know its id BEFORE encrypting
 * (callers generate the uuid up front and insert it explicitly).
 */
import { encryptSecret, type MasterKey, type McpAuthWrite } from "@invisible-string/shared";

import { mcpAuthAadContext } from "../runtime/agent-env";
import { errors } from "../runtime/errors";

/**
 * Encrypt an auth WRITE into the JSON envelope stored on
 * `mcp_connections.auth_config_encrypted`, or `null` to clear credentials.
 * The stored plaintext is a discriminated union the dispatcher/compile path
 * reads (agent-env `decryptMcpAuthConfig`): bearer `{type,token}` or headers
 * `{type,headers}`.
 */
export function encryptMcpAuthConfig(
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
    mcpAuthAadContext(connectionId),
  );
  return JSON.stringify(envelope);
}
