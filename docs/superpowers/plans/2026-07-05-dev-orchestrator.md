# Dev Orchestrator (`bun run dev`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One `bun run dev` at the repo root that bootstraps `.env`, brings up infra, migrates, and runs all three apps with unified prefixed logs.

**Architecture:** A root-level Bun script (`scripts/dev.ts`) orchestrates: env bootstrap → docker compose `--wait` → drizzle migrate → three `Bun.spawn` children with line-prefixed output and graceful Ctrl-C teardown. Pure logic (env transform/parse/merge, line prefixing) lives in unit-tested modules under `scripts/dev/`; the entrypoint is thin I/O glue verified manually.

**Tech Stack:** Bun 1.3+ (script runtime, `Bun.spawn`, `bun:test`), docker compose v2, drizzle migrator (existing `packages/db` script). **No new dependencies.**

**Spec:** `docs/superpowers/specs/2026-07-05-dev-orchestrator-design.md` — read it before starting.

## Global Constraints

- Commit messages: conventional style, **never mention AI assistance** — no Claude references, no `Co-Authored-By` trailers (AGENTS.md golden rule 1).
- Docs law: any behavior/command change updates every affected document **in the same commit** (AGENTS.md preamble). Task 3 therefore bundles README + AGENTS.md with the entrypoint.
- TypeScript strict everywhere; `scripts/` gets its own tsconfig extending `tsconfig.base.json` (Task 1).
- No new runtime or dev dependencies. Root `devDependencies` already has `typescript` and `@types/bun`.
- Local-dev scope only: do not touch CI workflows, test-harness compose projects (`p1acceptance`, `p2e2e`, …), per-app `dev` scripts, or production topology.
- `.env` is gitignored and must stay so; the bootstrap never overwrites an existing `.env`.
- Platform is macOS (darwin) for dev; the worker's compiled-in `/var/lib/agents` default is why the bootstrap sets `ARTIFACT_CACHE_DIR`.

---

### Task 1: Env bootstrap module (`scripts/dev/env.ts`)

**Files:**
- Create: `scripts/dev/env.ts`
- Create: `scripts/dev/env.test.ts`
- Create: `scripts/tsconfig.json`
- Modify: `package.json` (root — `typecheck` script)
- Modify: `.gitignore` (add `.dev/`)
- Modify: `.env.example` (add `ARTIFACT_CACHE_DIR` to the worker-app section)

**Interfaces:**
- Consumes: nothing (leaf module; no imports outside the platform).
- Produces (Task 3 imports these from `./dev/env`):
  - `GENERATED_SECRET_KEYS: readonly ["ENCRYPTION_MASTER_KEY", "PLATFORM_JWT_SECRET", "BETTER_AUTH_SECRET", "WORKER_SHARED_SECRET"]`
  - `parseEnv(content: string): Record<string, string>`
  - `bootstrapEnvContent(exampleContent: string, repoRoot: string, makeSecret?: () => string): { content: string; generated: string[] }`
  - `emptySecretKeys(env: Record<string, string>): string[]`
  - `mergeEnv(dotenv: Record<string, string>, processEnv: Record<string, string | undefined>): Record<string, string>`
  - `generateSecret(): string`

- [ ] **Step 1: Write the failing tests**

Create `scripts/dev/env.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import {
  GENERATED_SECRET_KEYS,
  bootstrapEnvContent,
  emptySecretKeys,
  generateSecret,
  mergeEnv,
  parseEnv,
} from "./env";

describe("parseEnv", () => {
  test("parses KEY=VALUE lines, ignoring comments and blanks", () => {
    const env = parseEnv("# comment\n\nFOO=bar\nBAZ=qux\n");
    expect(env).toEqual({ FOO: "bar", BAZ: "qux" });
  });

  test("preserves '=' inside values", () => {
    expect(parseEnv("URL=postgres://dev:dev@localhost:5432/product?a=b")).toEqual({
      URL: "postgres://dev:dev@localhost:5432/product?a=b",
    });
  });

  test("strips one layer of matching quotes", () => {
    expect(parseEnv(`A="hello world"\nB='single'\nC="unbalanced'`)).toEqual({
      A: "hello world",
      B: "single",
      C: `"unbalanced'`,
    });
  });

  test("later duplicate keys win", () => {
    expect(parseEnv("K=first\nK=second")).toEqual({ K: "second" });
  });

  test("keeps empty values as empty strings", () => {
    expect(parseEnv("EMPTY=")).toEqual({ EMPTY: "" });
  });
});

