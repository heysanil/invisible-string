# Connectors Redesign — Plan 3 of 3: OAuth Broker

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Full MCP OAuth 2.1 support: browser consent brokered by the control plane, envelope-encrypted tokens with central refresh, runtime token delivery to compiled agents via eve's `auth.getToken`, and OAuth connectors in the catalog.

**Architecture:** Spec §6 end-to-end. Discovery (RFC 9728 path-aware → RFC 8414/OIDC) and every token exchange ride Plan 2's guarded egress. Client identity is CIMD-first (our hosted client-metadata URL) with RFC 7591 DCR fallback. Consent is PKCE in a popup; state + verifier persist on `connection_oauth`'s pending columns. Agents never hold OAuth material: codegen emits a `getToken` that self-mints a version-bound platform JWT (HS256, the per-version derived secret already in agent env) and calls `POST /internal/connections/token`; the control plane refreshes centrally (single-flight). Mid-run `authorization.required` handling is gated on a spike capture and lands as a tailer latch + chat card. Spec: `docs/superpowers/specs/2026-08-09-connectors-redesign-design.md` §3, §6, §8, §9, §10, §13, §14.

**Tech Stack:** as Plans 1–2. Compiler changes bump `COMPILER_VERSION` (golden-digest ritual). No new runtime deps in generated projects (the JWT signer is hand-rolled on `node:crypto`).

## Global Constraints

Plan 1's + Plan 2's Global Constraints apply verbatim (read both plan files and AGENTS.md first). Additions:

