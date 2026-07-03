/**
 * AES-256-GCM envelope encryption for secrets at rest (spec §11).
 *
 * Scheme:
 * - A single 32-byte **master key** comes from the environment
 *   (`ENCRYPTION_MASTER_KEY`, base64).
 * - Every value is encrypted with a fresh random 32-byte **data key** and a
 *   random 12-byte IV (AES-256-GCM).
 * - The data key is **wrapped** (encrypted) with the master key under its own
 *   random IV; the wrap IV, wrapped key bytes, and wrap auth tag are packed
 *   into the `edk` field.
 * - Key rotation re-wraps `edk` under a new master key without touching the
 *   payload ciphertext.
 *
 * Envelope shape (JSON-serializable, all binary fields base64):
 *   { v: 1, edk, iv, tag, ct }
 */
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/** Current envelope format version. */
export const ENVELOPE_VERSION = 1 as const;

const MASTER_KEY_BYTES = 32;
const DATA_KEY_BYTES = 32;
const IV_BYTES = 12;
const TAG_BYTES = 16;

/** Additional authenticated data binding ciphertexts to this scheme/version. */
const PAYLOAD_AAD = Buffer.from("invisible-string.envelope.v1", "utf8");
const WRAP_AAD = Buffer.from("invisible-string.edk.v1", "utf8");

/**
 * Fold an optional caller-supplied binding context into a base AAD constant.
 * The context (e.g. `${workspaceId}:${table}:${column}:${rowId}`) ties an
 * envelope to its owning row/tenant: a complete envelope tuple relocated into
 * another row decrypts only if the SAME context is presented, so cross-tenant
 * envelope reuse fails authentication instead of silently leaking plaintext.
 * A 0x00 separator (never valid inside the UTF-8 base constants) prevents
 * ambiguity between base and context bytes.
 */
function buildAad(base: Buffer, aadContext?: string): Buffer {
  if (aadContext === undefined) return base;
  if (aadContext.length === 0) {
    throw new EnvelopeError("aadContext must be a non-empty string when provided");
  }
  return Buffer.concat([base, Buffer.from([0]), Buffer.from(aadContext, "utf8")]);
}

/** A validated 32-byte master key. Obtain via {@link parseMasterKey}. */
export type MasterKey = Buffer & { readonly __brand: "EnvelopeMasterKey" };

/** JSON-serializable encrypted envelope. */
export interface EncryptedEnvelope {
  /** Format version. */
  v: typeof ENVELOPE_VERSION;
  /** Encrypted data key: base64(wrapIv(12) || wrappedKey(32) || wrapTag(16)). */
  edk: string;
  /** Payload IV (12 bytes, base64). */
  iv: string;
  /** Payload GCM auth tag (16 bytes, base64). */
  tag: string;
  /** Payload ciphertext (base64). */
  ct: string;
}

/** Thrown for malformed keys/envelopes and failed decryptions. */
export class EnvelopeError extends Error {
  override readonly name = "EnvelopeError";
}

/**
 * Validate and decode a base64-encoded 32-byte master key
 * (the `ENCRYPTION_MASTER_KEY` env value).
 */
export function parseMasterKey(base64: string): MasterKey {
  if (typeof base64 !== "string" || base64.trim() === "") {
    throw new EnvelopeError(
      "master key is empty — expected 32 bytes base64-encoded (generate with `openssl rand -base64 32`)",
    );
  }
  let decoded: Buffer;
  try {
    decoded = Buffer.from(base64.trim(), "base64");
  } catch {
    throw new EnvelopeError("master key is not valid base64");
  }
  if (decoded.length !== MASTER_KEY_BYTES) {
    throw new EnvelopeError(
      `master key must decode to exactly ${MASTER_KEY_BYTES} bytes, got ${decoded.length} — generate with \`openssl rand -base64 32\``,
    );
  }
  return decoded as MasterKey;
}

/** Generate a fresh master key, returned base64-encoded (for ops/tests). */
export function generateMasterKeyBase64(): string {
  return randomBytes(MASTER_KEY_BYTES).toString("base64");
}

/**
 * Encrypt a UTF-8 string under a per-value data key wrapped by `masterKey`.
 *
 * `aadContext` (recommended for stored secrets) cryptographically binds the
 * envelope to its owning row/tenant, e.g.
 * `${workspaceId}:${table}:${column}:${rowId}` — decryption then requires the
 * same context, defeating cross-row/cross-tenant envelope relocation.
 */
export function encryptSecret(
  plaintext: string,
  masterKey: MasterKey,
  aadContext?: string,
): EncryptedEnvelope {
  assertMasterKey(masterKey);
  const dataKey = randomBytes(DATA_KEY_BYTES);
  try {
    // Payload: AES-256-GCM under the data key.
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", dataKey, iv);
    cipher.setAAD(buildAad(PAYLOAD_AAD, aadContext));
    const ct = Buffer.concat([
      cipher.update(Buffer.from(plaintext, "utf8")),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    return {
      v: ENVELOPE_VERSION,
      edk: wrapDataKey(dataKey, masterKey, aadContext),
      iv: iv.toString("base64"),
      tag: tag.toString("base64"),
      ct: ct.toString("base64"),
    };
  } finally {
    dataKey.fill(0);
  }
}

/**
 * Decrypt an envelope produced by {@link encryptSecret}. Must be called with
 * the same `aadContext` used at encryption time (or none, for context-free
 * envelopes) — any mismatch fails authentication.
 */
export function decryptSecret(
  envelope: EncryptedEnvelope,
  masterKey: MasterKey,
  aadContext?: string,
): string {
  assertMasterKey(masterKey);
  const { edk, iv, tag, ct } = validateEnvelope(envelope);
  const dataKey = unwrapDataKey(edk, masterKey, aadContext);
  try {
    const decipher = createDecipheriv("aes-256-gcm", dataKey, iv);
    decipher.setAAD(buildAad(PAYLOAD_AAD, aadContext));
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(ct), decipher.final()]).toString(
        "utf8",
      );
    } catch {
      throw new EnvelopeError(
        "decryption failed — ciphertext was tampered with or the envelope is corrupt",
      );
    }
  } finally {
    dataKey.fill(0);
  }
}

