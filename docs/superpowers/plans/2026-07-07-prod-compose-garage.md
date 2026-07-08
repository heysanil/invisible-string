# Production Compose + Garage Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **EXECUTED 2026-07-07** (commits `653a891`…`6165966`). The committed code is the
> source of truth; four reviewed deviations from this plan's literal text:
> 1. Garage needs `--default-access-key --default-bucket` CLI flags in addition to
>    the `GARAGE_DEFAULT_*` env vars (both compose files carry them).
> 2. The web gateway proxy regex also includes `/sessions` and `/runs` — the plan's
>    7-prefix list would have swallowed the chat/run surface (see `infra/nginx/web.conf`).
> 3. The prod web healthcheck targets `127.0.0.1`, not `localhost` (alpine busybox
>    resolves localhost to ::1; nginx listens on IPv4 only).
> 4. `.gitignore` gained `!.env.prod.example` so that template is committable.

**Goal:** Ship a production single-host `docker-compose.prod.yml` (Dokploy-hosted, GHCR images) and migrate the object store from MinIO to Garage across dev, CI, and prod.

**Architecture:** Three new GHCR images (control-plane = Bun + Node 24 + npm; worker = Bun + Node 24 + docker CLI; web = Vite build → nginx SPA-server-plus-API-gateway) composed on a private bridge with postgres + Garage; only `web` joins the hoster's external proxy network. Garage v2.3's `--single-node` + `GARAGE_DEFAULT_*` env vars replace the entire minio-init ceremony.

**Tech Stack:** Docker Compose (≥ 2.24 for `!reset`/`!override` in overrides), Garage `dxflrs/garage:v2.3.0`, `oven/bun:1.3`, `node:24.18.0-bookworm-slim` (binary copy), `nginx:1.29-alpine`, GitHub Actions + GHCR.

**Spec:** `docs/superpowers/specs/2026-07-07-prod-compose-design.md`. Two deliberate simplifications vs. the spec (recorded as a spec addendum in Task 8):
1. **No `garage-init` one-shot** — Garage v2.3 auto-initializes single-node layout (`--single-node`) and auto-creates key + bucket (`GARAGE_DEFAULT_ACCESS_KEY/SECRET_KEY/BUCKET`), verified empirically in Task 1.
2. **No `infra/postgres-init.prod.sh`** — the existing `infra/postgres-init.sh` is credential-free and generic over `$POSTGRES_USER`; prod mounts the same script.

## Global Constraints