- **All broker egress goes through Plan 2's `createGuardedFetch`** — discovery, DCR, token exchange, refresh, revocation. A malicious MCP server chooses its own authorization server (spec §7).
- Refresh tokens, client secrets, and PKCE verifiers at rest: AES-256-GCM envelopes, AAD `connection_oauth:<column>:<row-id>`. Access tokens reach an agent only via the runtime route; refresh material NEVER leaves the control plane. No OAuth value is ever logged (the structured logger's redaction conventions apply to `access_token`, `refresh_token`, `client_secret`, `code`, `code_verifier`).
- The runtime route's version hash comes ONLY from the verified JWT audience — never from the request body (spec §6).
- Compiler ritual: any emitted-byte change bumps `COMPILER_VERSION` (`packages/compiler/src/version.ts`); `UPDATE_GOLDEN=1` refuses to run without it; new fixture goldens commit with the bump.
- eve constraint (AGENTS.md): env reads in generated code stay inside lazy callbacks — the keyless `eve build` must never crash.
- Post-Plan-1/2 module facts: `runtime/jwt.ts` exports `derivePlatformJwtSecret(master, hash)`, `platformJwtAudienceForHash(hash)`, `PLATFORM_JWT_ISSUER` (re-exported from the compiler so mint/verify can't drift); the tailer's input latch lives in `apps/control-plane/src/runs/tailer.ts` (`pendingInputRequest` field ~line 162, event check ~line 238, loop threading ~lines 454–616) — the authorization latch mirrors it exactly; `agent_versions` schema at `packages/db/src/schema/product.ts:389`; the only existing `/internal/*` route is worker-guarded `GET /internal/metrics` (`runtime/routes.ts:725`) — the token route is platform-JWT-authed, document the distinction where it mounts; Slack's OAuth module (`apps/control-plane/src/integrations/slack-oauth.ts`) shows where `integrations` routes mount and how the public base URL is configured — reuse that exact config value for redirect URIs and CIMD.

---

### Task 1: Spike capture — what does eve actually emit on mid-run auth failure?

**Files:**
- Create: `spike/tests/authorization-events.test.ts` (gated `SPIKE_EVE_BUILD=1`, following `spike/tests/harness.ts` + `mocked.test.ts` idioms)
- Modify: `spike/REPORT.md` (append the numbered finding — never rewrite)

**Interfaces:** Produces the empirical finding Task 9 branches on: when a connected MCP server starts rejecting requests mid-session (401), does eve emit `authorization.required` / park the turn, or surface a plain tool error? And does an `auth.getToken` callback that THROWS produce a distinct event? Record the captured NDJSON verbatim in the finding.

- [ ] **Step 1:** Build a spike agent (existing harness) with one `defineMcpClientConnection` pointing at a local stub MCP server (SDK `StreamableHTTPServerTransport`) that serves `initialize`/`tools/list` normally, then flips to 401-with-`WWW-Authenticate` for `tools/call` after the first call. Drive a session (mock model calls the tool twice); capture every emitted event.
- [ ] **Step 2:** Second scenario: the connection's `getToken` throws — capture what reaches the stream.
- [ ] **Step 3:** Append the finding to `spike/REPORT.md` (next number in sequence) with the captured event sequences and a one-line conclusion ("eve emits X on mid-run 401; authorization.required was/was not observed"). Run: `SPIKE_EVE_BUILD=1 TEST_DATABASE_URL=… bun test spike/tests/authorization-events.test.ts` → PASS.
- [ ] **Step 4:** Commit — `test(spike): capture eve behavior on mid-run MCP auth rejection`

---

### Task 2: `agent_versions.connection_slugs` column

**Files:**
- Modify: `packages/db/src/schema/product.ts` (`agentVersions` gains `connectionSlugs: jsonb("connection_slugs").$type<Record<string, string>>()` — slug → connection id, nullable for historical rows), migration via `bun run --cwd packages/db generate`
- Modify: `apps/control-plane/src/runtime/compile-service.ts` (publish writes the map — it already computes slugs via the adapter's unique-slug pass; persist `{[slug]: connectionId}` on the version row)
- Test: extend the compile-service integration coverage: after a publish, the version row's map contains each context connection's slug → `cn_` id.

**Interfaces:** Produces the slug→connection resolution Task 9's tailer uses. Historical `null` rows are handled (`?? {}`).

Steps: failing test → migration (additive-only inspection) → implement → gated run PASS → commit `feat(db,control-plane): persist connection slug map on agent versions`.

---

### Task 3: OAuth discovery module

**Files:**
- Create: `apps/control-plane/src/oauth/discovery.ts`, `apps/control-plane/src/oauth/discovery.test.ts`

**Interfaces:**
- Consumes: Plan 2 `createGuardedFetch`.
- Produces (Tasks 4–6):

```ts
export interface OauthDiscovery {
  resource: string;                 // canonical resource id from PRM (RFC 8707 value)
  authorizationServer: string;      // issuer
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  revocationEndpoint?: string;
  scopesSupported?: string[];
  clientIdMetadataDocumentSupported?: boolean;
}
export class OauthDiscoveryError extends Error { reason: string }
export function discoverOauth(mcpUrl: string, fetchImpl: typeof fetch): Promise<OauthDiscovery>;
```

Procedure (MCP auth spec 2026-07-28 + RFC 9728/8414): (1) `GET mcpUrl` unauthenticated — on 401, parse `WWW-Authenticate` for `resource_metadata="…"`; (2) else/also try PRM well-knowns **path-aware first**: for `https://host/some/path` try `https://host/.well-known/oauth-protected-resource/some/path`, then the root `/.well-known/oauth-protected-resource`; (3) from PRM take `resource` + first `authorization_servers[]` entry; (4) AS metadata: for issuer `https://as/tenant` try `https://as/.well-known/oauth-authorization-server/tenant`, then `https://as/tenant/.well-known/openid-configuration`, then root variants — first 200 wins; (5) require `code_challenge_methods_supported` to include `S256` (reject otherwise — PKCE is mandatory). Every fetch via `fetchImpl`, JSON size-capped, no caching (discovery runs are rare). No metadata anywhere → `OauthDiscoveryError("no_oauth_metadata")`.

- [ ] **Step 1: Failing tests** with `Bun.serve` fixtures: path-aware PRM resolution (server under `/mcp` serves PRM only at the path-inserted well-known); root fallback; `WWW-Authenticate` pointer wins over probing; path-inserted RFC 8414 vs OIDC fallback ordering; missing S256 → error; no metadata → `no_oauth_metadata`; PRM advertising a private-IP AS is rejected **by the guard** (construct with `createGuardedFetch({allowPrivate:false})` and a PRM pointing at `http://127.0.0.1` — expect `EgressBlockedError` surfaced as discovery failure).
- [ ] **Step 2: Run → FAIL. Implement. Run → PASS** (`bun test apps/control-plane/src/oauth && bun run typecheck`).
- [ ] **Step 3: Commit** — `feat(control-plane): path-aware oauth discovery over guarded egress`

---

### Task 4: Client identity — CIMD document + DCR fallback

**Files:**
- Create: `apps/control-plane/src/oauth/client-identity.ts` (+ test)
- Modify: the integrations route mount (same place `slack-oauth.ts` routes live): `GET /integrations/mcp-oauth/client-metadata.json`
- Modify: `apps/control-plane/src/runtime/errors.ts` (`oauthRegistrationFailed`)

**Interfaces:**
- Consumes: Task 3 `OauthDiscovery`; the public base URL config Slack OAuth already uses; Plan 2 guarded fetch; envelope crypto.
- Produces (Task 5): `resolveClientIdentity(deps, discovery, connectionOauthRow): Promise<{ clientId: string; clientSecret: string | null; persisted: boolean }>` — CIMD when the base URL is public https AND `discovery.clientIdMetadataDocumentSupported` (clientId = the metadata URL, no secret, nothing persisted); else DCR: POST `registration_endpoint` (`token_endpoint_auth_method: "none"` preferred, `redirect_uris: [<base>/integrations/mcp-oauth/callback]`, `grant_types: ["authorization_code","refresh_token"]`), persist `client_id` + encrypted secret on the row, reuse on subsequent starts. The metadata route serves the static CIMD JSON document (same `client_id`/`redirect_uris`/grant/response types, `client_name: "Invisible String"`).

- [ ] **Step 1: Failing tests** — CIMD path chosen and returns the URL id without persisting; non-public base URL (http://localhost) forces DCR; DCR posts once then reuses the stored registration; registration failure → typed error; metadata route returns the document with correct `redirect_uris`.
- [ ] **Step 2: Implement; unit + typecheck PASS.**
- [ ] **Step 3: Commit** — `feat(control-plane): CIMD-first oauth client identity with DCR fallback`

---

### Task 5: Broker — start + callback routes, PKCE, state, oauth-enabled creates

**Files:**
- Create: `apps/control-plane/src/oauth/broker.ts`, `apps/control-plane/src/oauth/broker.test.ts` (DB-gated), `apps/control-plane/src/oauth/stub-as.ts` (test fixture: in-process authorization server — `/authorize` auto-approves and 302s back with a code; `/token` validates PKCE + `resource` + single-use codes, issues access+refresh, supports a switchable `invalid_grant` mode and a refresh grant; RFC 8414 metadata endpoint; optional `/revoke`)
- Modify: `apps/control-plane/src/resources/plugin.ts` (`POST /workspaces/:workspaceId/connections/:id/oauth/start` + `/me/...` mirror, `canManage`-gated), integrations mount (`GET /integrations/mcp-oauth/callback`), `apps/control-plane/src/resources/connections.ts` (creates may now yield `authType:"oauth"`: catalog `auth:{type:"oauth"}` recipes; custom/registry create accepts `auth:{type:"oauth"}` → row + `connection_oauth` status `pending`), `packages/shared/src/api.ts` (`mcpAuthWriteSchema` union gains `{type:"oauth"}`; `connectorCatalogEntrySchema` auth union gains `{type:"oauth"}`), `apps/control-plane/src/runtime/errors.ts` (`oauthDiscoveryFailed`, `oauthStateInvalid`, `oauthExchangeFailed`)

**Interfaces:**
- Consumes: Tasks 3–4; `connection_oauth` pending columns (Plan 1 schema); envelope crypto (AAD per Global Constraints).
- Produces (Tasks 6, 10): `startOauth(deps, scope, connectionId, userId): Promise<{ authorizeUrl: string }>` — runs discovery (cached onto the row's endpoint columns), resolves client identity, generates S256 verifier + single-use `state` (both persisted: verifier encrypted, 10-min `pending_expires_at`; a new start SUPERSEDES a prior pending flow), builds the authorization URL with `resource`, `scope` (space-joined `scopesSupported` when present), `state`, `code_challenge`; `handleCallback(deps, query): Promise<CallbackOutcome>` — state lookup (single-use: clear pending atomically), expiry check, token exchange with `code_verifier` + `resource` via guarded fetch, envelope-store tokens + expiry, status `connected`, `connected_by`, fire Plan 2's probe async; the callback route wraps the outcome in a minimal HTML page that `postMessage`s `{type:"mcp-oauth", ok, connectionId}` with `targetOrigin` = the public base URL, then `window.close()`. **The callback requires an authenticated Better Auth session** (the popup shares the app's cookies): `connected_by` = the session user, and a session whose user cannot access the connection's scope is rejected before any token exchange — a forwarded callback URL is useless to an outsider.

- [ ] **Step 1: Failing DB-gated tests** against the stub AS: full start→callback happy path persists encrypted tokens + `connected` + probe fired; wrong/expired/reused `state` → `oauth_state_invalid` and NO token write; exchange rejection → status `error` with typed reason; second `start` supersedes the first (old state dies); catalog create with an oauth recipe yields `pending` + a start URL path in the response; authz matrix on the start routes.
- [ ] **Step 2: Run → FAIL. Implement. Run → PASS** (+ unit lane still green serviceless).
- [ ] **Step 3: Commit** — `feat(control-plane): oauth consent broker with PKCE and persisted single-use state`

---

### Task 6: Token lifecycle — getAccessToken, refresh, revocation, mutation transitions

**Files:**
- Create: `apps/control-plane/src/oauth/tokens.ts` (+ DB-gated test)
- Modify: `apps/control-plane/src/resources/connections.ts` (mutation transitions), `apps/control-plane/src/runtime/errors.ts` (`oauthNotConnected` 409)

**Interfaces:**
- Consumes: Task 5 rows; stub AS refresh/`invalid_grant`/`/revoke` modes.
- Produces (Task 7): `getAccessToken(deps, connectionId): Promise<{ token: string; expiresAt: Date }>` — inside a transaction, `SELECT … FOR UPDATE` the `connection_oauth` row (single-flight across requests AND replicas); if status ≠ `connected` → `oauthNotConnected`; if `access_token_expires_at` > now + 60 s → return decrypted token; else refresh (`grant_type=refresh_token`, `resource` param, guarded fetch), rotate stored tokens (some ASes rotate refresh tokens — persist the new one when returned), return fresh; `invalid_grant` → status `expired`, connection `health = auth_error`, throw `oauthNotConnected`; other refresh failures → status `error`, throw. Also: `revokeBestEffort(deps, row)` — RFC 7009 POST to `revocationEndpoint` when known, errors swallowed (logged debug). Mutation transitions (spec §6): PATCH changing `auth_type` off `oauth` → revoke + delete the oauth row; custom URL change on an oauth connection → revoke + reset row to `pending` (tokens were resource-bound); connection delete → revoke.

- [ ] **Step 1: Failing tests** — margin logic (fresh token returned untouched; stale refreshes; expiry boundary), refresh-token rotation persisted, `invalid_grant` lands `expired` + `auth_error`, two concurrent `getAccessToken` calls produce exactly ONE refresh (assert stub AS token-endpoint hit count), URL-change and auth-type-change transitions revoke + reset, delete revokes.
- [ ] **Step 2: Run → FAIL. Implement. Run → PASS.**
- [ ] **Step 3: Commit** — `feat(control-plane): central token refresh with single-flight and revocation transitions`

---

### Task 7: Runtime token route `POST /internal/connections/token`

**Files:**
- Modify: `apps/control-plane/src/runtime/routes.ts` (mount beside `/internal/metrics`, with a comment distinguishing its auth model), `docs/runtime-worker-contract.md` (route contract section)
- Create: `apps/control-plane/src/runtime/connection-token-route.test.ts` (DB-gated)

**Interfaces:**
- Consumes: Task 6 `getAccessToken`; `runtime/jwt.ts` (`derivePlatformJwtSecret`, `platformJwtAudienceForHash`, `PLATFORM_JWT_ISSUER`); jose `jwtVerify`.
- Produces (Task 8): request `{connectionId: string}` with `Authorization: Bearer <agent-minted JWT>`; response `{token, expiresAt}`; errors 401 (missing/bad JWT), 403 (connection not in this version's definition), 409 `oauth_not_connected`.

**Verification procedure — implement EXACTLY this order (spec §6):**

```ts
const unverified = decodeJwt(token);                     // jose decodeJwt — NO signature trust yet
const aud = Array.isArray(unverified.aud) ? unverified.aud[0] : unverified.aud;
const m = /^agent-version:([0-9a-f]{64})$/.exec(aud ?? "");
if (!m) return 401;                                      // rejects the bare "agent-version" channel audience too
const hash = m[1];
const secret = derivePlatformJwtSecret(deps.masterSecret, hash);
await jwtVerify(token, new TextEncoder().encode(secret), {
  issuer: PLATFORM_JWT_ISSUER,
  audience: platformJwtAudienceForHash(hash),
});                                                       // sig + exp + iss — 401 on failure
const version = await loadVersionByContentHash(deps.db, hash);   // 401 if unknown
const ids = agentDefinitionSchema.parse(version.definition).context.mcpConnectionIds;
if (!ids.includes(body.connectionId)) return 403;
return getAccessToken(deps, body.connectionId);           // hash came ONLY from the verified audience
```

- [ ] **Step 1: Failing tests** — happy path (mint with `mintPlatformJwt` + the version-bound audience for a published fixture version whose definition contains the connection); bare `agent-version` audience → 401; JWT minted for a DIFFERENT version's hash → 401 (signature fails under the derived secret); connection not in the version → 403; expired JWT → 401; body carrying a different `versionHash` field → ignored (assert the response serves the audience's version, proving body can't steer); unconnected oauth row → 409.
- [ ] **Step 2: Run → FAIL. Implement. Run → PASS.** Update `docs/runtime-worker-contract.md` in the same commit.
- [ ] **Step 3: Commit** — `feat(control-plane): agent-facing token route with audience-derived version binding`

---

### Task 8: Codegen `oauth` mode + `PLATFORM_API_URL` + COMPILER_VERSION bump

**Files:**
- Modify: `packages/compiler/src/types.ts` (`ResolvedMcpConnection.auth` union gains `{ kind: "oauth"; connectionId: string }`), `packages/compiler/src/codegen/connections.ts` (emit the oauth branch), `packages/compiler/src/codegen/libs.ts` or a new emitted `lib/platform-token.ts` (the helper below), `packages/compiler/src/version.ts` (**bump `COMPILER_VERSION`**), golden fixtures: new `packages/compiler/fixtures/oauth-connection/` + regenerate digests with `UPDATE_GOLDEN=1`
- Modify: `apps/control-plane/src/build/compiler-adapter.ts` (map `authType:"oauth"` rows → `{kind:"oauth", connectionId}`; extend the env-name agreement guard to require `PLATFORM_API_URL`), `apps/control-plane/src/runtime/agent-env.ts` (inject `PLATFORM_API_URL` from config), `apps/control-plane/src/runtime/config.ts` + `.env.example` + `docker-compose.prod.yml` (`PLATFORM_API_URL` — the control-plane base URL as reachable from the worker network; prod compose: `http://control-plane:3000`)
- Test: compiler unit goldens; `apps/control-plane/src/resources/mcp-crypto.test.ts`-adjacent env-agreement test extended

**Interfaces:**
- Consumes: Task 7's route contract.
- Produces: generated `agent/connections/<slug>.ts` for oauth rows:

```ts
auth: {
  // Broker-delivered: the platform mints short-lived access tokens; no OAuth
  // material lives in agent env. Lazy so keyless builds never crash.
  getToken: async () => ({ token: await platformConnectionToken("cn_…") }),
},
```

and emitted `lib/platform-token.ts`: `platformConnectionToken(connectionId)` — in-process cache per connection id with 60 s expiry margin; on miss: HS256-sign (hand-rolled on `node:crypto` — `base64url(header).base64url({iss: PLATFORM_JWT_ISSUER, aud: PLATFORM_JWT_AUDIENCE, sub: "agent", iat, exp: iat+120})` + HMAC — the audience/issuer constants are already emitted in the lib) with `requireEnv("PLATFORM_JWT_SECRET")`, then `fetch(`${requireEnv("PLATFORM_API_URL")}/internal/connections/token`, { method:"POST", headers:{ authorization:`Bearer ${jwt}`, "content-type":"application/json" }, body: JSON.stringify({ connectionId }) })`; non-200 → throw `Error("connection needs re-authorization: " + code)` (a failed tool call, never a hang).

- [ ] **Step 1: Failing golden test** — add the `oauth-connection` fixture (definition with one oauth connection) and assert the emitted files; run `bun test packages/compiler` → digest guard FAILS (expected — bytes changed without a bump).
- [ ] **Step 2: Implement codegen + bump `COMPILER_VERSION` + `UPDATE_GOLDEN=1 bun test packages/compiler` to regenerate; run again WITHOUT the flag → PASS.**
- [ ] **Step 3: Control-plane side** (adapter mapping, env injection, agreement guard, config, compose, `.env.example`); gated compile-service test: publishing an agent with an oauth connection produces an artifact whose connections file contains `platformConnectionToken` and whose env assembly carries `PLATFORM_API_URL` — and the content hash DIFFERS from the same definition with bearer auth (auth shape is hashed; spec §8).
- [ ] **Step 4: Full sweep** — unit + typecheck + gated lane; if `SPIKE_EVE_BUILD=1` is cheap on this machine (warm cache), run the real-build fixture lane to prove the keyless `eve build` still succeeds with the new emitted file.
- [ ] **Step 5: Commit** — `feat(compiler,control-plane): oauth getToken codegen via the platform token broker`

---

### Task 9: Mid-run authorization — tailer latch, event classification, chat card

**Files:**
- Modify: `apps/control-plane/src/runs/tailer.ts` (add `pendingAuthorization` latch mirroring `pendingInputRequest`: set on `authorization.required`, cleared on `authorization.completed`, invalidated at the same turn boundaries; while latched, a settling `session.waiting` classifies the run **waiting**, never succeeded), its classification/`run_events` plumbing for both event types, and the slug→connection health flip (resolve via Task 2's `connection_slugs`, set `health:"auth_required"`)
- Modify: `apps/web/src/components/chat/` (the run event renderer — locate the component that renders `input.requested` approval cards and follow its idiom): `AuthorizationCard` — waiting-amber (`#f59e0b`) card showing server name, **target host rendered prominently** (the URL is server-supplied content in trusted chrome — spec §13), instructions, `userCode` when present, expiry countdown, consent link (opens in new tab), resolved state on `authorization.completed` (`authorized|declined|failed|timed-out`)
- Test: tailer fixture tests (extend the existing tailer test file's NDJSON-fixture idiom): `.required` sets the latch + writes the run event + flips health; `.waiting` while latched → run `waiting` (the Slack-truncation hazard case); `.completed` clears + resolves; web test for the card states

**Interfaces:** Consumes Task 1's finding — **branch**: if the spike observed `authorization.required`, wire everything above; if eve emitted only generic errors, STILL implement the tailer latch + classification + card (the types exist and are docs-derived; the code is defensive and cheap) but record in the commit body and `docs/PLAN.md` that the surface is dormant pending eve support. Either way the latch tests run against synthetic NDJSON fixtures.

- [ ] Steps: failing tailer fixtures → implement latch/classification/health flip → failing web card test → implement card → full unit + gated lanes PASS → commit `feat(control-plane,web): authorization-pending latch and chat consent card`

---

### Task 10: OAuth catalog entries + web connect flow

**Files:**
- Modify: `packages/shared/src/connector-catalog.json` (+ verified OAuth entries), `packages/shared/src/connector-catalog.test.ts` (drop/adjust the "no oauth recipes" assumption if one exists)
- Modify: `apps/web/src/components/context/AddConnectionDialog.tsx` + `CatalogTile.tsx` (OAuth recipe → "Connect" flow), `ConnectionDetail.tsx` (auth panel oauth states: Connect / Connected-as shield / Reconnect on `expired|revoked|error`), `apps/web/src/lib/queries/connections.ts` (+`useStartOauth(ref)` → `{authorizeUrl}`; popup helper: open, listen for the `postMessage` with origin check against the app origin, then invalidate the connection)
- Test: web tests for the connect flow (popup message → refetch → connected chip; reconnect button on `expired`)

**Catalog candidates** (verify EVERY one before keeping — same discipline as Plan 1 Task 4, now two checks: (a) the endpoint answers MCP-ish (the Plan 1 curl), (b) `discoverOauth` succeeds against it — write a tiny gated script or test to run discovery against each candidate; drop entries failing either): Linear `https://mcp.linear.app/mcp`, Notion `https://mcp.notion.com/mcp`, Sentry `https://mcp.sentry.dev/mcp`, GitHub `https://api.githubcopilot.com/mcp/`, Intercom `https://mcp.intercom.com/mcp`, Neon `https://mcp.neon.tech/mcp`, PayPal `https://mcp.paypal.com/mcp`, Vercel `https://mcp.vercel.com`. Entries: `auth: {"type":"oauth"}`, categories per spec §4, `featured` for Linear/Notion/GitHub/Sentry. Record per-candidate results in the commit body; a dropped candidate is fine, an unverified kept one is not.

- [ ] Steps: failing web tests → implement flow + detail states → catalog verification script run + entries added → web tests + catalog tests + typecheck PASS → commit `feat(web,shared): oauth connect flow and verified oauth catalog entries`

---

### Task 11: E2E — the full OAuth spine

**Files:**
- Create: `e2e/scripts/stub-as.ts` (authorization server: RFC 8414 metadata, `/authorize` auto-approving with an interstitial "Approve" button — the Playwright popup clicks it — `/token` validating PKCE + `resource` + single-use codes, refresh grant, `/revoke`; a `POST /__expire` test hook force-expires issued access tokens), extend `e2e/scripts/stub-mcp.ts` (a THIRD endpoint `/mcp-oauth` requiring `Authorization: Bearer <token the stub AS issued>` — 401 with `WWW-Authenticate` + PRM pointing at the stub AS otherwise), `e2e/specs/oauth-connection.e2e.ts`, harness env (`PLATFORM_API_URL` for the worker-booted agents → the control plane under test; stub ports in `e2e/config.ts` `PORTS`)
- Modify: `e2e/README.md`

**Journey (this proves the entire broker chain end-to-end):** custom URL → `/mcp-oauth` → create with OAuth → Connect popup → stub AS approve → callback closes popup → card shows connected + probe `ok` with tools → attach → publish → chat message triggering the stub tool → **the compiled agent's `getToken` hits `/internal/connections/token`, the broker refreshes as needed, the tool call succeeds** (assert via the stub's `__calls` log and the AS's token-endpoint counter) → `POST /__expire` → next chat tool call still succeeds (broker refreshed — AS counter incremented) → detail shows Reconnect after the AS starts returning `invalid_grant` (mode switch) and the run surfaces a failed tool call, not a hang.

- [ ] Steps: write spec + stubs → wire harness env/ports → `cd e2e && bunx playwright test --workers=1` → PASS → commit `test(e2e): oauth consent, broker refresh, and compiled-agent token delivery`

---

### Task 12: Docs, changeset, release hygiene

**Files:**
- Modify: `AGENTS.md` (constraints: broker egress rule, runtime token route + its auth model distinction from `/internal/metrics`, `PLATFORM_API_URL` in the env story, oauth error vocabulary `oauth_not_connected`; living-docs table already lists the spec — update its description to mark Plans 2–3 landed), `README.md`, `docs/runtime-worker-contract.md` (verify Task 7's section reads true post-integration), `apps/site/src/content/docs/building/context-mcp.mdx` (one-click OAuth sentence — **the Plan 1 lesson: site docs are in scope**), `docs/PLAN.md` (connectors redesign complete), `.env.example` final audit vs `grep -rn "process.env" apps/control-plane/src/oauth apps/control-plane/src/runtime/config.ts`
- Create: `.changeset/connectors-oauth-broker.md`:

```md
---
"@invisible-string/control-plane": minor
"@invisible-string/compiler": minor
"@invisible-string/db": minor
"@invisible-string/shared": minor
"@invisible-string/web": minor
---

Add the MCP OAuth 2.1 broker: path-aware discovery, CIMD/DCR client identity, PKCE popup consent, envelope-encrypted tokens with single-flight central refresh, an agent-facing token route with audience-derived version binding, oauth codegen via getToken, and OAuth connectors in the catalog.
```

(Verify the workspace list against `git diff --stat <baseline>..HEAD` — include `worker` only if it was actually touched.)

- [ ] Steps: docs edits cross-checked against shipped code → full verification (unit serviceless; gated lane incl. oauth suites; e2e `--workers=1`; `bun test packages/compiler` golden guard green) → tree clean → commit `docs: connectors plan-3 documentation sweep and changeset`
