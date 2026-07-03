/**
 * Managed-process helpers for the global setup/teardown: spawn long-lived
 * detached children (control-plane, worker, vite preview, stub MCP), poll a
 * readiness URL, and persist enough state to kill everything on teardown.
 *
 * Runs under Node (the Playwright runner), so it only uses node:child_process
 * and node:fs — never Bun APIs.
 */
import { spawn, spawnSync, type SpawnOptions } from "node:child_process";
import { existsSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { RUNTIME_DIR, STATE_FILE } from "../config.ts";

export interface ManagedProcess {
  name: string;
  pid: number;
  logFile: string;
}

export interface HarnessState {
  processes: ManagedProcess[];
  composeProject: string;
}

export function ensureRuntimeDir(): void {
  mkdirSync(RUNTIME_DIR, { recursive: true });
}

/** Spawn a detached, log-redirected child and return its handle. */
export function spawnManaged(
  name: string,
  command: string,
  args: string[],
  options: { cwd: string; env: Record<string, string | undefined> },
): ManagedProcess {
  ensureRuntimeDir();
  const logFile = join(RUNTIME_DIR, `${name}.log`);
  const fd = openSync(logFile, "w");
  const child = spawn(command, args, {
    cwd: options.cwd,
    env: options.env as NodeJS.ProcessEnv,
    detached: true,
    stdio: ["ignore", fd, fd],
  } satisfies SpawnOptions);
  child.unref();
  if (child.pid === undefined) {
    throw new Error(`failed to spawn ${name} (${command})`);
  }
  return { name, pid: child.pid, logFile };
}

/** Run a command to completion, inheriting stdio; throws on non-zero exit. */
export function run(
  command: string,
  args: string[],
  options: { cwd: string; env?: Record<string, string | undefined> } = {
    cwd: process.cwd(),
  },
): void {
  const result = spawnSync(command, args, {
    cwd: options.cwd,
    env: (options.env ?? process.env) as NodeJS.ProcessEnv,
    stdio: "inherit",
  });
  if (result.status !== 0) {
    throw new Error(
      `command failed (${result.status ?? result.signal}): ${command} ${args.join(" ")}`,
    );
  }
}

/** Run a command, swallowing any failure (e.g. pkill with nothing to match). */
export function runQuiet(command: string, args: string[], cwd: string): void {
  spawnSync(command, args, { cwd, stdio: "ignore" });
}

export function saveState(state: HarnessState): void {
  ensureRuntimeDir();
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

export function loadState(): HarnessState | null {
  if (!existsSync(STATE_FILE)) return null;
  try {
    return JSON.parse(readFileSync(STATE_FILE, "utf8")) as HarnessState;
  } catch {
    return null;
  }
}

/** Poll a URL until it responds (any status) or the deadline passes. */
export async function waitForHttp(
  url: string,
  opts: { timeoutMs?: number; intervalMs?: number; expectOk?: boolean } = {},
): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  const interval = opts.intervalMs ?? 400;
  let lastError = "no attempt made";
  for (;;) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(2_000) });
      if (!opts.expectOk || res.ok) return;
      lastError = `status ${res.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${url} (last: ${lastError})`);
    }
    await sleep(interval);
  }
}

/** Poll an arbitrary async predicate until truthy or the deadline passes. */
export async function waitFor(
  predicate: () => Promise<boolean> | boolean,
  what: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  const deadline = Date.now() + (opts.timeoutMs ?? 60_000);
  const interval = opts.intervalMs ?? 400;
  for (;;) {
    if (await predicate()) return;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await sleep(interval);
  }
}

export function killPid(pid: number): void {
  try {
    // Negative pid → kill the whole detached process group.
    process.kill(-pid, "SIGTERM");
  } catch {
    try {
      process.kill(pid, "SIGTERM");
    } catch {
      /* already gone */
    }
  }
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
