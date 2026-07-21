/** Read a REQUIRED env var (secrets are injected by the worker supervisor). */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
}
