/**
 * One-command dev loop. Design:
 * docs/superpowers/specs/2026-07-05-dev-orchestrator-design.md
 *
 * Sequence: bootstrap .env (first run only) → docker compose up --wait →
 * migrate → spawn api/worker/web with prefixed logs. Ctrl-C stops the apps
 * and leaves infra running; `bun run dev:down` stops infra.
 */
import { existsSync, readdirSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { bootstrapEnvContent, emptySecretKeys, mergeEnv, parseEnv } from "./dev/env";
import { PREFIX_COLORS, createLinePrefixer } from "./dev/stream";

const repoRoot = join(import.meta.dir, "..");
// A child that dies this early failed to boot (watchers self-restart on file
// changes, so exits are config/boot failures, not routine edits).
const STARTUP_WINDOW_MS = 15_000;
const SHUTDOWN_GRACE_MS = 5_000;

const note = (msg: string): void => console.log(`\x1b[2m◇\x1b[0m ${msg}`);
const warn = (msg: string): void => console.warn(`\x1b[33m⚠ ${msg}\x1b[0m`);

function fail(msg: string): never {
  console.error(`\x1b[31m✖ ${msg}\x1b[0m`);
  process.exit(1);
}

async function run(cmd: string[], env: Record<string, string>): Promise<void> {
  const proc = Bun.spawn({ cmd, cwd: repoRoot, env, stdout: "inherit", stderr: "inherit" });
  if ((await proc.exited) !== 0) fail(`command failed: ${cmd.join(" ")}`);
}

// ── 1 · env bootstrap ───────────────────────────────────────────────────────
const envPath = join(repoRoot, ".env");
if (!existsSync(envPath)) {
  const example = await readFile(join(repoRoot, ".env.example"), "utf8");
  const { content, generated } = bootstrapEnvContent(example, repoRoot);
  await writeFile(envPath, content, { mode: 0o600 });
  note(`.env not found — created with generated secrets (${generated.join(", ")})`);
  note("copilot + keyed lanes stay off until OPENROUTER_API_KEY or ANTHROPIC_API_KEY is set in .env");
}
const dotenv = parseEnv(await readFile(envPath, "utf8"));
for (const key of emptySecretKeys(dotenv)) {
  warn(`.env has empty ${key} — the stack may not boot correctly`);
}
// Explicit env for children: Bun's dotenv loading is cwd-relative and the apps
// run under --cwd, so inheritance is the only reliable delivery path.
const childEnv = mergeEnv(dotenv, process.env);

// ── 2 · preflight ───────────────────────────────────────────────────────────
{
  const probe = Bun.spawn({ cmd: ["docker", "info"], stdout: "ignore", stderr: "ignore" });
  if ((await probe.exited) !== 0) fail("docker daemon unreachable — start Docker Desktop and retry");
}

async function node24Available(): Promise<boolean> {
  if (childEnv.WORKER_NODE_BIN?.trim()) return true;
  // Mirrors apps/worker/src/config.ts resolveNodeBin: mise installs, then PATH.
  const installs = join(process.env.HOME ?? "", ".local/share/mise/installs/node");
  if (existsSync(installs) && readdirSync(installs).some((d) => /^24\./.test(d))) return true;
  const probe = Bun.spawn({ cmd: ["node", "--version"], stdout: "pipe", stderr: "ignore" });
  const version = await new Response(probe.stdout).text();
  return (await probe.exited) === 0 && version.startsWith("v24.");
}
if (!(await node24Available())) {
  warn("Node 24 not found (`mise install node@24`) — the worker will boot but cannot launch agents");
}

// ── 3 · infra ───────────────────────────────────────────────────────────────
const infraStart = Date.now();
await run(["docker", "compose", "up", "-d", "--wait", "postgres", "minio", "dex"], childEnv);
await run(["docker", "compose", "run", "--rm", "minio-init"], childEnv);
note(`infra healthy (postgres, minio, dex) · bucket ok  ${((Date.now() - infraStart) / 1000).toFixed(1)}s`);

// ── 4 · migrate ─────────────────────────────────────────────────────────────
if (!childEnv.DATABASE_URL) fail(".env is missing DATABASE_URL");
await run(["bun", "run", "--cwd", "packages/db", "migrate"], childEnv);
note("migrations current");

// ── 5 · apps ────────────────────────────────────────────────────────────────
if (childEnv.ARTIFACT_CACHE_DIR) {
  await mkdir(childEnv.ARTIFACT_CACHE_DIR, { recursive: true });
}

const APPS = [
  { tag: "api", color: PREFIX_COLORS.api, dir: "apps/control-plane" },
  { tag: "worker", color: PREFIX_COLORS.worker, dir: "apps/worker" },
  { tag: "web", color: PREFIX_COLORS.web, dir: "apps/web" },
] as const;

type Child = { tag: string; proc: ReturnType<typeof Bun.spawn> };
const children: Child[] = [];
let shuttingDown = false;

function pipe(
  tag: string,
  color: string,
  stream: ReadableStream<Uint8Array>,
  sink: { write(chunk: string): unknown },
): void {
  const prefixer = createLinePrefixer(tag, color);
  const decoder = new TextDecoder();
  void (async () => {
    for await (const chunk of stream) {
      for (const line of prefixer.push(decoder.decode(chunk, { stream: true }))) {
        sink.write(`${line}\n`);
      }
    }
    // Flush the decoder's own tail (a child dying mid-multibyte character
    // leaves bytes buffered inside TextDecoder, not the line prefixer).
    for (const line of prefixer.push(decoder.decode())) sink.write(`${line}\n`);
    for (const line of prefixer.flush()) sink.write(`${line}\n`);
  })();
}

async function shutdown(code: number): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  for (const { proc } of children) proc.kill("SIGTERM");
  await Promise.race([
    Promise.all(children.map(({ proc }) => proc.exited)),
    Bun.sleep(SHUTDOWN_GRACE_MS),
  ]);
  for (const { proc } of children) {
    if (proc.exitCode === null) proc.kill("SIGKILL");
  }
  note(
    children.length === 0
      ? "stopped — infra still running (`bun run dev:down` stops it)"
      : "apps stopped — infra still running (`bun run dev:down` stops it)",
  );
  process.exit(code);
}

process.on("SIGINT", () => void shutdown(0));
process.on("SIGTERM", () => void shutdown(0));

for (const app of APPS) {
  const startedAt = Date.now();
  const proc = Bun.spawn({
    cmd: ["bun", "run", "dev"],
    cwd: join(repoRoot, app.dir),
    env: childEnv,
    stdout: "pipe",
    stderr: "pipe",
  });
  children.push({ tag: app.tag, proc });
  pipe(app.tag, app.color, proc.stdout, process.stdout);
  pipe(app.tag, app.color, proc.stderr, process.stderr);
  void proc.exited.then((code) => {
    if (shuttingDown) return;
    const uptime = Date.now() - startedAt;
    if (uptime < STARTUP_WINDOW_MS) {
      console.error(`\x1b[31m✖ ${app.tag} exited with code ${code} during startup — aborting\x1b[0m`);
      void shutdown(1);
    } else {
      const rule = "─".repeat(72);
      console.error(
        `\x1b[31m${rule}\n✖ ${app.tag} exited with code ${code} — other apps still running (Ctrl-C to stop)\n${rule}\x1b[0m`,
      );
    }
  });
}
