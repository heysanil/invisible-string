/**
 * Integration credential encryption (Slack bot tokens). Same AES-256-GCM
 * envelope as MCP secrets, AAD-bound to `(type, externalId)` — the stable
 * unique key of the `integrations` row — so a stored envelope relocated to a
 * different team/type fails authentication. The plaintext token never leaves
 * this module toward a response (read DTOs carry only `hasCredentials`).
 */
import {
  decryptSecret,
  encryptSecret,
  type EncryptedEnvelope,
  type MasterKey,
} from "@invisible-string/shared";

import { errors } from "../runtime/errors";

/** AAD binding an integration credential envelope to its row identity. */
export function integrationAadContext(type: string, externalId: string): string {
  return `integrations:credentials:${type}:${externalId}`;
}

/** Encrypt a credentials plaintext (JSON) into the stored envelope string. */
export function encryptIntegrationCredentials(
  plaintext: string,
  masterKey: MasterKey | undefined,
  type: string,
  externalId: string,
): string {
  if (!masterKey) throw errors.encryptionKeyMissing();
  const envelope = encryptSecret(plaintext, masterKey, integrationAadContext(type, externalId));
  return JSON.stringify(envelope);
}

/** Decrypt a stored integration credentials envelope back to plaintext (JSON). */
export function decryptIntegrationCredentials(
  encrypted: string,
  masterKey: MasterKey | undefined,
  type: string,
  externalId: string,
): string {
  if (!masterKey) throw errors.encryptionKeyMissing();
  let envelope: EncryptedEnvelope;
  try {
    envelope = JSON.parse(encrypted) as EncryptedEnvelope;
  } catch {
    throw errors.integrationNotFound();
  }
  return decryptSecret(envelope, masterKey, integrationAadContext(type, externalId));
}

/** Shape of the stored Slack credentials JSON. */
export interface SlackStoredCredentials {
  botToken: string;
}
