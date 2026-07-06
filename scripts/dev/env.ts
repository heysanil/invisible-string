/**
 * Pure .env logic for scripts/dev.ts. No file I/O here — the orchestrator
 * reads/writes files; these functions transform strings so the behavior runs
 * in the default `bun test` lane.
 */

/** Secrets the bootstrap generates when creating a fresh .env. */
export const GENERATED_SECRET_KEYS = [
  "ENCRYPTION_MASTER_KEY",
  "PLATFORM_JWT_SECRET",
  "BETTER_AUTH_SECRET",
  "WORKER_SHARED_SECRET",
] as const;

/**
 * Minimal .env parser: KEY=VALUE lines; comments and blanks ignored; one
 * layer of matching single/double quotes stripped; later duplicates win.
 */
export function parseEnv(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    let value = line.slice(eq + 1).trim();
    if (
      value.length >= 2 &&
      ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'")))
    ) {
      value = value.slice(1, -1);
    }
    out[key] = value;
  }
  return out;
}

/** 32 random bytes, base64 — same shape as `openssl rand -base64 32`. */
export function generateSecret(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64");
}

/**
 * Transform .env.example content into a fresh .env: fill each blank
 * generated-secret line (`KEY=`) and append ARTIFACT_CACHE_DIR — the worker's
 * compiled-in default is /var/lib/agents, which macOS dev machines can't
 * write — plus ALLOW_INSECURE_WORKER_TRANSPORT=1, since dev workers register
 * over http://localhost and the template keeps that flag commented out to
 * stay secure by default. Returns which keys were filled so the caller can
 * report them.
 */
export function bootstrapEnvContent(
  exampleContent: string,
  repoRoot: string,
  makeSecret: () => string = generateSecret,
): { content: string; generated: string[] } {
  const generated: string[] = [];
  const lines = exampleContent.split("\n").map((line) => {
    for (const key of GENERATED_SECRET_KEYS) {
      if (line === `${key}=`) {
        generated.push(key);
        return `${key}=${makeSecret()}`;
      }
    }
    return line;
  });
  const body = lines.join("\n").replace(/\n+$/, "");
  const content = `${body}\n\n# ── added by \`bun run dev\` bootstrap ────────────────────────────────────────\nARTIFACT_CACHE_DIR=${repoRoot}/.dev/agent-cache\n# Dev workers register over http://localhost, not https://.\nALLOW_INSECURE_WORKER_TRANSPORT=1\n`;
  return { content, generated };
}

/** Generated-secret keys that are blank or missing in an existing .env. */
export function emptySecretKeys(env: Record<string, string>): string[] {
  return GENERATED_SECRET_KEYS.filter((key) => !env[key]?.trim());
}

/**
 * Child-process env: dotenv values under the real environment (shell wins,
 * matching Bun's own .env precedence), with empty dotenv values dropped so
 * blank placeholder lines (`OPENROUTER_API_KEY=`) can't clobber shell vars.
 */
export function mergeEnv(
  dotenv: Record<string, string>,
  processEnv: Record<string, string | undefined>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(dotenv)) {
    if (value !== "") out[key] = value;
  }
  for (const [key, value] of Object.entries(processEnv)) {
    if (value !== undefined) out[key] = value;
  }
  return out;
}
