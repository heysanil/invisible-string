/**
 * Per-agent environment assembly (docs/PLAN.md "Compiled agent env").
 *
 * SECRETS DISCIPLINE: secrets travel ONLY through this env map, handed to the
 * worker supervisor at ensure-agent time and injected at process spawn.
 * Generated files/artifacts never contain secrets — compiled code reads
 * `process.env.*`. Nothing in this module may log plaintext values.
 *
 * Injected per agent:
 * - WORKFLOW_POSTGRES_URL      → the version's DEDICATED world database
 *                                (ws_v_<hash12>; job prefix does NOT isolate —
 *                                design correction #10 / REPORT finding 11)
 * - WORKFLOW_POSTGRES_JOB_PREFIX → version hash, observability/log grouping ONLY
 * - WORKFLOW_POSTGRES_MAX_POOL_SIZE / _WORKER_CONCURRENCY → connection budget
 * - PLATFORM_JWT_SECRET        → channel-auth verification secret, DERIVED
 *                                per version (never the platform master)
 * - exactly ONE provider key   → matching the version's RESOLVED provider
 * - OPENROUTER_BASE_URL        → passthrough when set (test harnesses)
 * - MCP_<CONN>_TOKEN           → decrypted from mcp_connections auth envelopes
 */
import { inArray } from "drizzle-orm";
import { connectionTokenEnvVar } from "@invisible-string/compiler";
import { schema } from "@invisible-string/db";
import {
  decryptSecret,
  type EncryptedEnvelope,
  type MasterKey,
} from "@invisible-string/shared";

import { slugifyName } from "../build/compiler-adapter";
import type { Db } from "../db";
import { errors } from "./errors";
import { derivePlatformJwtSecret } from "./jwt";
import type { ModelProvider } from "./model-resolution";
import type { RuntimeConfig } from "./config";

/**
 * Env var name carrying an MCP connection's token. Derived from the SAME
 * slug pipeline the compiler uses (`connectionTokenEnvVar(slugifyName(name))`)
 * so the dispatcher-injected var and the generated code's read can never
 * drift — a previous independent upper-snake implementation diverged on
 * >64-char names (slug truncation), permanently failing publish with the
 * adapter's "token env var mismatch" guard.
 */
export function mcpConnectionSlug(connectionName: string): string {
  return slugifyName(connectionName) || "connection";
}

export function mcpTokenEnvName(connectionName: string): string {
  return connectionTokenEnvVar(mcpConnectionSlug(connectionName));
}

/**
 * Env var carrying one header value for a header-auth MCP connection —
 * `MCP_<SLUG>_HEADER_<HEADER>`. The compiler adapter and this dispatcher both
 * derive it from the SAME (slug, header) so the generated code's read and the
 * injected value can never drift.
 */
export function mcpHeaderEnvName(connectionName: string, header: string): string {
  const conn = mcpConnectionSlug(connectionName)
    .toUpperCase()
    .replaceAll("-", "_");
  const hdr = header
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `MCP_${conn}_HEADER_${hdr}`;
}

/**
 * AAD context binding an mcp_connections auth envelope to its row — writers
 * (Phase-2 CRUD/install flow) must use the same context.
 */
export function mcpAuthAadContext(connectionId: string): string {
  return `mcp_connections:auth_config:${connectionId}`;
}

/**
 * Decrypted auth-config shape stored (encrypted) on mcp_connections.
 * - bearer: `{ token }` (legacy) or `{ type: "bearer", token }`
 * - headers: `{ type: "headers", headers: { <name>: <value> } }`
 */
export type McpAuthConfig =
  | { type?: "bearer"; token: string }
  | { type: "headers"; headers: Record<string, string> };

/** Decrypt + parse one connection's stored auth config (or null when none). */
export function decryptMcpAuthConfig(
  authConfigEncrypted: string | null,
  masterKey: MasterKey | undefined,
  connectionId: string,
): McpAuthConfig | null {
  if (!authConfigEncrypted) return null;
  if (!masterKey) throw errors.encryptionKeyMissing();
  try {
    const envelope = JSON.parse(authConfigEncrypted) as EncryptedEnvelope;
    const plaintext = decryptSecret(envelope, masterKey, mcpAuthAadContext(connectionId));
    return JSON.parse(plaintext) as McpAuthConfig;
  } catch {
    throw errors.mcpSecretUnavailable(connectionId);
  }
}

