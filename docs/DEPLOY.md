# Deploying invisible-string

Production operation guide for the single-host Docker Compose topology
(`docker-compose.prod.yml`). Design rationale lives in
[`docs/superpowers/specs/2026-07-07-prod-compose-design.md`](superpowers/specs/2026-07-07-prod-compose-design.md);
this document is the operator runbook.

---

## 1. Overview

The whole platform runs as one Compose stack on a single Linux host. Only the
`web` service is exposed to the public internet; everything else talks over a
private Compose bridge.

```
                    ┌──────────────────────── host ───────────────────────────┐
  Internet ──TLS──▶ hoster proxy ──▶  web  (nginx: SPA + API gateway, :80)
  (Traefik / any        │                │
   reverse proxy)       │   dokploy-network (external)
                        │                │
                        └────────────────┤  internal (private bridge)
                                         ├─▶ control-plane  (Bun + Elysia, :3000)
                                         ├─▶ worker         (Bun supervisor, :4000, docker.sock)
                                         ├─▶ postgres       (:5432 — product + world DBs)
                                         └─▶ garage         (:3900 — S3 artifact store)
```

- **`web`** serves the built SPA and reverse-proxies the control-plane API on
  the same origin (no CORS, first-party cookies). It is the only service
  attached to the hoster's external proxy network (`dokploy-network`).
- **`control-plane`** is the API host: auth, agent + workflow CRUD,
  `eve build` + artifact upload, scheduler, trigger ingress + schedule
  ticker, outbound Slack reply delivery, SSE, copilot WS.
- **`worker`** boots compiled agents (Node 24) and reverse-proxies runs. It
  mounts `/var/run/docker.sock` so eve sandboxes run as sibling containers.
- **`postgres`** holds the `product` DB (control plane + Better Auth) and the
  `world` DB (eve durability, plus per-agent-version `ag_v_*` databases).
- **`garage`** is the S3-compatible object store for build-artifact tarballs
  and trigger file payloads.
- **`migrate`** is a one-shot that applies migrations before `control-plane`
  starts; **`cloudflared`** is an optional tunnel (profile-gated).

Images are pulled from GHCR, pinned by `IMAGE_TAG`:
`ghcr.io/heysanil/invisible-string-{web,control-plane,worker}`.

---

## 2. Prerequisites

- A Linux host with **Docker** and **Docker Compose ≥ 2.23.1** (the compose
  files carry their config files inline via `configs: content:`).