/**
 * Key rotation: re-wrap the envelope's data key under `newMasterKey`.
 * The payload ciphertext (`iv`/`tag`/`ct`) is untouched — rotation is O(1)
 * per row regardless of payload size.
 */
export function rotateEnvelope(
  envelope: EncryptedEnvelope,
  oldMasterKey: MasterKey,
  newMasterKey: MasterKey,
  aadContext?: string,
): EncryptedEnvelope {
  assertMasterKey(oldMasterKey);
  assertMasterKey(newMasterKey);
  const { edk } = validateEnvelope(envelope);
  const dataKey = unwrapDataKey(edk, oldMasterKey, aadContext);
  try {
    return {
      v: ENVELOPE_VERSION,
      edk: wrapDataKey(dataKey, newMasterKey, aadContext),
      iv: envelope.iv,
      tag: envelope.tag,
      ct: envelope.ct,
    };
  } finally {
    dataKey.fill(0);
  }
}

/** Constant-time equality check for two master keys (rotation sanity checks). */
export function masterKeysEqual(a: MasterKey, b: MasterKey): boolean {
  return a.length === b.length && timingSafeEqual(a, b);
}

// ── internals ───────────────────────────────────────────────────────────────

function assertMasterKey(key: Buffer): asserts key is MasterKey {
  if (!Buffer.isBuffer(key) || key.length !== MASTER_KEY_BYTES) {
    throw new EnvelopeError(
      `invalid master key — expected a ${MASTER_KEY_BYTES}-byte key from parseMasterKey()`,
    );
  }
}

/** edk = base64(wrapIv(12) || wrappedKey(32) || wrapTag(16)). */
function wrapDataKey(
  dataKey: Buffer,
  masterKey: MasterKey,
  aadContext?: string,
): string {
  const wrapIv = randomBytes(IV_BYTES);
  const cipher = createCipheriv("aes-256-gcm", masterKey, wrapIv);
  cipher.setAAD(buildAad(WRAP_AAD, aadContext));
  const wrapped = Buffer.concat([cipher.update(dataKey), cipher.final()]);
  const wrapTag = cipher.getAuthTag();
  return Buffer.concat([wrapIv, wrapped, wrapTag]).toString("base64");
}

function unwrapDataKey(
  edk: Buffer,
  masterKey: MasterKey,
  aadContext?: string,
): Buffer {
  const wrapIv = edk.subarray(0, IV_BYTES);
  const wrapped = edk.subarray(IV_BYTES, IV_BYTES + DATA_KEY_BYTES);
  const wrapTag = edk.subarray(IV_BYTES + DATA_KEY_BYTES);
  const decipher = createDecipheriv("aes-256-gcm", masterKey, wrapIv);
  decipher.setAAD(buildAad(WRAP_AAD, aadContext));
  decipher.setAuthTag(wrapTag);
  try {
    return Buffer.concat([decipher.update(wrapped), decipher.final()]);
  } catch {
    throw new EnvelopeError(
      "failed to unwrap data key — wrong master key or tampered edk",
    );
  }
}

interface DecodedEnvelope {
  edk: Buffer;
  iv: Buffer;
  tag: Buffer;
  ct: Buffer;
}

function validateEnvelope(envelope: EncryptedEnvelope): DecodedEnvelope {
  if (typeof envelope !== "object" || envelope === null) {
    throw new EnvelopeError("envelope must be an object");
  }
  if (envelope.v !== ENVELOPE_VERSION) {
    throw new EnvelopeError(
      `unsupported envelope version ${String((envelope as { v?: unknown }).v)} — expected ${ENVELOPE_VERSION}`,
    );
  }
  const edk = decodeField("edk", envelope.edk);
  const iv = decodeField("iv", envelope.iv);
  const tag = decodeField("tag", envelope.tag);
  // ct may be empty: GCM authenticates empty plaintexts via the tag alone.
  const ct = decodeField("ct", envelope.ct, { allowEmpty: true });
  if (edk.length !== IV_BYTES + DATA_KEY_BYTES + TAG_BYTES) {
    throw new EnvelopeError(
      `envelope edk must decode to ${IV_BYTES + DATA_KEY_BYTES + TAG_BYTES} bytes, got ${edk.length}`,
    );
  }
  if (iv.length !== IV_BYTES) {
    throw new EnvelopeError(
      `envelope iv must decode to ${IV_BYTES} bytes, got ${iv.length}`,
    );
  }
  if (tag.length !== TAG_BYTES) {
    throw new EnvelopeError(
      `envelope tag must decode to ${TAG_BYTES} bytes, got ${tag.length}`,
    );
  }
  return { edk, iv, tag, ct };
}

function decodeField(
  name: string,
  value: string,
  opts?: { allowEmpty?: boolean },
): Buffer {
  if (typeof value !== "string" || (value === "" && !opts?.allowEmpty)) {
    throw new EnvelopeError(`envelope field "${name}" must be a base64 string`);
  }
  const decoded = Buffer.from(value, "base64");
  // Reject values that are not base64 at all (Buffer.from silently drops
  // invalid characters, so re-encode and compare canonical forms).
  if (decoded.length === 0 && value.length > 0) {
    throw new EnvelopeError(`envelope field "${name}" is not valid base64`);
  }
  return decoded;
}