describe("generateSecret", () => {
  test("returns base64 of 32 random bytes, unique per call", () => {
    const a = generateSecret();
    const b = generateSecret();
    expect(Buffer.from(a, "base64")).toHaveLength(32);
    expect(a).not.toBe(b);
  });
});

describe("bootstrapEnvContent", () => {
  const example = [
    "# header comment",
    "DATABASE_URL=postgres://dev:dev@localhost:5432/product",
    "ENCRYPTION_MASTER_KEY=",
    "PLATFORM_JWT_SECRET=",
    "BETTER_AUTH_SECRET=",
    "WORKER_SHARED_SECRET=",
    "OPENROUTER_API_KEY=",
    "",
  ].join("\n");

  test("fills exactly the four generated-secret keys, deterministically", () => {
    let n = 0;
    const { content, generated } = bootstrapEnvContent(example, "/repo", () => `secret${++n}`);
    expect(generated).toEqual([...GENERATED_SECRET_KEYS]);
    expect(content).toContain("ENCRYPTION_MASTER_KEY=secret1");
    expect(content).toContain("PLATFORM_JWT_SECRET=secret2");
    expect(content).toContain("BETTER_AUTH_SECRET=secret3");
    expect(content).toContain("WORKER_SHARED_SECRET=secret4");
    // untouched lines survive verbatim
    expect(content).toContain("DATABASE_URL=postgres://dev:dev@localhost:5432/product");
    expect(content).toContain("OPENROUTER_API_KEY=");
    expect(content).toContain("# header comment");
  });

  test("appends ARTIFACT_CACHE_DIR under the repo root", () => {
    const { content } = bootstrapEnvContent(example, "/repo", () => "s");
    expect(content).toContain("ARTIFACT_CACHE_DIR=/repo/.dev/agent-cache");
  });

  test("leaves already-filled secrets alone and does not report them", () => {
    const prefilled = example.replace("ENCRYPTION_MASTER_KEY=", "ENCRYPTION_MASTER_KEY=existing");
    const { content, generated } = bootstrapEnvContent(prefilled, "/repo", () => "gen");
    expect(content).toContain("ENCRYPTION_MASTER_KEY=existing");
    expect(generated).toEqual(["PLATFORM_JWT_SECRET", "BETTER_AUTH_SECRET", "WORKER_SHARED_SECRET"]);
  });

  test("the real .env.example has all four secrets blank so bootstrap fills them", async () => {
    const real = await Bun.file(new URL("../../.env.example", import.meta.url)).text();
    const { generated } = bootstrapEnvContent(real, "/repo", () => "s");
    expect(generated).toEqual([...GENERATED_SECRET_KEYS]);
  });
});

describe("emptySecretKeys", () => {
  test("reports generated-secret keys that are blank or absent", () => {
    expect(
      emptySecretKeys({
        ENCRYPTION_MASTER_KEY: "set",
        PLATFORM_JWT_SECRET: "  ",
        BETTER_AUTH_SECRET: "",
      }),
    ).toEqual(["PLATFORM_JWT_SECRET", "BETTER_AUTH_SECRET", "WORKER_SHARED_SECRET"]);
  });

  test("empty when all four are set", () => {
    expect(
      emptySecretKeys({
        ENCRYPTION_MASTER_KEY: "a",
        PLATFORM_JWT_SECRET: "b",
        BETTER_AUTH_SECRET: "c",
        WORKER_SHARED_SECRET: "d",
      }),
    ).toEqual([]);
  });
});

