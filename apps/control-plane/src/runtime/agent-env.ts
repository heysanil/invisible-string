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
 * - PLATFORM_JWT_SECRET        → channel-auth verification secret
 * - exactly ONE provider key   → matching the version's RESOLVED provider
 * - OPENROUTER_BASE_URL        → passthrough when set (test harnesses)
 * - MCP_<CONN>_TOKEN           → decrypted from mcp_connections auth envelopes
 */
import { inArray } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import {
  decryptSecret,
  type EncryptedEnvelope,
  type MasterKey,
} from "@invisible-string/shared";

import type { Db } from "../db";
import { errors } from "./errors";
import type { ModelProvider } from "./model-resolution";
import type { RuntimeConfig } from "./config";

/**
 * Env var name carrying an MCP connection's token: `MCP_<NAME>_TOKEN` with
 * the connection name upper-snaked (non-alphanumerics collapse to `_`).
 * NOTE(integration): the compiler's emitted `connections/*.ts` must read the
 * SAME name — reconcile with packages/compiler when it lands.
 */
export function mcpTokenEnvName(connectionName: string): string {
  const slug = connectionName
    .toUpperCase()
    .replace(/[^A-Z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
  return `MCP_${slug || "CONNECTION"}_TOKEN`;
}

/**
 * AAD context binding an mcp_connections auth envelope to its row — writers
 * (Phase-2 install flow) must use the same context.
 */
export function mcpAuthAadContext(connectionId: string): string {
  return `mcp_connections:auth_config:${connectionId}`;
}

/** Decrypted auth-config shape stored (encrypted) on mcp_connections. */
interface McpAuthConfig {
  token?: string;
}

/**
 * Decrypt MCP tokens for the given connection ids →
 * `{ MCP_<NAME>_TOKEN: <plaintext> }`. Connections without auth contribute
 * nothing. Decryption failures are typed 500s (never silently dropped —
 * an agent booting without a credential it needs is a worse failure mode).
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
    if (!row.authConfigEncrypted) continue;
    if (!masterKey) throw errors.encryptionKeyMissing();
    let token: string | undefined;
    try {
      const envelope = JSON.parse(row.authConfigEncrypted) as EncryptedEnvelope;
      const plaintext = decryptSecret(envelope, masterKey, mcpAuthAadContext(row.id));
      token = (JSON.parse(plaintext) as McpAuthConfig).token;
    } catch {
      throw errors.mcpSecretUnavailable(row.id);
    }
    if (token) env[mcpTokenEnvName(row.name)] = token;
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
    PLATFORM_JWT_SECRET: runtime.platformJwtSecret,
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