/**
 * Non-secret shape of a connection's stored auth, for the compile path (which
 * must know the auth KIND and header NAMES to wire env-var reads without ever
 * baking secret VALUES into generated files).
 */
export type McpAuthShape =
  | { kind: "none" }
  | { kind: "bearer" }
  | { kind: "headers"; headerNames: string[] };

export function mcpAuthShape(
  authConfigEncrypted: string | null,
  masterKey: MasterKey | undefined,
  connectionId: string,
): McpAuthShape {
  const config = decryptMcpAuthConfig(authConfigEncrypted, masterKey, connectionId);
  if (!config) return { kind: "none" };
  if (config.type === "headers") {
    return { kind: "headers", headerNames: Object.keys(config.headers) };
  }
  return { kind: "bearer" };
}

/**
 * Decrypt MCP secrets for the given connection ids into agent env vars.
 * Bearer → `{ MCP_<NAME>_TOKEN }`; headers → one `MCP_<NAME>_HEADER_<H>` per
 * header. Connections without auth contribute nothing. Decryption failures are
 * typed 500s (never silently dropped — an agent booting without a credential
 * it needs is a worse failure mode).
 */
export async function decryptMcpEnv(
  db: Db,
  masterKey: MasterKey | undefined,
  connectionIds: string[],
): Promise<Record<string, string>> {
  if (connectionIds.length === 0) return {};
  const rows = await db
    .select({
      id: schema.mcpConnections.id,
      name: schema.mcpConnections.name,
      authConfigEncrypted: schema.mcpConnections.authConfigEncrypted,
    })
    .from(schema.mcpConnections)
    .where(inArray(schema.mcpConnections.id, connectionIds));

  const env: Record<string, string> = {};
  for (const row of rows) {
    const config = decryptMcpAuthConfig(row.authConfigEncrypted, masterKey, row.id);
    if (!config) continue;
    if (config.type === "headers") {
      for (const [header, value] of Object.entries(config.headers)) {
        env[mcpHeaderEnvName(row.name, header)] = value;
      }
    } else if (config.token) {
      env[mcpTokenEnvName(row.name)] = config.token;
    }
  }
  return env;
}

export interface BuildAgentEnvInput {
  runtime: RuntimeConfig;
  /** The version's dedicated world database URL (build/world.ts). */
  worldUrl: string;
  contentHash: string;
  provider: ModelProvider;
  /** Decrypted MCP token env ({@link decryptMcpEnv}). */
  mcpEnv: Record<string, string>;
}

/**
 * The full env map for one agent. Exactly ONE provider key is present —
 * the one matching the version's resolved (compiled-in) provider.
 */
export function buildAgentEnv(input: BuildAgentEnvInput): Record<string, string> {
  const { runtime, provider } = input;

  const providerKey =
    provider === "openrouter" ? runtime.openrouterApiKey : runtime.anthropicApiKey;
  if (!providerKey) throw errors.providerKeyMissing(provider);

  return {
    WORKFLOW_POSTGRES_URL: input.worldUrl,
    WORKFLOW_POSTGRES_JOB_PREFIX: input.contentHash,
    // Budget the Postgres connection count per agent process — graphile's
    // defaults (concurrency 50 vs pool 10) multiply badly at ~20
    // agents/worker (spike/REPORT.md finding 15).
    WORKFLOW_POSTGRES_MAX_POOL_SIZE: String(runtime.worldMaxPoolSize),
    WORKFLOW_POSTGRES_WORKER_CONCURRENCY: String(runtime.worldWorkerConcurrency),
    // PER-VERSION secret (never the platform master): a leaked agent env
    // cannot mint/verify tokens for any other workflow version.
    PLATFORM_JWT_SECRET: derivePlatformJwtSecret(
      runtime.platformJwtSecret,
      input.contentHash,
    ),
    // TEST HARNESS ONLY (see runtime/config.ts): eve's built-in mock model.
    ...(runtime.mockAuthoredModels ? { EVE_MOCK_AUTHORED_MODELS: "1" } : {}),
    ...(provider === "openrouter"
      ? {
          OPENROUTER_API_KEY: providerKey,
          ...(runtime.openrouterBaseUrl
            ? { OPENROUTER_BASE_URL: runtime.openrouterBaseUrl }
            : {}),
        }
      : { ANTHROPIC_API_KEY: providerKey }),
    ...input.mcpEnv,
  };
}
