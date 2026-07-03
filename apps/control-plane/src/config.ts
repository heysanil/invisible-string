/**
 * Environment configuration — parsed once at boot, fail-fast with readable
 * errors listing every problem at once (not just the first).
 */
import { parseMasterKey, type MasterKey } from "@invisible-string/shared";

export interface Config {
  /** HTTP port for the control-plane API (PORT, default 3000). */
  port: number;
  /** Product-data Postgres URL (DATABASE_URL). Better Auth + product tables. */
  databaseUrl: string;
  /** Better Auth signing secret (BETTER_AUTH_SECRET). */
  betterAuthSecret: string;
  /** Public base URL of this API (BETTER_AUTH_URL, default http://localhost:PORT). */
  betterAuthUrl: string;
  /** Allowed browser origins for CORS, credentials enabled (CORS_ORIGIN, comma-separated). */
  corsOrigins: string[];
  /**
   * Extra trusted origins for Better Auth (TRUSTED_ORIGINS, comma-separated).
   * Needed e.g. for OIDC IdPs on non-public hosts (Dex in dev/CI).
   */
  trustedOrigins: string[];
  /**
   * AES-256-GCM envelope master key (ENCRYPTION_MASTER_KEY, base64 32 bytes).
   * Optional until the first secret-bearing feature ships; validated when set.
   */
  encryptionMasterKey: MasterKey | undefined;
  /**
   * Block email/password sign-in until the address is verified
   * (AUTH_REQUIRE_EMAIL_VERIFICATION=1). Default off: local/CI stacks have no
   * mailer; production must enable it before any trust decision reads
   * `emailVerified` (account linking, domain-based org membership).
   */
  requireEmailVerification: boolean;
  /**
   * Emit `Strict-Transport-Security` on every response (SECURITY_HSTS=1).
   * Default off: only meaningful behind TLS, and enabling it on a plain-http
   * dev host would pin the browser to https for that origin. Turn on in
   * production where the control plane is fronted by TLS.
   */
  hstsEnabled: boolean;
}

export class ConfigError extends Error {
  override readonly name = "ConfigError";
  constructor(public readonly problems: string[]) {
    super(
      `invalid environment configuration:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  }
}

type Env = Record<string, string | undefined>;

/**
 * Parse configuration from an environment map. Throws {@link ConfigError}
 * listing all problems when anything required is missing or malformed.
 */
export function loadConfig(env: Env = process.env): Config {
  const problems: string[] = [];

  const port = parsePort(env.PORT, problems);

  const databaseUrl = requireVar(
    env,
    "DATABASE_URL",
    "postgres://user:pass@host:5432/product",
    problems,
  );
  if (databaseUrl && !/^postgres(ql)?:\/\//.test(databaseUrl)) {
    problems.push(
      `DATABASE_URL must be a postgres:// URL, got "${redact(databaseUrl)}"`,
    );
  }

  const betterAuthSecret = requireVar(
    env,
    "BETTER_AUTH_SECRET",
    "generate with `openssl rand -base64 32`",
    problems,
  );
  if (betterAuthSecret !== undefined && betterAuthSecret.length < 32) {
    // Signs every login session — a short secret is offline-brute-forceable.
    problems.push(
      "BETTER_AUTH_SECRET must be at least 32 characters — generate with `openssl rand -base64 32`",
    );
  }

  const betterAuthUrl = env.BETTER_AUTH_URL?.trim() || `http://localhost:${port}`;
  if (!isHttpUrl(betterAuthUrl)) {
    problems.push(
      `BETTER_AUTH_URL must be an http(s) URL, got "${betterAuthUrl}"`,
    );
  }

  const corsOrigins = splitList(env.CORS_ORIGIN) ?? ["http://localhost:5173"];
  for (const origin of corsOrigins) {
    if (!isHttpUrl(origin)) {
      problems.push(`CORS_ORIGIN entry "${origin}" is not an http(s) URL`);
    }
  }

  const trustedOrigins = splitList(env.TRUSTED_ORIGINS) ?? [];
  for (const origin of trustedOrigins) {
    if (!isHttpUrl(origin)) {
      problems.push(`TRUSTED_ORIGINS entry "${origin}" is not an http(s) URL`);
    }
  }

  let encryptionMasterKey: MasterKey | undefined;
  if (env.ENCRYPTION_MASTER_KEY?.trim()) {
    try {
      encryptionMasterKey = parseMasterKey(env.ENCRYPTION_MASTER_KEY);
    } catch (err) {
      problems.push(
        `ENCRYPTION_MASTER_KEY is invalid: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  const requireEmailVerification = parseBoolean(
    env.AUTH_REQUIRE_EMAIL_VERIFICATION,
    "AUTH_REQUIRE_EMAIL_VERIFICATION",
    problems,
  );

  const hstsEnabled = parseBoolean(env.SECURITY_HSTS, "SECURITY_HSTS", problems);

  if (problems.length > 0) throw new ConfigError(problems);

  return {
    port,
    databaseUrl: databaseUrl!,
    betterAuthSecret: betterAuthSecret!,
    betterAuthUrl,
    corsOrigins,
    trustedOrigins,
    encryptionMasterKey,
    requireEmailVerification,
    hstsEnabled,
  };
}

// ── helpers ─────────────────────────────────────────────────────────────────

function requireVar(
  env: Env,
  name: string,
  hint: string,
  problems: string[],
): string | undefined {
  const value = env[name]?.trim();
  if (!value) {
    problems.push(`${name} is required (${hint})`);
    return undefined;
  }
  return value;
}

function parsePort(raw: string | undefined, problems: string[]): number {
  if (raw === undefined || raw.trim() === "") return 3000;
  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    problems.push(`PORT must be an integer between 1 and 65535, got "${raw}"`);
    return 3000;
  }
  return port;
}

function parseBoolean(
  raw: string | undefined,
  name: string,
  problems: string[],
): boolean {
  const value = raw?.trim();
  if (!value) return false;
  if (["1", "true", "yes"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no"].includes(value.toLowerCase())) return false;
  problems.push(`${name} must be a boolean (1/0/true/false), got "${value}"`);
  return false;
}

function splitList(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  const entries = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return entries.length > 0 ? entries : undefined;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/** Hide credentials when echoing connection strings into error messages. */
function redact(url: string): string {
  return url.replace(/\/\/[^@/]+@/, "//***@");
}