- A public domain pointed at the host (or at the hoster's proxy).
- `/var/run/docker.sock` available to the `worker` container — eve session
  sandboxes launch as sibling containers on the host daemon.
- The GHCR images published by the `release` workflow (push a `v*` tag), or use
  the build override (§6) to build locally.

---

## 3. Configuration

Every secret is supplied through the environment; the compose file uses
`${VAR:?}` interpolation so a missing value fails fast at `config`/`up` time.
Copy [`.env.prod.example`](../.env.prod.example) and fill it in — **never commit
a filled copy.**

| Variable | Purpose | Generate |
|---|---|---|
| `APP_DOMAIN` | Public domain the app is served on | — |
| `IMAGE_TAG` | GHCR image tag to run (a `release.yml`-published `vX.Y.Z`) | — |
| `POSTGRES_PASSWORD` | Bundled Postgres password | `openssl rand -hex 24` |
| `GARAGE_RPC_SECRET` | Garage RPC secret | `openssl rand -hex 32` |
| `S3_ACCESS_KEY_ID` | S3 access key (Garage auto-creates it on first boot) | `echo "GK$(openssl rand -hex 16)"` |
| `S3_SECRET_ACCESS_KEY` | S3 secret key | `openssl rand -hex 32` |
| `ENCRYPTION_MASTER_KEY` | AES-256-GCM envelope key for secrets at rest | `openssl rand -base64 32` |
| `PLATFORM_JWT_SECRET` | HMAC secret for platform JWTs | `openssl rand -base64 32` |
| `BETTER_AUTH_SECRET` | Better Auth session secret | `openssl rand -base64 32` |
| `WORKER_SHARED_SECRET` | Worker ↔ control-plane auth secret | `openssl rand -base64 32` |
| `WORKER_ID` | Pinned worker identity; registration is allowlisted to it. Lowercase — macOS `uuidgen` emits uppercase, and on images ≤ `v0.1.7` an uppercase id breaks every dispatch (§12); images > `v0.1.7` normalize it | `uuidgen \| tr '[:upper:]' '[:lower:]'` |
| `OPENROUTER_API_KEY` / `ANTHROPIC_API_KEY` | Model provider (at least one) | — |
| `SLACK_CLIENT_ID` / `SLACK_CLIENT_SECRET` / `SLACK_SIGNING_SECRET` | Optional platform Slack app — all three or none ([SLACK.md](SLACK.md)) | — |
| `CLOUDFLARED_TUNNEL_TOKEN` | Only with `--profile cloudflared` (§5) | — |

The `S3_ACCESS_KEY_ID` **must** be `GK` followed by 32 lowercase hex characters —
Garage validates that shape. The access key + `artifacts` bucket are created
automatically on Garage's first boot from the `GARAGE_DEFAULT_*` env, so the
`S3_ACCESS_KEY_ID` / `S3_SECRET_ACCESS_KEY` you set are the ones the store uses.

External-data mode (§7) additionally needs `DATABASE_URL`, `WORLD_DATABASE_URL`,
and `S3_ENDPOINT`.

---

## 4. Deploying

### On Dokploy

1. Create a **Compose** service pointing at this repo and set the compose file
   to `docker-compose.prod.yml` — or paste the file's contents directly; the
   prod compose is fully standalone (its config files ride inline via
   `configs: content:`, so no repo checkout is needed on the host).
2. Paste the variables from `.env.prod.example` into the Dokploy environment UI
   (use the generation commands in §3 for the secrets).
3. Attach your domain to service **`web`**, container port **80**. Dokploy's
   Traefik joins the `dokploy-network`, which this compose declares as
   `external: true` — so no host ports are published; ingress is Traefik → `web`.
4. Deploy. Once healthy, verify:
   `curl -fsS https://<APP_DOMAIN>/api/health?deep=1` returns `200` JSON.

### On a generic host (no Dokploy)

The base compose expects an external `dokploy-network`; create it once, then
bring the stack up and point any reverse proxy at the `web` container:

```bash
docker network create dokploy-network
docker compose --env-file .env.prod -f docker-compose.prod.yml up -d --wait
```

`migrate` is a one-shot (`restart: "no"`) that `control-plane` depends on via
`service_completed_successfully`; if `--wait` ever objects to its exited
container, drop `--wait` and poll `https://<domain>/api/health` instead.

The **deep health** endpoint is the load-bearing check:
`GET /api/health?deep=1` returns `200` only when Postgres and Garage are
reachable **and at least one worker has registered** — i.e. the worker
completed registration over the private-bridge transport (§5).

---

## 5. Worker transport

Worker ↔ control-plane calls carry secrets. The control plane normally rejects
non-`https://` worker addresses, but the prod stack sets
`ALLOW_INSECURE_WORKER_TRANSPORT=1` because that traffic never leaves the
private `internal` bridge — it is not routable from anywhere. It is compensated
by three controls, all set in `docker-compose.prod.yml`:

- `WORKER_AUTH_MODE=worker-token` — per-worker HS256 session token (rotated on
  heartbeat) + a per-call dispatch token, not a single shared credential.
- A pinned `WORKER_ID` (a UUID you generate).
- `WORKER_ALLOWED_IDS=${WORKER_ID}` — the registration allowlist: only that id
  may register.

**Never** set `ALLOW_INSECURE_WORKER_TRANSPORT=1` on a routable network.

---

## 6. Local smoke (build override)

`docker-compose.prod.build.yml` builds the three images from the working tree
instead of pulling GHCR tags, publishes `web` on `127.0.0.1:8080`, and swaps
the public URLs to plain-HTTP localhost. **Local smoke + CI validation only —
never deploy with this file.**

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

docker compose --env-file /tmp/prod-smoke.env \
  -f docker-compose.prod.yml -f docker-compose.prod.build.yml up -d --build

# Do NOT use --wait here (it races the migrate one-shot). Poll instead:
for i in $(seq 1 60); do curl -fsS http://localhost:8080/api/health && break || sleep 2; done
curl -fsS "http://localhost:8080/api/health?deep=1"                  # 200 JSON (DB + Garage + live worker)
curl -fsS http://localhost:8080/ | grep -c '<div id="root">'        # 1 (SPA shell)

docker compose --env-file /tmp/prod-smoke.env \
  -f docker-compose.prod.yml -f docker-compose.prod.build.yml down -v
```

The automated version of this smoke — plus a full agent publish through the
gateway, with `eve build` running inside the control-plane container — is
`tests/integration/prod-compose-smoke.test.ts` (`PROD_SMOKE=1`, compose
project `psmoke`; CI runs it in the `prod-compose` job). Run it after any
change to the Dockerfiles, the compose files, or the build steps.

---

## 7. External / managed data services

`docker-compose.prod.external-data.yml` is a **standalone** compose file — the
same app services as the base file with the bundled `postgres` and `garage`
removed. Deploy it alone (paste it into Dokploy exactly like the base file, or
run it directly); do not combine it with `docker-compose.prod.yml`:

```bash
docker compose --env-file .env.prod -f docker-compose.prod.external-data.yml up -d
```

CI keeps the two files' shared services in lockstep
(`scripts/check-prod-compose-drift.sh`) — edit one, mirror the other.

Requirements:

- Provide `DATABASE_URL`, `WORLD_DATABASE_URL`, and `S3_ENDPOINT` instead of
  `POSTGRES_PASSWORD` / `GARAGE_RPC_SECRET` (which this file never references).
- The managed Postgres role **must have `CREATEDB`** unless the `product` and
  `world` databases are pre-created — the migrate one-shot creates missing
  databases, and the world provisioner creates a per-version `ag_v_*` database
  for every agent version.
- The S3 endpoint must support **SigV4 presigned GET** URLs, and those URLs must
  be reachable from the `worker` container (it fetches artifacts by plain
  `fetch`). `S3_BUCKET` (default `artifacts`) and `S3_REGION` (default
  `us-east-1`) are overridable; the region must match the store's configured
  region since SigV4 embeds it.

---

## 8. Optional Cloudflare Tunnel

To publish without a public IP / hoster proxy, use the `cloudflared` profile:

```bash
docker compose --env-file .env.prod -f docker-compose.prod.yml \
  --profile cloudflared up -d
```

Set `CLOUDFLARED_TUNNEL_TOKEN` in the environment, and in the Cloudflare
dashboard map the tunnel's public hostname to `http://web:80`. The variable is
required only when the profile is enabled (cloudflared exits without it);
profile-off deploys do not need it.

---

## 9. Backups

Postgres is the critical state; Garage artifacts are re-buildable from the
stored agent definitions — **but back the two up as a pair**: the build cache
(`builds`) trusts its `succeeded` rows without re-checking that the
tarball still exists in the store, so restoring Postgres *without* the matching
`garage-data` volume strands those builds pointing at missing artifacts (runs
fail to dispatch until the rows are cleared; see AGENTS.md known residuals).

- **Postgres** — run a `pg_dump` on a cron:

  ```bash
  docker compose -f docker-compose.prod.yml exec postgres \
    pg_dump -U app -Fc product > product-$(date +%F).dump
  ```

  (Dump `world` too if you want to preserve in-flight run durability across a
  restore; the `product` DB is the one that must survive.)
- **Garage** — snapshot the `garage-data` volume alongside every Postgres
  backup. If you must restore Postgres without it, clear the stale cache first:
  `DELETE FROM builds;` — builds then re-run and re-populate the store.

---

## 10. Upgrades & rollback

1. Push a `v*` git tag → the `release` workflow builds and pushes the three
   GHCR images tagged with the git tag and the commit sha.
2. Change `IMAGE_TAG` to the new tag and redeploy (`up -d` re-pulls).
3. **Rollback** = set `IMAGE_TAG` back to the previous tag and redeploy.
   Migrations are additive (AGENTS.md golden rule), so rolling an image back to
   a prior tag against an already-migrated database is safe.

---

## 11. Smoke checklist

Run against the deployed domain after every deploy:

1. `curl -fsS https://<domain>/api/health` → `200`.
2. `curl -fsS "https://<domain>/api/health?deep=1"` → `200` JSON (proves DB +
   Garage reachable **and** ≥ 1 live worker).
3. Sign up a user:

   ```bash
   curl -si https://<domain>/api/auth/sign-up/email \
     -H 'content-type: application/json' \
     -d '{"email":"you@example.com","password":"a-strong-password","name":"You"}'
   ```

   Expect `200` with a `set-cookie` header (same-origin cookie through the
   gateway).
4. In the UI: create an Agent, **Publish** it (real `eve build` → artifact
   upload to Garage → worker presigned pull), and chat with it — the working
   block should stream and complete.
5. Fire a webhook trigger to confirm ingress (needs a published workflow
   delegating to the agent, with a minted webhook token):
   `curl -sS -X POST https://<domain>/t/<token> -H 'content-type: application/json' -d '{}'`.

---

## 12. Troubleshooting

- **Every chat send fails instantly with a 502 while health checks, login,
  and worker registration all look fine** — check the `runs` table: if
  `error` says `ensure-agent failed: 401 … missing or invalid
  x-worker-secret header`, your `WORKER_ID` contains uppercase letters
  (macOS `uuidgen` emits uppercase). Registration compares env-to-env and
  passes, but the control plane binds dispatch tokens to the id as stored in
  Postgres (a `uuid` column, which lowercases it) and the worker's guard
  compares case-sensitively — so every dispatch is rejected and surfaces as
  `worker_dispatch_failed` (HTTP 502; Cloudflare rebrands it as its own
  `origin_bad_gateway` page). Fix: lowercase `WORKER_ID` (and
  `WORKER_ALLOWED_IDS`) and redeploy, or upgrade to an image > `v0.1.7`,
  which normalizes the id at config parse.
- **Instant 502s on chat sends / run streams through the edge proxy**
  (Cloudflare `origin_bad_gateway`, or a bare Traefik/nginx `Bad Gateway`) on
  images predating 2026-07-10 — the control plane didn't disable Bun's ~10 s
  `idleTimeout`, so quiet SSE run tails were cut mid-response (heartbeats
  default to 15 s) and chat dispatches awaiting a cold agent boot were killed
  before response headers. Telltale: `docker compose logs web` full of
  `upstream prematurely closed connection`. Fixed in code
  (`BUN_SERVE_OPTIONS`, `apps/control-plane/src/index.ts`); on an affected
  image, set `SSE_HEARTBEAT_MS=8000` in the environment as a stopgap and
  upgrade.
- **Garage crash-loops with `Error: IO error: Is a directory (os error 21)`**,
  or `migrate` fails with `database "product" does not exist` — you deployed a
  pre-2026-07-08 compose that bind-mounted `./infra/*` host files. Without a
  repo checkout on the host, Docker creates empty *directories* at those paths:
  Garage reads a directory as its config and crashes; postgres silently skips a
  directory in `initdb.d`, so the databases are never created. Fix: pull the
  current compose (config files ride inline now) and run images ≥ `v0.1.4` —
  the `migrate` one-shot creates missing databases itself, so a volume that
  initialized database-less during the broken deploy heals on the next deploy.
  (On images ≤ `v0.1.3` the workaround was deleting the `postgres-data` volume
  so postgres re-ran its init scripts.)