- Commit messages: conventional style (`feat:`, `fix:`, `integrate:`, `test(e2e):`), **never any AI/Claude references or Co-Authored-By trailers**.
- Docs are code: every task that changes behavior updates the affected docs **in the same commit** (AGENTS.md golden rule).
- Secrets never touch git: all prod values arrive via environment; compose uses `${VAR:?}` fail-fast interpolation. Dev/test credentials are hardcoded throwaways only in dev-facing files (same policy as today's dev compose).
- Path parity: `AGENT_BUILD_ROOT` (control-plane) and `ARTIFACT_CACHE_DIR` (worker) must both be `/var/lib/agents` — compiled artifacts bake absolute paths.
- Version pins (exact): Garage `dxflrs/garage:v2.3.0` · Node `24.18.0` (from `packages/compiler/versions.json`) · Bun base `oven/bun:1.3` · `postgres:16` (matches dev) · `nginx:1.29-alpine` · `docker:28-cli` · `cloudflare/cloudflared:2026.6.0`. For the last three: if the exact tag is missing on Docker Hub (`docker manifest inspect <image>` fails), substitute the newest same-major tag and use it consistently.
- Throwaway dev Garage credentials (used across dev compose, `.env.example`, harness defaults — Garage requires `GK` + 32 hex for access keys):
  - access key: `GKdeadbeefdeadbeefdeadbeefdeadbeef`
  - secret key: `cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe`
  - rpc secret: `0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef`
- GHCR image names: `ghcr.io/heysanil/invisible-string-{control-plane,worker,web}`.
- Node 24 runs eve; Bun runs the platform. Never let real provider keys into build env.
- Run commands from the repo root unless a step says otherwise.

---

### Task 1: Garage replaces MinIO in the dev compose (proven by a live store round-trip test)

**Files:**
- Create: `infra/garage.toml`
- Create: `tests/integration/garage-store.test.ts`
- Modify: `docker-compose.yml` (replace `minio` + `minio-init` services, volume, header comment)
- Modify: `.env.example:19-25` (S3 section) and `:152-156` (port overrides)
- Modify: `apps/control-plane/src/artifacts.ts` (comment mentions of MinIO)
- Modify: `apps/control-plane/src/artifacts.test.ts:17-20` (offline test literals)

**Interfaces:**
- Consumes: `createArtifactStore(config)` from `apps/control-plane/src/artifacts.ts` (exists; signature unchanged).
- Produces: a dev compose `garage` service on host port `${GARAGE_PORT:-3900}` with bucket `artifacts` and the throwaway credentials above. Every later task assumes service name `garage`, S3 endpoint `http://localhost:3900` (host) / `http://garage:3900` (in-network), env var `GARAGE_PORT` for host-port override, and gate env var `TEST_S3_ENDPOINT` for the live test.

- [ ] **Step 1: Write the failing live round-trip test**

Create `tests/integration/garage-store.test.ts`:

```ts
/**
 * Live Garage round-trip for the artifact store (gated).
 *
 * Skips cleanly unless TEST_S3_ENDPOINT is set (same pattern as the
 * TEST_DATABASE_URL-gated suites). Local + CI runs point it at the dev
 * compose garage service:
 *
 *   docker compose up -d --wait garage
 *   TEST_S3_ENDPOINT=http://localhost:3900 bun test tests/integration/garage-store.test.ts
 */
import { describe, expect, test } from "bun:test";

import { createArtifactStore } from "../../apps/control-plane/src/artifacts";

const endpoint = process.env.TEST_S3_ENDPOINT;
const describeGated = endpoint ? describe : describe.skip;

describeGated("garage artifact store (live)", () => {
  const store = createArtifactStore({
    endpoint: endpoint!,
    accessKeyId:
      process.env.S3_ACCESS_KEY_ID ?? "GKdeadbeefdeadbeefdeadbeefdeadbeef",
    secretAccessKey:
      process.env.S3_SECRET_ACCESS_KEY ??
      "cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe",
    bucket: process.env.S3_BUCKET ?? "artifacts",
    region: process.env.S3_REGION ?? "us-east-1",
  });
  const key = `artifacts/__garage_roundtrip_${crypto.randomUUID()}.tar.gz`;

  test("put → exists → get → presigned fetch round-trip", async () => {
    const payload = new TextEncoder().encode("garage-roundtrip-proof");
    await store.put(key, payload);

    expect(await store.exists(key)).toBe(true);
    expect(await store.exists(`${key}.missing`)).toBe(false);

    const body = new Uint8Array(await store.getArrayBuffer(key));
    expect(new TextDecoder().decode(body)).toBe("garage-roundtrip-proof");

    // Presigned GET is exactly what a worker does on ensure-agent:
    // a plain fetch with no credentials.
    const url = store.presignGetUrl(key, { expiresInSeconds: 60 });
    const res = await fetch(url);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("garage-roundtrip-proof");
  });
});
```

- [ ] **Step 2: Run it to confirm it fails against nothing**

Run: `TEST_S3_ENDPOINT=http://localhost:3900 bun test tests/integration/garage-store.test.ts`
Expected: FAIL (connection refused — no garage service exists yet). Without the env var it must SKIP: `bun test tests/integration/garage-store.test.ts` → 0 fail, tests skipped.

- [ ] **Step 3: Create `infra/garage.toml`**

```toml
# Garage (S3-compatible object store) — single-node config shared by the dev
# and prod compose stacks. The RPC secret comes from the environment
# (GARAGE_RPC_SECRET): a hardcoded throwaway in docker-compose.yml for dev,
# an operator-provided secret in docker-compose.prod.yml.
metadata_dir = "/var/lib/garage/meta"
data_dir = "/var/lib/garage/data"
db_engine = "sqlite"

replication_factor = 1

rpc_bind_addr = "[::]:3901"
rpc_public_addr = "127.0.0.1:3901"

[s3_api]
# Must match the platform's S3_REGION (SigV4 embeds the region).
s3_region = "us-east-1"
api_bind_addr = "[::]:3900"
root_domain = ".s3.garage.localhost"

[admin]
api_bind_addr = "[::]:3903"
```

- [ ] **Step 4: Swap the dev compose services**

In `docker-compose.yml`, delete the `minio` and `minio-init` service blocks (lines 31–60) and the `minio-data` volume, and add in their place:

```yaml
  garage:
    image: dxflrs/garage:v2.3.0
    # --single-node auto-initializes the cluster layout; the GARAGE_DEFAULT_*
    # vars auto-create the access key + "artifacts" bucket on first boot
    # (Garage ≥ v2.3). No init one-shot needed (unlike the old minio-init).
    command: ["/garage", "server", "--single-node"]
    ports:
      - "${GARAGE_PORT:-3900}:3900"
    environment:
      GARAGE_RPC_SECRET: 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef
      GARAGE_DEFAULT_ACCESS_KEY: GKdeadbeefdeadbeefdeadbeefdeadbeef
      GARAGE_DEFAULT_SECRET_KEY: cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe
      GARAGE_DEFAULT_BUCKET: artifacts
    volumes:
      - ./infra/garage.toml:/etc/garage.toml:ro
      - garage-data:/var/lib/garage
    healthcheck:
      test: ["CMD", "/garage", "json-api", "GetClusterHealth"]
      interval: 5s
      timeout: 3s
      retries: 12
```

Rename the volume in the top-level `volumes:` block (`minio-data:` → `garage-data:`). Update the file's header comment (lines 1–10): the credential inventory sentence should now say "Postgres dev/dev, Garage GK… throwaway key, Dex client secret …". Update the `minio-init` reference in the comment above where it used to be (delete it).

Fallbacks if verification below fails (try in order, re-verify after each):
- If the image has an entrypoint that conflicts with `command`: check `docker inspect dxflrs/garage:v2.3.0 --format '{{.Config.Entrypoint}} {{.Config.Cmd}}'` and set `command: ["server", "--single-node"]` if the entrypoint is `/garage`.
- If the `json-api GetClusterHealth` healthcheck never turns healthy while the S3 API works: replace the test with `["CMD", "/garage", "status"]`.
- If `GARAGE_DEFAULT_ACCESS_KEY` rejects the key format: it must be `GK` + 32 lowercase hex chars — the constant above already is; check container logs (`docker compose logs garage`) for the actual validation message.

- [ ] **Step 5: Bring it up and make the test pass**

```bash
docker compose up -d --wait garage
TEST_S3_ENDPOINT=http://localhost:3900 bun test tests/integration/garage-store.test.ts
```
Expected: PASS (1 test). If the presigned fetch fails with a region/signature error, confirm `s3_region = "us-east-1"` in `infra/garage.toml` matches the store's `region`.

- [ ] **Step 6: Verify restart idempotency (second boot must not fail on existing key/bucket)**

```bash
docker compose restart garage && docker compose up -d --wait garage
TEST_S3_ENDPOINT=http://localhost:3900 bun test tests/integration/garage-store.test.ts
```
Expected: garage healthy again, test PASSES again. Also `docker compose logs garage` contains no error-level lines about the default key/bucket.

- [ ] **Step 7: Update `.env.example`**

Replace the S3 section (lines 19–25) with:

```bash
# ── Object storage (S3-compatible; Garage in dev) ───────────────────────────
# Build-artifact tarballs + trigger file payloads live in the "artifacts"
# bucket (auto-created by the garage service's GARAGE_DEFAULT_* env).
S3_ENDPOINT=http://localhost:3900
S3_ACCESS_KEY_ID=GKdeadbeefdeadbeefdeadbeefdeadbeef
S3_SECRET_ACCESS_KEY=cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe
S3_BUCKET=artifacts
S3_REGION=us-east-1
```

Replace the port-overrides section (lines 152–156):

```bash
# ── docker-compose host-port overrides (optional) ───────────────────────────
POSTGRES_PORT=5432
GARAGE_PORT=3900
DEX_PORT=5556
```

- [ ] **Step 8: Sweep MinIO mentions in the store module**

In `apps/control-plane/src/artifacts.ts`: update the module doc comment ("MinIO in the compose stack" → "Garage in the compose stack"), the `endpoint` field comment ("e.g. http://localhost:3900 (Garage) — path-style addressing is used."), the bucket comment, and the inline comment on `virtualHostedStyle: false` ("Garage serves buckets at `<endpoint>/<bucket>` (path style)…").

In `apps/control-plane/src/artifacts.test.ts` (offline suite, lines 17–20 and the assertion on line 28): switch the literals to `endpoint: "http://localhost:3900"`, the GK access key, the cafebabe secret, and `expect(parsed.origin).toBe("http://localhost:3900")`.

- [ ] **Step 9: Run the offline suites and typecheck**

```bash
bun test apps/control-plane/src/artifacts.test.ts tests/integration/garage-store.test.ts
bun run typecheck
```
Expected: PASS / clean. (Without `TEST_S3_ENDPOINT` the live suite skips — confirm the output says skipped, not failed.)

- [ ] **Step 10: Commit**

```bash
git add infra/garage.toml tests/integration/garage-store.test.ts docker-compose.yml .env.example apps/control-plane/src/artifacts.ts apps/control-plane/src/artifacts.test.ts
git commit -m "integrate: replace MinIO with Garage in the dev compose stack"
```

---

### Task 2: Harness + CI sweep (dev orchestrator, e2e, acceptance suites)

**Files:**
- Modify: `scripts/dev.ts:73-75`
- Modify: `.github/workflows/ci.yml:61-66`, `:111-116`, `:206-208`, plus the gated-test `env:` block of the `integration` job
- Modify: `e2e/config.ts:33-34`, `:50`, `:100-101`
- Modify: `e2e/global-setup.ts:4`, `:52-53`, `:86-90`
- Modify: `e2e/global-teardown.ts:42-43`
- Modify: `tests/integration/phase1-acceptance.test.ts` (header comment, `ensureInfra` block ~lines 100–150, creds defaults lines 413–414)
- Modify: `tests/integration/phase3-acceptance.test.ts` (same pattern, ~lines 30–165)
- Modify: `tests/integration/keyed-acceptance.test.ts` (same pattern, ~lines 36–148)
- Modify: `packages/shared/src/trigger-event.test.ts:39`

**Interfaces:**
- Consumes: the Task 1 `garage` service (name `garage`, host port env `GARAGE_PORT`, defaults `3900`, GK/cafebabe creds, no init one-shot).
- Produces: every harness spins `postgres garage [dex]` with `docker compose up -d --wait` and **no** init `run --rm` step. Reachability probe = plain `fetch(S3_ENDPOINT)` (Garage answers any request, even errors, so `tcpReachable` resolves true).

- [ ] **Step 1: `scripts/dev.ts`**

Replace lines 73–75:

```ts
await run(["docker", "compose", "up", "-d", "--wait", "postgres", "garage", "dex"], childEnv);
note(`infra healthy (postgres, garage, dex) · bucket ok  ${((Date.now() - infraStart) / 1000).toFixed(1)}s`);
```

(The `minio-init` `run --rm` line is deleted — Garage self-initializes.) Check the rest of the file for `MINIO`/`minio` (env bootstrap may write `S3_ENDPOINT`/creds into generated `.env` files): update any generated defaults to the Task 1 values (`http://localhost:3900`, GK key, cafebabe secret).

- [ ] **Step 2: `.github/workflows/ci.yml`**

Three compose invocations change (the explanatory comment above the first two about `run --rm` racing is now obsolete — delete it):

- Lines ~61–66 and ~111–116: `docker compose up -d --wait postgres minio dex && docker compose run --rm minio-init` → `docker compose up -d --wait postgres garage dex`, step name `Compose up (postgres, garage, dex)`.
- Lines ~206–208: `docker compose up -d --wait postgres minio && docker compose run --rm minio-init` → `docker compose up -d --wait postgres garage`, step name `Compose up (postgres, garage)`.

In the `integration` job's "Gated tests" step `env:` block (just after line 74), add:

```yaml
          TEST_S3_ENDPOINT: http://localhost:3900
```

so the new live Garage test runs in CI.

- [ ] **Step 3: e2e harness**

`e2e/config.ts`:
- Lines 33–34: replace `minio: 9010, minioConsole: 9011,` with `garage: 3910,`.
- Line 50: `export const S3_ENDPOINT = \`http://127.0.0.1:${PORTS.garage}\`;`
- Lines 100–101: `S3_ACCESS_KEY_ID: "GKdeadbeefdeadbeefdeadbeefdeadbeef", S3_SECRET_ACCESS_KEY: "cafebabecafebabecafebabecafebabecafebabecafebabecafebabecafebabe",`

`e2e/global-setup.ts`:
- Line 4 comment: `docker compose (postgres · garage · dex, project p2e2e)`.
- Lines 52–53: replace `MINIO_PORT`/`MINIO_CONSOLE_PORT` entries with `GARAGE_PORT: String(PORTS.garage),`.
- Lines 86–90: log text `(postgres, garage, dex)`, `compose(["up", "-d", "--wait", "postgres", "garage", "dex"]);` and delete the `compose(["run", "--rm", "minio-init"]);` line (and its comment).

`e2e/global-teardown.ts` lines 42–43: same env replacement (`GARAGE_PORT: String(PORTS.garage),` — drop the console line).

- [ ] **Step 4: The three acceptance harnesses**

Apply the identical mechanical change in `phase1-acceptance.test.ts`, `phase3-acceptance.test.ts`, `keyed-acceptance.test.ts`:

1. Header comment: `up -d --wait postgres minio minio-init dex` → `up -d --wait postgres garage dex` (phase3/keyed have no `dex`; keep their service lists as-is minus minio → plus garage).
2. Reachability probe: `const minioUp = await tcpReachable(\`${S3_ENDPOINT}/minio/health/live\`);` → `const s3Up = await tcpReachable(S3_ENDPOINT);` — rename the `minioUp` variable to `s3Up` everywhere in the function.
3. Port derivation: `const minioPort = new URL(S3_ENDPOINT).port || "9000";` → `const s3Port = new URL(S3_ENDPOINT).port || "3900";` (rename uses).
4. Services array: `"minio"` → `"garage"`.
5. Compose env: replace the `MINIO_PORT: minioPort,` / `MINIO_CONSOLE_PORT: String(Number(minioPort) + 1),` pair with `GARAGE_PORT: s3Port,`.
6. Delete the entire `minio-init` `compose("run", "--rm", "minio-init")` block including its `if (!minioUp)` guard and error throw. Garage is `--wait`-gated by its healthcheck; nothing else is needed.
7. Any log strings mentioning minio (`pg=${pgUp} minio=${minioUp}`) → `pg=${pgUp} s3=${s3Up}`.
8. phase1 lines 413–414: default creds → the GK/cafebabe constants (exact strings from Global Constraints).

`packages/shared/src/trigger-event.test.ts:39`: `new URL("https://minio.local/bucket/big.bin")` → `new URL("https://garage.local/bucket/big.bin")` (cosmetic; keeps the repo minio-free).

- [ ] **Step 5: Verify — unit lane, then a full acceptance pass on a fresh project**

```bash
bun test
bun run typecheck
POSTGRES_PORT=5443 GARAGE_PORT=3911 docker compose -p p1acceptance down -v   # clear any stale minio-era project
TEST_DATABASE_URL=postgres://dev:dev@localhost:5443/product S3_ENDPOINT=http://localhost:3911 bun test tests/integration/phase1-acceptance.test.ts
```
Expected: unit lane green (garage-store skips without its env); phase-1 acceptance self-provisions `postgres garage dex` on the overridden ports and passes end-to-end (build → artifact upload to Garage → worker presigned pull → run). This is the real proof that presigned GETs work under Garage.

- [ ] **Step 6: Verify e2e**

```bash
cd e2e && bunx playwright test && cd ..
```
Expected: suite green (harness self-manages its own p2e2e stack with garage on :3910).

- [ ] **Step 7: Commit**

```bash
git add scripts/dev.ts .github/workflows/ci.yml e2e/config.ts e2e/global-setup.ts e2e/global-teardown.ts tests/integration/phase1-acceptance.test.ts tests/integration/phase3-acceptance.test.ts tests/integration/keyed-acceptance.test.ts packages/shared/src/trigger-event.test.ts
git commit -m "integrate: move every test harness and CI lane from MinIO to Garage"
```

---

### Task 3: SPA same-origin API base (`VITE_API_URL=""`)

**Files:**
- Modify: `apps/web/src/lib/api-client.ts:19-20` (and module doc line 5)
- Modify: `apps/web/src/lib/auth-client.ts:11`
- Test: `apps/web/src/__tests__/api-client.test.ts` (extend)

**Interfaces:**
- Produces: `resolveApiBaseUrl(raw: string | undefined, pageOrigin: string): string` exported from `apps/web/src/lib/api-client.ts`; `API_BASE_URL` semantics: unset → `http://localhost:3000` (dev unchanged), `""` → the page origin (prod same-origin builds), any other value → itself. Task 5's web image relies on the `""` behavior.

- [ ] **Step 1: Write the failing tests**

Append to `apps/web/src/__tests__/api-client.test.ts`:

```ts
import { resolveApiBaseUrl } from "../lib/api-client";

describe("resolveApiBaseUrl", () => {
  test("unset keeps the dev default", () => {
    expect(resolveApiBaseUrl(undefined, "https://app.example.com")).toBe(
      "http://localhost:3000",
    );
  });

  test("empty string resolves to the page origin (same-origin prod builds)", () => {
    expect(resolveApiBaseUrl("", "https://app.example.com")).toBe(
      "https://app.example.com",
    );
  });

  test("an explicit URL wins", () => {
    expect(resolveApiBaseUrl("https://api.example.com", "https://app.example.com")).toBe(
      "https://api.example.com",
    );
  });
});
```

(Match the file's existing import style for `describe`/`test`/`expect` — it already imports from `bun:test`.)

- [ ] **Step 2: Run to verify failure**

Run: `bun test apps/web/src/__tests__/api-client.test.ts`
Expected: FAIL — `resolveApiBaseUrl` is not exported.

- [ ] **Step 3: Implement**

In `apps/web/src/lib/api-client.ts`, replace lines 19–20:

```ts
/** Empty VITE_API_URL (prod same-origin builds) resolves to the page origin
 *  so absolute-URL derivations (SSE, copilot WebSocket, Slack install links)
 *  keep working; unset keeps the localhost dev default. */
export function resolveApiBaseUrl(
  raw: string | undefined,
  pageOrigin: string,
): string {
  const base = raw ?? "http://localhost:3000";
  return base === "" ? pageOrigin : base;
}

export const API_BASE_URL: string = resolveApiBaseUrl(
  import.meta.env.VITE_API_URL,
  typeof window === "undefined" ? "http://localhost:3000" : window.location.origin,
);
```

In `apps/web/src/lib/auth-client.ts`, replace line 11's duplicated env read with the shared constant:

```ts
import { API_BASE_URL } from "./api-client";

const baseURL = API_BASE_URL;
```

(Keep the rest of the file — `createAuthClient({ baseURL, … })` — unchanged; delete the now-stale "same source as…" comment.)

- [ ] **Step 4: Run tests + typecheck**

```bash
bun test apps/web
bun run typecheck
```
Expected: PASS (the whole web suite, not just the new file — auth-client is imported widely).

- [ ] **Step 5: Update `.env.example` wording**

In the Web app section (lines 39–45), extend the `VITE_API_URL` comment: "Set to the control-plane origin, or to an EMPTY string for same-origin production builds (the prod web image bakes `VITE_API_URL=`). Defaults to http://localhost:3000 when unset."

- [ ] **Step 6: Commit**

```bash
git add apps/web/src/lib/api-client.ts apps/web/src/lib/auth-client.ts apps/web/src/__tests__/api-client.test.ts .env.example
git commit -m "feat(web): resolve empty VITE_API_URL to the page origin for same-origin deploys"
```

---

### Task 4: `.dockerignore` + control-plane & worker images

**Files:**
- Create: `.dockerignore`
- Create: `infra/docker/control-plane.Dockerfile`
- Create: `infra/docker/worker.Dockerfile`

**Interfaces:**
- Consumes: workspace layout (`apps/*`, `packages/*`, `tests/*`, `e2e` — all workspace `package.json`s must be present for `bun install --frozen-lockfile`).
- Produces: images that run `bun apps/control-plane/src/index.ts` (port 3000) and `bun apps/worker/src/index.ts` (port 4000), with `node` 24.18.0 + `npm` on PATH in both, `docker` CLI in the worker, and env defaults `AGENT_BUILD_ROOT=/var/lib/agents` / `NPM_CACHE_DIR=/var/lib/npm-cache` (control-plane), `ARTIFACT_CACHE_DIR=/var/lib/agents` (worker). The migrate one-shot reuses the control-plane image with command `["bun", "apps/control-plane/src/migrate.ts"]`.

- [ ] **Step 1: Create `.dockerignore`**

```
.git
.env
.env.*
!.env.example
!.env.prod.example
.dev
node_modules
**/node_modules
**/dist
e2e/test-results
e2e/playwright-report
spike
docs
*.md
```

(`spike/` is standalone — not a workspace — and never needed in images. Markdown is excluded except nothing needs re-including: images don't read docs.)

- [ ] **Step 2: Create `infra/docker/control-plane.Dockerfile`**

```dockerfile
# Control plane. Bun runs the app; Node 24 + npm are required AT RUNTIME for
# `eve build` (compiled agent projects install + build under Node — eve's
# engines check refuses Node < 24). Node pin: packages/compiler/versions.json.
FROM oven/bun:1.3

COPY --from=node:24.18.0-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:24.18.0-bookworm-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx

WORKDIR /app

# Workspace manifests first — the install layer only invalidates on dep changes.
COPY package.json bun.lock tsconfig.json tsconfig.base.json ./
COPY apps/control-plane/package.json apps/control-plane/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/compiler/package.json packages/compiler/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY tests/integration/package.json tests/integration/
COPY e2e/package.json e2e/
RUN bun install --frozen-lockfile

COPY packages ./packages
COPY apps/control-plane ./apps/control-plane

# /var/lib/agents must equal the worker's ARTIFACT_CACHE_DIR (compiled
# artifacts bake absolute paths — see AGENTS.md).
ENV NODE_ENV=production \
    AGENT_BUILD_ROOT=/var/lib/agents \
    NPM_CACHE_DIR=/var/lib/npm-cache

EXPOSE 3000
CMD ["bun", "apps/control-plane/src/index.ts"]
```

- [ ] **Step 3: Create `infra/docker/worker.Dockerfile`**

```dockerfile
# Worker supervisor. Bun runs the supervisor; Node 24 boots the compiled agent
# entrypoints (`node .output/server/index.mjs`); the docker CLI serves the
# sandbox reaper against the mounted /var/run/docker.sock.
FROM oven/bun:1.3

COPY --from=node:24.18.0-bookworm-slim /usr/local/bin/node /usr/local/bin/node
COPY --from=node:24.18.0-bookworm-slim /usr/local/lib/node_modules /usr/local/lib/node_modules
RUN ln -s /usr/local/lib/node_modules/npm/bin/npm-cli.js /usr/local/bin/npm \
 && ln -s /usr/local/lib/node_modules/npm/bin/npx-cli.js /usr/local/bin/npx
COPY --from=docker:28-cli /usr/local/bin/docker /usr/local/bin/docker

WORKDIR /app

COPY package.json bun.lock tsconfig.json tsconfig.base.json ./
COPY apps/control-plane/package.json apps/control-plane/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/compiler/package.json packages/compiler/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY tests/integration/package.json tests/integration/
COPY e2e/package.json e2e/
RUN bun install --frozen-lockfile

COPY packages ./packages
COPY apps/worker ./apps/worker

ENV NODE_ENV=production \
    ARTIFACT_CACHE_DIR=/var/lib/agents

EXPOSE 4000
CMD ["bun", "apps/worker/src/index.ts"]
```

- [ ] **Step 4: Build and verify both images**

```bash
docker build -f infra/docker/control-plane.Dockerfile -t is-cp:smoke .
docker build -f infra/docker/worker.Dockerfile -t is-worker:smoke .
docker run --rm is-cp:smoke node --version        # expect: v24.18.0
docker run --rm is-cp:smoke npm --version         # expect: a 10.x/11.x version, no error
docker run --rm is-worker:smoke docker --version  # expect: Docker version 28.x
docker run --rm is-worker:smoke bun apps/worker/src/index.ts 2>&1 | head -5 || true
```
The last command must fail with the worker's own **config validation error** (missing `CONTROL_PLANE_URL`/secrets), not a module-resolution error — that proves the workspace install is complete. Similarly: `docker run --rm is-cp:smoke bun apps/control-plane/src/migrate.ts` → exits 1 with `DATABASE_URL is required`.

- [ ] **Step 5: Commit**

```bash
git add .dockerignore infra/docker/control-plane.Dockerfile infra/docker/worker.Dockerfile
git commit -m "feat(infra): control-plane and worker container images"
```

---

### Task 5: Web image — nginx SPA server + API gateway

**Files:**
- Create: `infra/nginx/web.conf`
- Create: `infra/docker/web.Dockerfile`

**Interfaces:**
- Consumes: Task 3's `""` → same-origin behavior (`ENV VITE_API_URL=""` at build); control-plane service DNS name `control-plane:3000` (Task 6 uses these names).
- Produces: an image serving the SPA on :80, proxying `/api /t /me /workspaces /integrations /mcp-registry /admin` to `control-plane:3000` with WS upgrade + unbuffered SSE, and a `GET /nginx-health` liveness route (Task 6's healthcheck).

- [ ] **Step 1: Create `infra/nginx/web.conf`**

```nginx
# invisible-string web gateway — serves the SPA and fronts the control plane
# so both share one origin (no CORS, first-party cookies).
#
# ⚠️ Route split: any NEW top-level control-plane route prefix must be added
# to the proxy `location` regex below (see AGENTS.md).

map $http_upgrade $connection_upgrade {
  default upgrade;
  ""      close;
}

# Preserve the edge proxy's X-Forwarded-Proto (Dokploy Traefik sets it);
# fall back to this hop's scheme when there is no edge proxy (local smoke).
map $http_x_forwarded_proto $fwd_proto {
  default $http_x_forwarded_proto;
  ""      $scheme;
}

server {
  listen 80;
  server_name _;

  # Matches the control plane's Bun.serve maxRequestBodySize (8 MiB).
  client_max_body_size 8m;

  root /usr/share/nginx/html;
  index index.html;

  # Docker's embedded DNS — re-resolves control-plane across restarts.
  resolver 127.0.0.11 valid=10s;
  set $control_plane http://control-plane:3000;

  location = /nginx-health {
    return 200 "ok";
  }

  # Control-plane surface: /api (incl. Better Auth + health), trigger ingress
  # /t, per-user + workspace APIs (incl. the copilot WebSocket), Slack
  # integration callbacks, MCP registry proxy, admin.
  location ~ ^/(api|t|me|workspaces|integrations|mcp-registry|admin)(/|$) {
    proxy_pass $control_plane;
    proxy_http_version 1.1;
    proxy_set_header Host $host;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $fwd_proto;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection $connection_upgrade;
    # Run tails are long-lived SSE; the copilot socket is long-lived WS.
    proxy_buffering off;
    proxy_read_timeout 1h;
    proxy_send_timeout 1h;
  }

  # Hashed build assets are immutable.
  location /assets/ {
    add_header Cache-Control "public, max-age=31536000, immutable";
    try_files $uri =404;
  }

  # SPA fallback.
  location / {
    try_files $uri /index.html;
  }
}
```

(Note: `proxy_pass` with a variable and no URI part forwards the original request URI unchanged — exactly what we want with a regex location.)

- [ ] **Step 2: Create `infra/docker/web.Dockerfile`**

```dockerfile
# Web SPA + API gateway. Stage 1 builds the Vite bundle with an EMPTY
# VITE_API_URL — the SPA resolves it to the page origin at runtime
# (apps/web/src/lib/api-client.ts), so the image bakes in no domain.
FROM oven/bun:1.3 AS build

WORKDIR /app
COPY package.json bun.lock tsconfig.json tsconfig.base.json ./
COPY apps/control-plane/package.json apps/control-plane/
COPY apps/worker/package.json apps/worker/
COPY apps/web/package.json apps/web/
COPY packages/compiler/package.json packages/compiler/
COPY packages/db/package.json packages/db/
COPY packages/shared/package.json packages/shared/
COPY tests/integration/package.json tests/integration/
COPY e2e/package.json e2e/
RUN bun install --frozen-lockfile

COPY packages ./packages
COPY apps/web ./apps/web
ENV VITE_API_URL=""
RUN bun run --cwd apps/web build

FROM nginx:1.29-alpine
COPY infra/nginx/web.conf /etc/nginx/conf.d/default.conf
COPY --from=build /app/apps/web/dist /usr/share/nginx/html
```

- [ ] **Step 3: Build and verify the routing split standalone**

```bash
docker build -f infra/docker/web.Dockerfile -t is-web:smoke .
docker run --rm -d --name is-web-smoke -p 127.0.0.1:8081:80 is-web:smoke
curl -fsS http://127.0.0.1:8081/nginx-health          # expect: ok
curl -fsS http://127.0.0.1:8081/ | grep -c '<div id="root">'   # expect: 1 (SPA shell)
curl -fsS http://127.0.0.1:8081/login | grep -c '<div id="root">' # expect: 1 (SPA fallback)
curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8081/api/health   # expect: 502 (proxied — no upstream exists standalone)
docker rm -f is-web-smoke
```
A `502` (not `200` with HTML) on `/api/health` proves the path is proxied rather than swallowed by the SPA fallback. The full 200 path is proven in Task 6.

- [ ] **Step 4: Commit**

```bash
git add infra/nginx/web.conf infra/docker/web.Dockerfile
git commit -m "feat(infra): web image — nginx SPA server + same-origin API gateway"
```

---

### Task 6: Production compose (+ external-data & build overrides) with full local smoke

**Files:**
- Create: `docker-compose.prod.yml`
- Create: `docker-compose.prod.external-data.yml`
- Create: `docker-compose.prod.build.yml`
- Create: `.env.prod.example`

**Interfaces:**
- Consumes: the three images (Tasks 4–5), `infra/garage.toml`, `infra/postgres-init.sh` (existing, reused verbatim), service DNS names `control-plane:3000` / `worker:4000` / `garage:3900` / `postgres:5432`.
- Produces: the deployable stack. Operator variables (all in `.env.prod.example`): `APP_DOMAIN, IMAGE_TAG, POSTGRES_PASSWORD, GARAGE_RPC_SECRET, S3_ACCESS_KEY_ID, S3_SECRET_ACCESS_KEY, ENCRYPTION_MASTER_KEY, PLATFORM_JWT_SECRET, BETTER_AUTH_SECRET, WORKER_SHARED_SECRET, WORKER_ID, OPENROUTER_API_KEY / ANTHROPIC_API_KEY (≥1), CLOUDFLARED_TUNNEL_TOKEN (profile only)`; external-data mode additionally `DATABASE_URL, WORLD_DATABASE_URL, S3_ENDPOINT`.

- [ ] **Step 1: Create `docker-compose.prod.yml`**

```yaml
# ─────────────────────────────────────────────────────────────────────────────
# PRODUCTION single-host topology.
# Design: docs/superpowers/specs/2026-07-07-prod-compose-design.md
# Operate it via docs/DEPLOY.md.
#
# Every secret comes from the deploy environment (${VAR:?} fails fast — see
# .env.prod.example for the full list + generation commands). No host ports
# are published: ingress is the hoster's proxy (e.g. Dokploy's Traefik) on
# the external `dokploy-network`, attached to `web` only.
#
# Worker ↔ control-plane traffic rides the private `internal` bridge, which
# is why ALLOW_INSECURE_WORKER_TRANSPORT=1 is safe HERE and nowhere routable
# (compensated by worker-token auth + a pinned worker-id allowlist).
# ─────────────────────────────────────────────────────────────────────────────
name: invisible-string-prod

services:
  web:
    image: ghcr.io/heysanil/invisible-string-web:${IMAGE_TAG:?}
    restart: unless-stopped
    depends_on:
      control-plane:
        condition: service_healthy
    networks: [internal, dokploy-network]
    healthcheck:
      test: ["CMD", "wget", "-q", "-O", "/dev/null", "http://localhost/nginx-health"]
      interval: 10s
      timeout: 3s
      retries: 6

  control-plane:
    image: ghcr.io/heysanil/invisible-string-control-plane:${IMAGE_TAG:?}
    restart: unless-stopped
    depends_on:
      migrate:
        condition: service_completed_successfully
      garage:
        condition: service_healthy
    environment:
      PORT: "3000"
      DATABASE_URL: postgres://app:${POSTGRES_PASSWORD:?}@postgres:5432/product
      WORLD_DATABASE_URL: postgres://app:${POSTGRES_PASSWORD:?}@postgres:5432/world
      S3_ENDPOINT: http://garage:3900
      S3_ACCESS_KEY_ID: ${S3_ACCESS_KEY_ID:?}
      S3_SECRET_ACCESS_KEY: ${S3_SECRET_ACCESS_KEY:?}
      S3_BUCKET: artifacts
      S3_REGION: us-east-1
      BETTER_AUTH_URL: https://${APP_DOMAIN:?}
      PUBLIC_APP_URL: https://${APP_DOMAIN:?}
      CORS_ORIGIN: https://${APP_DOMAIN:?}
      TRUSTED_ORIGINS: https://${APP_DOMAIN:?}
      SECURITY_HSTS: "1"
      ENCRYPTION_MASTER_KEY: ${ENCRYPTION_MASTER_KEY:?}
      PLATFORM_JWT_SECRET: ${PLATFORM_JWT_SECRET:?}
      BETTER_AUTH_SECRET: ${BETTER_AUTH_SECRET:?}
      WORKER_SHARED_SECRET: ${WORKER_SHARED_SECRET:?}
      WORKER_AUTH_MODE: worker-token
      WORKER_ALLOWED_IDS: ${WORKER_ID:?}
      ALLOW_INSECURE_WORKER_TRANSPORT: "1"
      AGENT_BUILD_ROOT: /var/lib/agents
      NPM_CACHE_DIR: /var/lib/npm-cache
      OPENROUTER_API_KEY: ${OPENROUTER_API_KEY:-}
      ANTHROPIC_API_KEY: ${ANTHROPIC_API_KEY:-}
    volumes:
      - agent-build:/var/lib/agents
      - npm-cache:/var/lib/npm-cache
    networks: [internal]
    healthcheck:
      test: ["CMD", "bun", "-e", "const r = await fetch('http://localhost:3000/api/health'); if (!r.ok) process.exit(1)"]
      interval: 10s
      timeout: 5s
      retries: 12

  migrate:
    image: ghcr.io/heysanil/invisible-string-control-plane:${IMAGE_TAG:?}
    command: ["bun", "apps/control-plane/src/migrate.ts"]
    restart: "no"
    depends_on:
      postgres:
        condition: service_healthy
    environment:
      DATABASE_URL: postgres://app:${POSTGRES_PASSWORD:?}@postgres:5432/product
    networks: [internal]

  worker:
    image: ghcr.io/heysanil/invisible-string-worker:${IMAGE_TAG:?}
    restart: unless-stopped
    depends_on:
      control-plane:
        condition: service_healthy
    environment:
      PORT: "4000"
      WORKER_ID: ${WORKER_ID:?}
      CONTROL_PLANE_URL: http://control-plane:3000
      PUBLIC_URL: http://worker:4000
      WORKER_SHARED_SECRET: ${WORKER_SHARED_SECRET:?}
      WORKER_AUTH_MODE: worker-token
      ARTIFACT_CACHE_DIR: /var/lib/agents
      SANDBOX_REAPER_ENABLED: "1"
    volumes:
      - agent-cache:/var/lib/agents
      - /var/run/docker.sock:/var/run/docker.sock
    networks: [internal]
    healthcheck:
      test: ["CMD", "bun", "-e", "const r = await fetch('http://localhost:4000/healthz'); if (!r.ok) process.exit(1)"]
      interval: 10s
      timeout: 5s
      retries: 12

  postgres:
    image: postgres:16
    restart: unless-stopped
    environment:
      POSTGRES_USER: app
      POSTGRES_PASSWORD: ${POSTGRES_PASSWORD:?}
    volumes:
      - postgres-data:/var/lib/postgresql/data
      # Creates the "product" and "world" databases on first boot (same
      # credential-free script the dev stack uses).
      - ./infra/postgres-init.sh:/docker-entrypoint-initdb.d/postgres-init.sh:ro
    networks: [internal]
    healthcheck:
      test: ["CMD-SHELL", "pg_isready -U app -d app"]
      interval: 5s
      timeout: 3s
      retries: 12

  garage:
    image: dxflrs/garage:v2.3.0
    restart: unless-stopped
    command: ["/garage", "server", "--single-node"]
    environment:
      GARAGE_RPC_SECRET: ${GARAGE_RPC_SECRET:?}
      GARAGE_DEFAULT_ACCESS_KEY: ${S3_ACCESS_KEY_ID:?}
      GARAGE_DEFAULT_SECRET_KEY: ${S3_SECRET_ACCESS_KEY:?}
      GARAGE_DEFAULT_BUCKET: artifacts
    volumes:
      - ./infra/garage.toml:/etc/garage.toml:ro
      - garage-data:/var/lib/garage
    networks: [internal]
    healthcheck:
      test: ["CMD", "/garage", "json-api", "GetClusterHealth"]
      interval: 5s
      timeout: 3s
      retries: 12

  # Optional Cloudflare Tunnel ingress: docker compose --profile cloudflared up.
  # Map the tunnel's public hostname to http://web:80 in the Cloudflare
  # dashboard. TUNNEL_TOKEN is required only when the profile is enabled
  # (cloudflared exits without it) — `:-` keeps profile-off deploys from
  # demanding the variable.
  cloudflared:
    image: cloudflare/cloudflared:2026.6.0
    profiles: ["cloudflared"]
    restart: unless-stopped
    command: ["tunnel", "--no-autoupdate", "run"]
    environment:
      TUNNEL_TOKEN: ${CLOUDFLARED_TUNNEL_TOKEN:-}
    depends_on: [web]
    networks: [internal]

networks:
  internal: {}
  dokploy-network:
    external: true

volumes:
  postgres-data:
  garage-data:
  agent-build:
  agent-cache:
  npm-cache:
```

Match the dev compose garage fallbacks from Task 1 (entrypoint/healthcheck) if they were needed there.

- [ ] **Step 2: Create `docker-compose.prod.external-data.yml`**

```yaml
# Disables the bundled postgres + garage — point the platform at managed
# services instead. Requirements + walkthrough: docs/DEPLOY.md § External data.
#
#   docker compose -f docker-compose.prod.yml -f docker-compose.prod.external-data.yml up -d
#
# Needs Docker Compose ≥ 2.24 (`!reset`/`!override`). Note: the base file's
# ${POSTGRES_PASSWORD:?} / ${GARAGE_RPC_SECRET:?} still interpolate — set both
# to the literal string `unused` in this mode.
services:
  postgres:
    profiles: ["disabled-bundled-data"]
  garage:
    profiles: ["disabled-bundled-data"]

  migrate:
    depends_on: !reset {}
    environment:
      DATABASE_URL: ${DATABASE_URL:?external-data mode requires DATABASE_URL}

  control-plane:
    depends_on: !override
      migrate:
        condition: service_completed_successfully
    environment:
      DATABASE_URL: ${DATABASE_URL:?}
      WORLD_DATABASE_URL: ${WORLD_DATABASE_URL:?external-data mode requires WORLD_DATABASE_URL}
      S3_ENDPOINT: ${S3_ENDPOINT:?external-data mode requires S3_ENDPOINT}
      S3_BUCKET: ${S3_BUCKET:-artifacts}
      S3_REGION: ${S3_REGION:-us-east-1}
```

- [ ] **Step 3: Create `docker-compose.prod.build.yml`**

```yaml
# Build the prod images from the working tree instead of pulling GHCR tags,
# publish web on 127.0.0.1:8080, and swap the public URLs to plain-HTTP
# localhost. LOCAL SMOKE + CI VALIDATION ONLY — never deploy with this file.
services:
  web:
    build:
      context: .
      dockerfile: infra/docker/web.Dockerfile
    ports:
      - "127.0.0.1:8080:80"
  control-plane:
    build:
      context: .
      dockerfile: infra/docker/control-plane.Dockerfile
    environment:
      BETTER_AUTH_URL: http://localhost:8080
      PUBLIC_APP_URL: http://localhost:8080
      CORS_ORIGIN: http://localhost:8080
      TRUSTED_ORIGINS: http://localhost:8080
      SECURITY_HSTS: "0"
  migrate:
    build:
      context: .
      dockerfile: infra/docker/control-plane.Dockerfile
  worker:
    build:
      context: .
      dockerfile: infra/docker/worker.Dockerfile

networks:
  # The real deploy attaches to the hoster's proxy network; for local smoke
  # let compose create it as a plain project network instead.
  dokploy-network:
    external: false
```

- [ ] **Step 4: Create `.env.prod.example`**

```bash
# invisible-string — PRODUCTION deploy variables (docker-compose.prod.yml
# interpolation). Copy into the deploy environment (Dokploy env UI or an
# --env-file). NEVER commit a filled copy; values here are placeholders.
# Full walkthrough: docs/DEPLOY.md.

# Public domain the app is served on (Dokploy domain → web:80).
APP_DOMAIN=app.example.com
# GHCR image tag to run (a release.yml-published vX.Y.Z tag).
IMAGE_TAG=v0.1.0

# Bundled data services. In external-data mode set BOTH to `unused` and
# provide DATABASE_URL / WORLD_DATABASE_URL / S3_ENDPOINT instead.
POSTGRES_PASSWORD=        # openssl rand -hex 24
GARAGE_RPC_SECRET=        # openssl rand -hex 32

# S3 credentials (garage auto-creates this key on first boot).
S3_ACCESS_KEY_ID=         # echo "GK$(openssl rand -hex 16)"
S3_SECRET_ACCESS_KEY=     # openssl rand -hex 32

# Platform secrets — each: openssl rand -base64 32
ENCRYPTION_MASTER_KEY=
PLATFORM_JWT_SECRET=
BETTER_AUTH_SECRET=
WORKER_SHARED_SECRET=

# Pinned worker identity (uuidgen). Registration is allowlisted to this id.
WORKER_ID=

# Model provider (at least one; copilot + compiled agents need it).
OPENROUTER_API_KEY=
# ANTHROPIC_API_KEY=

# Only with: docker compose --profile cloudflared up
# CLOUDFLARED_TUNNEL_TOKEN=
```

- [ ] **Step 5: Config-lint all three combinations**

```bash
cat > /tmp/prod-lint.env <<'EOF'
APP_DOMAIN=lint.example.com
IMAGE_TAG=lint
POSTGRES_PASSWORD=lint
GARAGE_RPC_SECRET=lint
S3_ACCESS_KEY_ID=GKdeadbeefdeadbeefdeadbeefdeadbeef
S3_SECRET_ACCESS_KEY=lint
ENCRYPTION_MASTER_KEY=lint
PLATFORM_JWT_SECRET=lint
BETTER_AUTH_SECRET=lint
WORKER_SHARED_SECRET=lint
WORKER_ID=00000000-0000-0000-0000-000000000000
DATABASE_URL=postgres://lint:lint@db.example.com:5432/product
WORLD_DATABASE_URL=postgres://lint:lint@db.example.com:5432/world
S3_ENDPOINT=https://s3.example.com
EOF
docker compose --env-file /tmp/prod-lint.env -f docker-compose.prod.yml config -q
docker compose --env-file /tmp/prod-lint.env -f docker-compose.prod.yml -f docker-compose.prod.external-data.yml config --services
docker compose --env-file /tmp/prod-lint.env -f docker-compose.prod.yml -f docker-compose.prod.build.yml config -q
```
Expected: first and third exit 0 silently; the second lists `web control-plane migrate worker` (+ cloudflared is profile-gated so absent) and **not** `postgres`/`garage`. Also verify fail-fast: `docker compose -f docker-compose.prod.yml config -q` with no env file must error mentioning a required variable.

- [ ] **Step 6: Full-stack local smoke**

```bash
cat > /tmp/prod-smoke.env <<EOF
APP_DOMAIN=localhost:8080
IMAGE_TAG=smoke
POSTGRES_PASSWORD=$(openssl rand -hex 16)
GARAGE_RPC_SECRET=$(openssl rand -hex 32)
S3_ACCESS_KEY_ID=GK$(openssl rand -hex 16)
S3_SECRET_ACCESS_KEY=$(openssl rand -hex 32)
ENCRYPTION_MASTER_KEY=$(openssl rand -base64 32)
PLATFORM_JWT_SECRET=$(openssl rand -base64 32)
BETTER_AUTH_SECRET=$(openssl rand -base64 32)
WORKER_SHARED_SECRET=$(openssl rand -base64 32)
WORKER_ID=$(uuidgen | tr 'A-Z' 'a-z')
EOF
docker compose --env-file /tmp/prod-smoke.env -f docker-compose.prod.yml -f docker-compose.prod.build.yml up -d --build
```
Do NOT add `--wait`: `migrate` is a one-shot and this repo has already hit the Compose `--wait`-races-one-shots bug (see commit 4a2a2f0's CI comment). Poll instead:

```bash
for i in $(seq 1 60); do
  curl -fsS http://localhost:8080/api/health && break || sleep 2
done                                                           # {"ok":true}
curl -fsS http://localhost:8080/ | grep -c '<div id="root">'   # 1
for i in $(seq 1 30); do
  curl -fsS "http://localhost:8080/api/health?deep=1" && break || sleep 2
done                                                           # eventually 200 JSON
curl -si http://localhost:8080/api/auth/sign-up/email \
  -H 'content-type: application/json' \
  -d '{"email":"smoke@example.com","password":"smoke-password-123","name":"Smoke"}' | head -20
```
The deep-health 200 is the load-bearing assertion: it proves DB + Garage reachability **and at least one live registered worker** — i.e., the worker registered over the compensated-HTTP transport with worker-token auth and the pinned id allowlist. The sign-up response must be HTTP 200 with a `set-cookie` header (same-origin cookie through the gateway).

Teardown:

```bash
docker compose --env-file /tmp/prod-smoke.env -f docker-compose.prod.yml -f docker-compose.prod.build.yml down -v
```

- [ ] **Step 7: Commit**

```bash
git add docker-compose.prod.yml docker-compose.prod.external-data.yml docker-compose.prod.build.yml .env.prod.example
git commit -m "feat(infra): production compose topology with external-data and local-build overrides"
```

---

### Task 7: CI — release workflow + prod-compose validation job

**Files:**
- Create: `.github/workflows/release.yml`
- Modify: `.github/workflows/ci.yml` (append one job)

**Interfaces:**
- Consumes: the Dockerfiles (Tasks 4–5), compose files + lint env (Task 6 Step 5).
- Produces: GHCR images `ghcr.io/heysanil/invisible-string-{control-plane,worker,web}` tagged `<git tag>` and `<sha>` on `v*` tag pushes; a `prod-compose` PR job that lints all compose combinations and builds all three images without pushing.

- [ ] **Step 1: Create `.github/workflows/release.yml`**

```yaml
name: release

on:
  push:
    tags: ["v*"]

permissions:
  contents: read
  packages: write

jobs:
  images:
    runs-on: ubuntu-latest
    strategy:
      matrix:
        include:
          - name: control-plane
            dockerfile: infra/docker/control-plane.Dockerfile
          - name: worker
            dockerfile: infra/docker/worker.Dockerfile
          - name: web
            dockerfile: infra/docker/web.Dockerfile
    steps:
      - uses: actions/checkout@v4
      - uses: docker/setup-buildx-action@v3
      - uses: docker/login-action@v3
        with:
          registry: ghcr.io
          username: ${{ github.actor }}
          password: ${{ secrets.GITHUB_TOKEN }}
      - uses: docker/build-push-action@v6
        with:
          context: .
          file: ${{ matrix.dockerfile }}
          push: true
          tags: |
            ghcr.io/heysanil/invisible-string-${{ matrix.name }}:${{ github.ref_name }}
            ghcr.io/heysanil/invisible-string-${{ matrix.name }}:${{ github.sha }}
          cache-from: type=gha,scope=${{ matrix.name }}
          cache-to: type=gha,mode=max,scope=${{ matrix.name }}
```

- [ ] **Step 2: Append the validation job to `.github/workflows/ci.yml`**

Add after the existing `e2e` job, at the same indentation as the other jobs:

```yaml
  prod-compose:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - name: Compose config lint (bundled · external-data · build)
        run: |
          cat > /tmp/prod-lint.env <<'EOF'
          APP_DOMAIN=lint.example.com
          IMAGE_TAG=lint
          POSTGRES_PASSWORD=lint
          GARAGE_RPC_SECRET=lint
          S3_ACCESS_KEY_ID=GKdeadbeefdeadbeefdeadbeefdeadbeef
          S3_SECRET_ACCESS_KEY=lint
          ENCRYPTION_MASTER_KEY=lint
          PLATFORM_JWT_SECRET=lint
          BETTER_AUTH_SECRET=lint
          WORKER_SHARED_SECRET=lint
          WORKER_ID=00000000-0000-0000-0000-000000000000
          DATABASE_URL=postgres://lint:lint@db.example.com:5432/product
          WORLD_DATABASE_URL=postgres://lint:lint@db.example.com:5432/world
          S3_ENDPOINT=https://s3.example.com
          EOF
          docker compose --env-file /tmp/prod-lint.env -f docker-compose.prod.yml config -q
          docker compose --env-file /tmp/prod-lint.env -f docker-compose.prod.yml -f docker-compose.prod.external-data.yml config -q
          docker compose --env-file /tmp/prod-lint.env -f docker-compose.prod.yml -f docker-compose.prod.build.yml config -q
      - name: Build prod images (validation only, never pushed)
        run: |
          docker build -f infra/docker/control-plane.Dockerfile -t validate-cp .
          docker build -f infra/docker/worker.Dockerfile -t validate-worker .
          docker build -f infra/docker/web.Dockerfile -t validate-web .
```

- [ ] **Step 3: Validate both workflow files parse**

```bash
bun -e 'for (const f of [".github/workflows/ci.yml", ".github/workflows/release.yml"]) { Bun.YAML.parse(await Bun.file(f).text()); console.log(f, "ok"); }'
```
Expected: both lines print `ok`.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/release.yml .github/workflows/ci.yml
git commit -m "feat(ci): publish GHCR images on release tags; validate prod compose on PRs"
```

---

### Task 8: Documentation sweep + spec addendum

**Files:**
- Create: `docs/DEPLOY.md`
- Modify: `AGENTS.md` (doc table, toolchain section, residuals list)
- Modify: `README.md` (infra mentions, deploy pointer)
- Modify: `e2e/README.md` (minio mentions)
- Modify: `docs/PLAN.md:18` (environments row)
- Modify: `.env.example` (worker-transport wording, lines ~70–75)
- Modify: `docs/superpowers/specs/2026-07-07-prod-compose-design.md` (addendum)

**Interfaces:** none produced — this task encodes everything the previous tasks built. Docs must describe the stack exactly as committed (service names, env vars, commands from Tasks 1–7).

- [ ] **Step 1: Write `docs/DEPLOY.md`**

Sections (write each against the actual committed files, not from memory):
1. **Overview** — topology diagram-in-words: hoster proxy → `web` (SPA + gateway) → `control-plane`; `worker`/`postgres`/`garage` on the private bridge; images from GHCR pinned by `IMAGE_TAG`.
2. **Prerequisites** — a Linux host with Docker + Compose ≥ 2.24, a domain, `/var/run/docker.sock` available to the worker (eve sandboxes run as sibling containers).
3. **Deploying on Dokploy** — create a Compose service from this repo (`docker-compose.prod.yml`); paste variables from `.env.prod.example` (with the generation commands); attach the domain to service `web`, container port 80 (Dokploy's Traefik joins `dokploy-network`, which the compose declares external); deploy; check `https://<domain>/api/health?deep=1`.
4. **Generic host (no Dokploy)** — `docker network create dokploy-network`, then `docker compose --env-file … -f docker-compose.prod.yml up -d --wait`; point any reverse proxy at the `web` container.
5. **Worker transport** — why `ALLOW_INSECURE_WORKER_TRANSPORT=1` is safe on the private bridge and never anywhere routable; the compensating controls (worker-token mode, pinned `WORKER_ID`, `WORKER_ALLOWED_IDS`).
6. **Optional Cloudflare Tunnel** — `--profile cloudflared`, set `CLOUDFLARED_TUNNEL_TOKEN`, map the hostname to `http://web:80` in the Cloudflare dashboard.
7. **External / managed data services** — the external-data override command; managed Postgres role **must have CREATEDB** (per-version `ws_v_*` world databases); S3 must support SigV4 presigned GETs reachable from the worker; set `POSTGRES_PASSWORD=unused GARAGE_RPC_SECRET=unused` (base-file interpolation).
8. **Backups** — `docker compose exec postgres pg_dump -U app -Fc product > backup.dump` on a cron; snapshot `garage-data` (artifacts are re-buildable — postgres is the critical state).
9. **Upgrades & rollback** — push a `v*` tag → release.yml publishes images → change `IMAGE_TAG` → redeploy; rollback = previous tag; migrations are additive so old-tag rollbacks are safe.
10. **Smoke checklist** — the Task 6 Step 6 sequence against the deployed domain (health, deep health, sign-up, build + run a workflow from the UI, webhook trigger curl).

- [ ] **Step 2: Update `AGENTS.md`**

- Doc table: add row `| docs/DEPLOY.md | Production deployment: prod compose operation, Dokploy, external data services, backups, upgrades |`.
- Toolchain/local-stack bullet: `docker compose up -d postgres minio dex` → `docker compose up -d postgres garage dex`; port list `MINIO_PORT` → `GARAGE_PORT`.
- Architecture line "tarball → MinIO" → "tarball → object store (Garage)".
- Known residuals: remove "production deploy documented-not-provisioned"; keep the single-writer residual but note "safe in the shipped single-worker prod compose".
- Add one constraint bullet under "Constraints that will bite you": "The prod web gateway (`infra/nginx/web.conf`) enumerates the control plane's top-level route prefixes — adding a new prefix requires adding it there."

- [ ] **Step 3: Update the remaining docs**

- `README.md`: quickstart compose line and any minio mention → garage; add a Deploy section pointer to `docs/DEPLOY.md`.
- `e2e/README.md`: minio → garage (service list, ports).
- `docs/PLAN.md:18`: `docker-compose (Postgres, MinIO, Dex IdP, …)` → `docker-compose (Postgres, Garage, Dex IdP, …)`; change "production topology documented but not provisioned" to "production compose provisioned (docker-compose.prod.yml; docs/DEPLOY.md)".
- `.env.example` lines ~70–75 (`ALLOW_INSECURE_WORKER_TRANSPORT` comment): replace "Never enable in production." with "Never enable across a routable network. The prod compose enables it for its private inter-container bridge, compensated by worker-token auth + a pinned worker-id allowlist (docs/DEPLOY.md)."

- [ ] **Step 4: Append the spec addendum**

At the end of `docs/superpowers/specs/2026-07-07-prod-compose-design.md`:

```markdown
## Implementation addenda (2026-07-07)

- **No `garage-init` one-shot.** Garage v2.3 auto-initializes the single-node
  layout (`garage server --single-node`) and auto-creates the access key +
  bucket (`GARAGE_DEFAULT_ACCESS_KEY/SECRET_KEY/BUCKET`), verified by the
  gated live round-trip test (`tests/integration/garage-store.test.ts`).
- **No `infra/postgres-init.prod.sh`.** The existing `infra/postgres-init.sh`
  is credential-free and generic over `$POSTGRES_USER`; the prod compose
  mounts it unchanged.
- **External-data wart.** Compose interpolates `${POSTGRES_PASSWORD:?}` /
  `${GARAGE_RPC_SECRET:?}` even for profile-disabled services — external-data
  deploys set both to the literal `unused` (documented in DEPLOY.md).
```

- [ ] **Step 5: Verify the sweep is complete**

```bash
grep -rn -i "minio" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.dev \
  --exclude="*.lock" --exclude-dir="docs/superpowers" . ; echo "exit=$?"
```
Expected: `exit=1` (no matches). Historical records under `docs/superpowers/` and `INITIAL-SPEC.md`/`spike/REPORT.md` are exempt (dated documents, do-not-rewrite policy) — if the grep without those excludes still hits INITIAL-SPEC or spike, leave them.

- [ ] **Step 6: Commit**

```bash
git add docs/DEPLOY.md AGENTS.md README.md e2e/README.md docs/PLAN.md .env.example docs/superpowers/specs/2026-07-07-prod-compose-design.md
git commit -m "docs: production deployment guide; finish MinIO→Garage rename sweep"
```

---

### Task 9: Final verification sweep

**Files:** none (verification only; fix-forward anything red before declaring done).

- [ ] **Step 1: Full local lanes**

```bash
bun run typecheck
bun test
docker compose up -d --wait postgres garage dex
DATABASE_URL=postgres://dev:dev@localhost:5432/product bun run --cwd packages/db migrate
TEST_DATABASE_URL=postgres://dev:dev@localhost:5432/product TEST_S3_ENDPOINT=http://localhost:3900 bun test
```
Expected: all green (the gated lane now includes the live Garage round-trip).

- [ ] **Step 2: Acceptance lanes**

```bash
TEST_DATABASE_URL=postgres://dev:dev@localhost:5432/product bun test tests/integration/phase1-acceptance.test.ts
TEST_DATABASE_URL=postgres://dev:dev@localhost:5432/product PHASE3_AGENT_ROOT=/tmp/invisible-string-p3-agents bun test tests/integration/phase3-acceptance.test.ts
```
Expected: both pass (multi-worker failover + triggers, artifacts through Garage).

- [ ] **Step 3: e2e + dev orchestrator sanity**

```bash
cd e2e && bunx playwright test && cd ..
bun run dev   # let it reach "infra healthy (postgres, garage, dex)", Ctrl-C, then:
bun run dev:down
```
Expected: e2e green; orchestrator boots the garage stack without a bucket-init step.

- [ ] **Step 4: Re-run the prod smoke one last time**

Repeat Task 6 Step 6 (up → four curl assertions → down -v). Expected: identical results from a clean slate.

- [ ] **Step 5: Push and watch CI**

```bash
git push origin main
gh run watch
```
Expected: `unit`, `integration`, `acceptance`, `phase3-acceptance`, `e2e`, and the new `prod-compose` jobs all green. The `release` workflow does not fire (no tag). When ready to publish first images: `git tag v0.1.0 && git push origin v0.1.0`, then `gh run watch` for `release`.