describe("mergeEnv", () => {
  test("drops empty dotenv values so they cannot clobber shell env", () => {
    const merged = mergeEnv({ OPENROUTER_API_KEY: "", FOO: "from-dotenv" }, { PATH: "/bin" });
    expect(merged).toEqual({ FOO: "from-dotenv", PATH: "/bin" });
  });

  test("shell env wins over dotenv (Bun/dotenv precedence)", () => {
    const merged = mergeEnv({ FOO: "dotenv" }, { FOO: "shell" });
    expect(merged.FOO).toBe("shell");
  });

  test("skips undefined processEnv entries", () => {
    const merged = mergeEnv({ A: "1" }, { B: undefined, C: "2" });
    expect(merged).toEqual({ A: "1", C: "2" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test scripts/dev/env.test.ts`
Expected: FAIL — `Cannot find module './env'` (or equivalent resolution error).

- [ ] **Step 3: Write the implementation**

Create `scripts/dev/env.ts`:

```ts
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
 * write. Returns which keys were filled so the caller can report them.
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
  const content = `${body}\n\n# ── added by \`bun run dev\` bootstrap ────────────────────────────────────────\nARTIFACT_CACHE_DIR=${repoRoot}/.dev/agent-cache\n`;
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
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test scripts/dev/env.test.ts`
Expected: PASS (all tests, 0 fail).

- [ ] **Step 5: Wire `scripts/` into typecheck**

Create `scripts/tsconfig.json`:

```json
{
  "extends": "../tsconfig.base.json",
  "compilerOptions": {
    "types": ["bun"]
  },
  "include": ["**/*.ts"]
}
```

Modify root `package.json` — replace the `typecheck` script line:

```json
"typecheck": "bun run --filter='./apps/*' --filter='./packages/*' --filter='./tests/*' typecheck && tsc -p scripts"
```

Run: `bun run typecheck`
Expected: PASS (exit 0; the trailing `tsc -p scripts` emits nothing).

- [ ] **Step 6: Inventory + ignore housekeeping**

Modify `.gitignore` — add one line after the `.superpowers/` entry:

```
.dev/
```

Modify `.env.example` — in the `── Worker app (apps/worker)` section, insert directly **above** the `ARTIFACT_CACHE_MAX_BYTES` comment block:

```
# Extracted-artifact cache root. Default /var/lib/agents suits the Linux
# worker image but is not writable on macOS — `bun run dev` bootstrap points
# fresh .env files at <repo>/.dev/agent-cache (gitignored) instead.
# ARTIFACT_CACHE_DIR=/var/lib/agents
```

Run: `bun test scripts/dev/env.test.ts`
Expected: PASS (the real-`.env.example` regression test still passes).

- [ ] **Step 7: Commit**

```bash
git add scripts/dev/env.ts scripts/dev/env.test.ts scripts/tsconfig.json package.json .gitignore .env.example
git commit -m "feat(dev): env bootstrap module for the dev orchestrator"
```

---

### Task 2: Line-prefixer module (`scripts/dev/stream.ts`)

**Files:**
- Create: `scripts/dev/stream.ts`
- Test: `scripts/dev/stream.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces (Task 3 imports these from `./dev/stream`):
  - `PREFIX_COLORS: { api: string; worker: string; web: string }` (ANSI escape strings)
  - `createLinePrefixer(tag: string, color: string, width?: number): { push(chunk: string): string[]; flush(): string[] }`

- [ ] **Step 1: Write the failing tests**

Create `scripts/dev/stream.test.ts`:

```ts
import { describe, expect, test } from "bun:test";

import { PREFIX_COLORS, createLinePrefixer } from "./stream";

// Strip ANSI escapes so assertions read plainly.
function plain(lines: string[]): string[] {
  // eslint-disable-next-line no-control-regex
  return lines.map((l) => l.replace(/\x1b\[[0-9;]*m/g, ""));
}

describe("createLinePrefixer", () => {
  test("prefixes each complete line with the padded tag", () => {
    const p = createLinePrefixer("api", PREFIX_COLORS.api);
    expect(plain(p.push("hello\nworld\n"))).toEqual(["api   │ hello", "api   │ world"]);
  });

  test("holds partial lines across chunks", () => {
    const p = createLinePrefixer("web", PREFIX_COLORS.web);
    expect(p.push("par")).toEqual([]);
    expect(plain(p.push("tial\nnext"))).toEqual(["web   │ partial"]);
    expect(plain(p.flush())).toEqual(["web   │ next"]);
  });

  test("flush is empty when nothing is buffered", () => {
    const p = createLinePrefixer("worker", PREFIX_COLORS.worker);
    p.push("done\n");
    expect(p.flush()).toEqual([]);
  });

  test("strips a trailing carriage return per line", () => {
    const p = createLinePrefixer("api", PREFIX_COLORS.api);
    expect(plain(p.push("crlf\r\n"))).toEqual(["api   │ crlf"]);
  });

  test("colors wrap the prefix and reset before content", () => {
    const p = createLinePrefixer("api", PREFIX_COLORS.api);
    const [line] = p.push("x\n");
    expect(line).toStartWith(PREFIX_COLORS.api);
    expect(line).toContain("\x1b[0m");
    expect(line).toEndWith("x");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `bun test scripts/dev/stream.test.ts`
Expected: FAIL — `Cannot find module './stream'`.

- [ ] **Step 3: Write the implementation**

Create `scripts/dev/stream.ts`:

```ts
/** ANSI colors for the three app-log prefixes. */
export const PREFIX_COLORS = {
  api: "\x1b[36m", // cyan
  worker: "\x1b[35m", // magenta
  web: "\x1b[32m", // green
} as const;

const RESET = "\x1b[0m";

/**
 * Line-buffered prefixer: feed raw chunks, receive complete lines prefixed
 * `tag   │ …`. Partial lines are held across chunks; flush() drains the
 * remainder (a child that died mid-line).
 */
export function createLinePrefixer(
  tag: string,
  color: string,
  width = 6,
): { push(chunk: string): string[]; flush(): string[] } {
  const prefix = `${color}${tag.padEnd(width)}│${RESET} `;
  let partial = "";
  const format = (line: string): string =>
    prefix + (line.endsWith("\r") ? line.slice(0, -1) : line);
  return {
    push(chunk: string): string[] {
      const parts = (partial + chunk).split("\n");
      partial = parts.pop() ?? "";
      return parts.map(format);
    },
    flush(): string[] {
      if (partial === "") return [];
      const line = format(partial);
      partial = "";
      return [line];
    },
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `bun test scripts/dev/stream.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add scripts/dev/stream.ts scripts/dev/stream.test.ts
git commit -m "feat(dev): line-buffered log prefixer for the dev orchestrator"
```

---

### Task 3: Orchestrator entrypoint + scripts + docs (one commit — docs law)

**Files:**
- Create: `scripts/dev.ts`
- Modify: `package.json` (root — `dev` and new `dev:down` scripts)
- Modify: `README.md` ("Run the full stack" quickstart subsection)
- Modify: `AGENTS.md` ("Toolchain & setup" dev-servers bullet)

**Interfaces:**
- Consumes: `parseEnv`, `bootstrapEnvContent`, `emptySecretKeys`, `mergeEnv` from `./dev/env` (Task 1); `createLinePrefixer`, `PREFIX_COLORS` from `./dev/stream` (Task 2).
- Produces: the `bun run dev` / `bun run dev:down` commands — no code consumers.

- [ ] **Step 1: Write the entrypoint**

Create `scripts/dev.ts`:

```ts
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
  sink: typeof process.stdout,
): void {
  const prefixer = createLinePrefixer(tag, color);
  const decoder = new TextDecoder();
  void (async () => {
    for await (const chunk of stream) {
      for (const line of prefixer.push(decoder.decode(chunk, { stream: true }))) {
        sink.write(`${line}\n`);
      }
    }
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
  note("apps stopped — infra still running (`bun run dev:down` stops it)");
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
```

- [ ] **Step 2: Wire the root scripts**

Modify root `package.json` `scripts` — replace `"dev"` and add `"dev:down"`:

```json
"dev": "bun run scripts/dev.ts",
"dev:down": "docker compose down"
```

Run: `bun run typecheck`
Expected: PASS (scripts tsconfig from Task 1 now covers `dev.ts`).

- [ ] **Step 3: Manual verification — cold boot**

Preserve any existing `.env` first; it may hold real keys:

```bash
[ -f .env ] && mv .env .env.manual-test-backup
bun run dev
```

Expected, in order:
1. `◇ .env not found — created with generated secrets (ENCRYPTION_MASTER_KEY, PLATFORM_JWT_SECRET, BETTER_AUTH_SECRET, WORKER_SHARED_SECRET)`
2. `◇ infra healthy (postgres, minio, dex) · bucket ok  …s`
3. `◇ migrations current`
4. Interleaved `api   │`, `worker│`, `web   │` lines; control-plane on :3000, Vite on :5173.

From a second terminal while it runs:

```bash
curl -sf http://localhost:3000/api/health && echo API-OK
curl -sf http://localhost:5173 >/dev/null && echo WEB-OK
grep ARTIFACT_CACHE_DIR .env   # → <repo>/.dev/agent-cache
```

Expected: `API-OK`, `WEB-OK`, and the cache-dir line.

- [ ] **Step 4: Manual verification — Ctrl-C, warm boot, dev:down**

1. Ctrl-C the orchestrator. Expected: `◇ apps stopped — infra still running…`; `docker compose ps` still lists postgres/minio/dex.
2. `bun run dev` again (warm). Expected: no bootstrap line (`.env` exists), infra step returns in ~1 s, apps boot.
3. Ctrl-C, then `bun run dev:down`. Expected: `docker compose ps` shows no running services.
4. Restore the real env: `[ -f .env.manual-test-backup ] && mv -f .env.manual-test-backup .env` (removes the test-generated `.env` in the same stroke; if no backup existed, `rm .env` instead so your real bootstrap runs fresh next time — or keep it if you want the generated one).

- [ ] **Step 5: Manual verification — steady-state crash banner**

Start `bun run dev`, wait >15 s, then from another terminal kill one child (find it via `pgrep -f "apps/control-plane" | head -1`, then `kill <pid>`). Expected: red banner `✖ api exited with code … — other apps still running`, worker and web keep logging. Ctrl-C to stop.

- [ ] **Step 6: Update the docs (same commit — docs law)**

`README.md` — replace the "Run the full stack" code block + surrounding text with:

````markdown
### Run the full stack

```sh
bun run dev
```

One command: bootstraps `.env` on first run (generates the four platform
secrets; provider keys stay blank until you add them), starts Postgres, MinIO,
and Dex and waits for health, applies migrations, then runs the API (:3000),
worker, and SPA (:5173) with prefixed logs in one terminal. Ctrl-C stops the
apps and leaves infra running; `bun run dev:down` stops the containers.

<details>
<summary>Manual, step-by-step equivalent (for debugging individual pieces)</summary>

```sh
# local infra: Postgres, MinIO, Dex IdP
docker compose up -d postgres minio dex

# apply migrations (Better Auth + product tables live in packages/db)
DATABASE_URL=postgres://dev:dev@localhost:5432/product bun run --cwd packages/db migrate

# secrets for running the apps (tests provision their own env)
cp .env.example .env    # then fill in values

# terminal 1 — API host (:3000)
bun run --cwd apps/control-plane dev
# terminal 2 — SPA (:5173, reads VITE_API_URL)
bun run --cwd apps/web dev
# terminal 3 — worker
bun run --cwd apps/worker dev
```

</details>
````

`AGENTS.md` — in "Toolchain & setup", replace the final bullet ("Dev servers: …") with:

```markdown
- Dev servers: `bun run dev` at the root does it all — bootstraps `.env` with generated secrets on first run, `docker compose up --wait`, migrations, then API (:3000) + worker + SPA (:5173) with prefixed logs; Ctrl-C stops the apps, `bun run dev:down` stops infra. Individual apps: `bun run --cwd apps/<x> dev`. Backend-free UI preview: `VITE_FIXTURE_MODE=1`.
```

Then sweep for stale references to the old three-terminal flow:

```bash
grep -rn "terminal 1\|terminal 2\|terminal 3" README.md AGENTS.md docs/ e2e/README.md
```

Expected: hits only inside the new README `<details>` block (the preserved manual path). Fix any others.

- [ ] **Step 7: Full gates, then commit everything together**

```bash
bun run typecheck && bun test
git add scripts/dev.ts package.json README.md AGENTS.md
git commit -m "feat(dev): one-command dev orchestrator (bun run dev)"
```

Expected: typecheck exit 0; `bun test` all pass (DB-gated suites skip cleanly).

---

## Self-Review Checklist (run after drafting — already applied)

- Spec coverage: UX (Task 3 steps 1–2), env bootstrap (Task 1 + dev.ts §1), preflight/infra/migrate/crash policy (dev.ts §2–5), testing (Tasks 1–2 TDD + Task 3 manual steps), docs impact (Task 1 step 6 + Task 3 step 6), future-work note lives in the spec — nothing to build.
- "Report ready" from the spec's crash policy is mechanized as the 15 s `STARTUP_WINDOW_MS` per child — log-parsing readiness was rejected as brittle.
- Type consistency: `bootstrapEnvContent` returns `{ content, generated }` everywhere; `createLinePrefixer` returns `{ push, flush }` everywhere; `mergeEnv(dotenv, processEnv)` argument order consistent between test and dev.ts.
