# Connectors redesign — curated catalog, Meilisearch registry search, MCP OAuth broker

**Date:** 2026-08-09
**Status:** Approved design (brainstorm with Sanil; approach A + Meilisearch amendment)
**Supersedes:** the MCP-connection surfaces of the 2026-07-02 design and 2026-07-10 redesign specs (registry browser modal, passthrough search, static-credentials-only auth model). The `mcp_connections` table is retired in place (see §16).

---

## 1. Motivation

Three symptoms, all confirmed against the current code:

1. **Junk search results.** `GET /mcp-registry/search` is a raw passthrough to the official registry's `?search=` — a substring match on server *name* only, in upstream order, unpaginated. Non-installable stdio-only servers are filtered at the presentation layer, not the query layer, so they occupy result slots as dead cards. No ranking, no curation, no fork dedupe.
2. **No OAuth.** Credentials are static bearer/header values. The MCP ecosystem has standardized OAuth 2.1 (authorization spec 2025-06-18 through 2026-07-28: RFC 9728 protected-resource metadata, PKCE, resource indicators); the flagship remote servers (Linear, Notion, Sentry, …) are OAuth-only. eve's native `authorization.required` / `authorization.completed` events are fully typed in `packages/shared/src/eve-events.ts` and handled nowhere.
3. **Blind configuration.** No tool discovery (allow/block lists typed from memory into free text), no test-connection, no health state; the first signal a connection is broken is a failed tool call mid-run.

Decisions locked during brainstorm:

- **Consumer-grade experience**: curated branded catalog first, community registry search behind it, custom URL escape hatch.
- **Full spec-compliant OAuth broker**: works for any compliant remote server, not just catalog entries.
- **Both scopes** (workspace and personal), matching the existing resource-scope model.
- **No data compat**: no real connections exist; the domain is rebuilt cleanly (migrations remain additive — old objects go dead, not dropped).
- **Meilisearch** as the search layer (amendment): registry index now, future indexes (conversation search) reuse the service.

## 2. Concept model

A **connection** is a workspace- or user-owned handle on one remote MCP server: URL + transport + auth + tool policy + health. Three **sources**:

| Source | Origin | Trust basis |
|---|---|---|
| `catalog` | Curated first-party catalog (checked into the repo) | Hand-vetted: domain-verified publisher, working remote, known auth recipe |
| `registry` | Community tier — official MCP registry, mirrored into Meilisearch | Registry provenance: install re-verifies the remote URL against the live registry |
| `custom` | User-supplied URL | None; user's own responsibility |

Auth is one of `none | bearer | headers | oauth`. The first three keep today's model (envelope-encrypted values, env-injected at dispatch). `oauth` is new: the control plane owns the full OAuth lifecycle and the running agent fetches short-lived access tokens on demand — refresh tokens never leave the control plane, and no OAuth material ever enters agent env.

The add-connection surface has three lanes: catalog grid (default view, zero network calls), unified search (catalog matches pinned above community results), custom URL form.

## 3. Data model

New tables in `packages/db` (additive migration; nanoid ids per house convention).

**`connections`** — replaces `mcp_connections`:

| Column | Type | Notes |
|---|---|---|
| `id` | text PK | `cn_<nanoid16>` |
| `scope` | `resource_scope` | reuse existing enum (`workspace`\|`user`) |
| `organization_id` / `user_id` | text FK cascade | exactly-one-owner CHECK, as today |
| `name` | text NOT NULL | **unique per owner**: partial unique indexes on `(organization_id, name)` and `(user_id, name)` — reduces slug-collision surface. Distinct names can still slugify identically, so create/rename additionally rejects a name whose slug collides with a sibling's (friendlier than the compiler's publish-time duplicate-slug error, which remains the backstop) |
| `description` | text | model-facing; drives eve's connection routing |
| `source` | new enum `connection_source` (`catalog`\|`registry`\|`custom`) | |
| `catalog_slug` | text nullable | provenance for `catalog` |
| `registry_name` | text nullable | provenance for `registry` (e.g. `app.linear/linear`) |
| `url` | text NOT NULL | |
| `transport` | new enum `mcp_transport` (`streamable-http`\|`sse`) | persisted at install (today it is discarded) |
| `auth_type` | new enum `connection_auth_type` (`none`\|`bearer`\|`headers`\|`oauth`) | |
| `auth_config_encrypted` | text nullable | static creds only; AES-256-GCM envelope, AAD `connections:auth_config:<id>` |
| `tool_allow` / `tool_block` | jsonb `string[]` | mutually exclusive, as today |
| `approval_policy` | jsonb | as today |
| `enabled` | boolean default true | |
| `health` | new enum `connection_health` (`unknown`\|`ok`\|`unreachable`\|`auth_required`\|`auth_error`) | |
| `last_checked_at` / `last_error` | timestamptz / text | |
| `tools_cache` | jsonb nullable | `[{name, description, params: string[]}]`, trimmed, capped at 200 entries |
| `tools_cached_at` | timestamptz nullable | |
| `created_at` / `updated_at` | timestamptz | |

**`connection_oauth`** — 1:1 with an `oauth`-type connection; separate row so token churn never rewrites the connection row and each envelope AAD binds to its own identity (`connection_oauth:<column>:<id>`):

| Column | Notes |
|---|---|
| `id` text PK | `co_<nanoid16>` |
| `connection_id` | FK unique, cascade |
| `authorization_server` | issuer URL from RFC 9728 discovery |
| `authorization_endpoint` / `token_endpoint` / `revocation_endpoint` | resolved RFC 8414 metadata |
| `resource` | the PRM's canonical RFC 8707 resource identifier |
| `scopes` | jsonb `string[]` granted |
| `client_identity_mode` | **amended 2026-08-31** — enum `connection_oauth_client_mode` (`cimd`\|`dcr`\|`preregistered`): which strategy minted the identity below |
| `client_id` | from CIMD (our hosted URL), DCR registration, or operator config |
| `client_secret_encrypted` | nullable (DCR may issue one; a pre-registered client may carry one) |
| `client_registration_issuer` | **amended 2026-08-31** — the AS `issuer` that minted a DCR client; reuse is gated on it still matching (F13) |
| `access_token_encrypted` / `access_token_expires_at` | |
| `refresh_token_encrypted` | nullable (some servers issue none) |
| `status` | enum `connection_oauth_status` (`pending`\|`connected`\|`expired`\|`revoked`\|`error`) |
| `pending_state` / `pending_code_verifier_encrypted` / `pending_expires_at` | the in-flight consent (single-use `state`, PKCE verifier, 10 min TTL) — one pending flow per connection; a new start supersedes it. Cleared on callback |
| `pending_flow` | **added 2026-08-31** — jsonb `PendingOauthFlow`: the armed flow's STAGED discovery (`authorization_server`, endpoints, `resource`, requested `scopes`) **and** client identity, held apart from the live grant until an exchange succeeds. The eight columns above it are written ONLY by that successful exchange, promoting this object beside the tokens it minted — see §6 "Discovery is flow state" |
| `pending_started_by` | **added 2026-08-31** — the user who armed the flow; the callback requires the session user to match (F15). `SET NULL` on user delete: an orphaned flow simply cannot be completed |
| `expected_issuer` / `iss_parameter_supported` | **added 2026-08-31** — the issuer the AS claimed for itself, and whether it advertises `authorization_response_iss_parameter_supported`, both checked against the callback's RFC 9207 `iss` before the exchange (F13) |
| `last_error_code` | **added 2026-08-31** — sanitized typed failure code for the detail surface. A CODE, never a provider message |
| `connected_by` | user id — audit trail only, not authorization |
| `created_at` / `updated_at` | |

**`registry_sync_state`** — single row: `id` text PK (constant `'official'`), `last_updated_since` timestamptz, `last_synced_at` timestamptz. Cursor state for the ETL (§5).

DTO/zod mirrors land in `packages/shared/src/api.ts` as today (new enums mirrored, `connectionDtoSchema` exposing `hasCredentials`, `oauthStatus`, `health`, `toolsCache`; token/header values never serialized).

**Shared-contract ripple (AgentDefinition).** `packages/shared/src/agent-definition.ts` currently validates `mcpConnectionIds` as uuid-only (`uuidArray`, line 95) — left alone, every draft save/publish referencing a `cn_` id would 422 on day one. The field becomes a union accepting both the historical uuid shape (published definitions are immutable and must keep parsing) and `cn_<nanoid16>`. The copilot's inventory-scoped-id validation and the delete guard's jsonb containment queries follow the definition contract; both are covered by the integration/authz tests.

## 4. Curated catalog (catalog-as-code)

`packages/shared/src/connector-catalog.json` + zod schema `connectorCatalogSchema`:

```jsonc
{
  "slug": "linear",
  "title": "Linear",
  "category": "project-management",   // enum: productivity, project-management, dev-tools, data, communication, commerce, other
  "description": "Issues, projects, and cycles.",       // card copy
  "modelDescription": "Linear project management: issues, projects, cycles, comments.", // seeds connection.description
  "icon": "linear",                    // key into bundled icon assets in apps/web
  "url": "https://mcp.linear.app/mcp",
  "transport": "streamable-http",
  "auth": { "type": "oauth" },        // or {"type":"headers","headers":[{name,description,isSecret}]} or {"type":"none"}
  "registryName": "app.linear/linear", // provenance link, optional
  "featured": true
}
```

- **Inclusion criteria** (documented in the file header): domain-verified publisher namespace or first-party vendor documentation, working `streamable-http` remote, known auth recipe, description written by us. **Amended 2026-08-31:** an `oauth` recipe additionally declares how the broker gets its CLIENT identity — `clientIdentity: "dynamic"` (the default, and what a bare `{"type":"oauth"}` still means: CIMD or DCR, decided per deployment against the AS metadata) or `"preregistered"` + `clientEnvPrefix` for an authorization server that gates registration behind an approved-client allowlist (§6). A new oauth preset is verified by the gated `CATALOG_PREFLIGHT=1` lane, which walks it live to the point of a registration endpoint that actually accepts this deployment's redirect URI; the old shape-only assertion is exactly what let the unworkable Vercel entry ship. Target ~25–40 entries at launch (Linear, Notion, Sentry, GitHub, Stripe, Cloudflare, Supabase, Figma, Atlassian, Context7, DeepWiki, …); curation is a PR, reviewed like code.
- The control plane loads and validates the catalog at boot (fail-fast on schema errors) and uses it to validate catalog installs server-side. The SPA imports the same JSON for rendering — no network call, no DB seeding, no drift.
- Catalog icons are bundled assets in `apps/web` (monochrome-treated per E1).

Install: `POST` create-from-catalog with `{slug, scope}` → row seeded from the recipe → if `auth.type` is `oauth`, the response includes the OAuth start URL so the UI chains straight into consent (§6); if `headers`, the UI collects values first (same one-shot secret submit as today).

## 5. Community search — Meilisearch mirror

**Service.** Meilisearch (MIT, single binary) joins `docker-compose` (dev + prod). Env: `MEILISEARCH_URL`, `MEILISEARCH_MASTER_KEY` (generated into `.env` by dev bootstrap, secret in prod). The index is **disposable**: the official registry is the durable source of truth, so Meilisearch gets no backups and no migrations — an empty index triggers a full resync at boot. `docs/DEPLOY.md` documents exactly that.

**ETL.** A control-plane sync job on the existing ticker/advisory-lock pattern (`REGISTRY_SYNC_INTERVAL_MS`, default 6 h; first run = full sync from epoch). Each run pages `GET /v0.1/servers?updated_since=<last>&include_deleted=true` (the path already pinned in `registry.ts`; `include_deleted` defaults to true with `updated_since` but stays explicit) with cursor pagination against the one hardcoded registry host (`MCP_REGISTRY_BASE_URL` override for dev/CI — this var also gets backfilled into `.env.example`, fixing an existing docs gap), then:

- index only entries that are `isLatest`, active, and have ≥1 remote (**installable-only at the ingestion layer** — stdio-only packages never enter the index);
- delete documents for entries that became deleted/inactive/remote-less;
- advance `registry_sync_state` only after a fully successful run.

**Documents.** id = **unpadded** base64url(server name) (Meilisearch ids allow only `[A-Za-z0-9_-]`; names contain `/` and `.`, and `=` padding is outside the charset). Fields: `name`, `title`, `description`, `websiteUrl`, `remotes[{type,url,headers}]`, `verified` (namespace is not `io.github.*` — i.e. domain-verified publisher), `updatedAt`. Index settings: searchable `[title, name, description]`; filterable `[verified]`; ranking rules = Meilisearch defaults + `verified:desc` custom rule, so official publishers rank above `io.github.*` forks with equal text relevance.

**Search API.** `GET /mcp-registry/search?q=&limit=&offset=` (same nginx-enumerated prefix) now queries Meilisearch: typo-tolerant, prefix-matching, ranked, paginated. Response keeps the `RegistryServerSummary` DTO plus `verified`. The install detail route `GET /mcp-registry/server/:name` and the install-time **live provenance re-fetch stay pointed at the official registry** unchanged — search quality and install trust are decoupled, and the SSRF stance (only the hardcoded registry host, never a caller URL) carries forward.

**Degradation.** Meilisearch down → typed 503 `search_unavailable`; catalog and custom lanes are unaffected. The SPA shows the community section's error state inline while catalog results still render.

## 6. OAuth broker

Implements MCP authorization (2026-07-28 revision) client-side in the control plane. All state transitions live server-side; the SPA only opens URLs and polls.

**Discovery** (`oauth-discovery` module): given the connection URL — read the `WWW-Authenticate` challenge from a 401, and fetch RFC 9728 protected-resource metadata using the **path-aware well-known variants** the MCP auth spec requires (for a server at `https://host/mcp`, try `/.well-known/oauth-protected-resource/mcp` before the root variant — real servers mount MCP under a path). From the PRM: the canonical `resource` identifier (used for RFC 8707, not assumed equal to the connection URL) and the authorization server issuer → AS metadata via RFC 8414 path-inserted and OIDC discovery variants, in spec order. A server with no OAuth metadata is not an OAuth connection (typed `oauth_discovery_failed` guides the user to header auth instead). All discovery fetches go through the guarded egress helper (§7) — a malicious MCP server controls its advertised authorization servers.

**Amended 2026-08-31 (fix plan P0.1/P4.1–P4.3).** Discovery results are NOT stored on the grant — they are staged (see "Discovery is flow state" below) — and four conformance rules now govern what discovery will accept:

- **Scheme.** Every URL a server hands us (`resource_metadata` pointer, PRM `resource` and `authorization_servers[0]`, and the AS's authorization/token/registration/revocation endpoints) is parsed and required to be `https:`, with no embedded credentials and no fragment. This is not redundant with the egress guard: the SPA NAVIGATES the consent popup to `authorization_endpoint`, and that popup inherits the app's origin, so a custom server's `javascript:` endpoint would be script execution on a path no fetch guard sees. `http:` is admitted only when the MCP URL itself is `http:` (i.e. a dev stack under `MCP_PROBE_ALLOW_PRIVATE`); the SPA re-checks independently (`isSafeAuthorizeUrl`, https or loopback http).
- **Scope.** Precedence is the `WWW-Authenticate` challenge's `scope` (authoritative per the MCP spec — the server saying what THIS request lacked) → the PRM's `scopes_supported` → nothing at all, in which case the `scope` parameter is omitted and the AS applies its default. The AS-wide `scopes_supported` is **not** a fallback: it over-requests every scope an authorization server advertises globally against an unrelated resource. The single read of that list is `offline_access` — appended when the AS advertises it and a scope set already resolved, because an AS that gates refresh tokens on it issues none and the grant dies at first expiry; never sent alone, since `scope=offline_access` by itself converts an implicit default grant into an explicit request for no resource access.
- **Issuer.** `issuer` is REQUIRED (RFC 8414 §2) and must be the issuer whose well-known was requested (tolerating only a lone trailing slash). A document describing a different issuer is a MISS and probing continues, which is what stops a multi-tenant host's root well-known from answering for a tenant issuer. The verbatim `issuer` and the AS's `authorization_response_iss_parameter_supported` are carried into the flow: the callback's RFC 9207 `iss` is validated against them before the code is exchanged, and a MISSING `iss` is an error only when the AS promised one.
- **Resource.** The PRM's `resource` must identify the MCP URL we asked about — same origin, requested path at or below the resource's path (ancestry is legitimate: a server at `/mcp` may publish one root PRM). A different origin is the audience-injection case and is refused. Trailing slashes are normalised on both sides (a root PRM answering `https://host/` for a catalog URL written `https://host` is doing nothing wrong), and the value is then used verbatim.

Failure reasons are typed: `invalid_url`, `insecure_endpoint`, `egress_blocked`, `no_oauth_metadata`, `prm_invalid`, `resource_mismatch`, `as_metadata_unavailable`, `as_metadata_invalid`, `issuer_mismatch`, `pkce_unsupported`.

**Client identity** (order amended 2026-08-31 — **pre-registered** first, then CIMD, then a stored DCR registration, then a fresh one):

- **Pre-registered** (fix plan P2 option b): an operator-supplied `client_id` (+ optional secret, + optional issuer pin) read from `MCP_OAUTH_<PREFIX>_CLIENT_ID` / `_CLIENT_SECRET` / `_ISSUER`, where `<PREFIX>` is authored on the catalog entry as `auth.clientEnvPrefix` beside `clientIdentity: "preregistered"`. It wins over both dynamic strategies by definition: an operator who configured a client is stating that this AS accepts nothing else. It exists because some authorization servers gate registration behind an approved-client allowlist and reject every DCR body — **Vercel**'s `registration_endpoint` answers `400 invalid_redirect_uri` to any redirect URI it has not approved, which surfaced as a 502 behind an already-open consent popup (fix plan F2). Config is parsed at boot, so a half-configured or misspelled variable fails fast rather than mid-consent; a preset declaring `preregistered` with nothing configured fails naming its variables and never POSTs a registration that cannot be accepted.
- A stored DCR registration is **keyed by issuer** (`client_registration_issuer`): a `client_id` means nothing at an AS that did not issue it, so a migrated AS re-registers instead of replaying a stale client, and a server that repoints discovery is never handed the previous AS's secret. An UNRECORDED issuer (rows predating the column) is reused and backfilled — that is not evidence of a change, and re-registering would mint a new `client_id` over the one the row's live tokens were issued to.

Client ID Metadata Documents next — our `client_id` is `https://<PUBLIC_URL>/integrations/mcp-oauth/client-metadata.json`, a static document served by the control plane (rides the already-enumerated `integrations` nginx prefix). CIMD requires the AS to fetch that URL, i.e. a publicly reachable HTTPS control plane — dev and non-public self-hosted stacks skip straight to the fallback: Dynamic Client Registration (RFC 7591), the registration record living on the connection's 1:1 `connection_oauth` row (per-connection registration; some ASes rate-limit DCR, so the flow registers once per connection and reuses the record thereafter). No per-provider manual app registration.

**Flow**:

1. `POST /…/connections/:id/oauth/start` → server builds the authorization URL: PKCE S256, `resource` indicator = the PRM's canonical resource (RFC 8707 — sent on the authorization request **and on every token request**: exchange and refresh), scopes per the precedence rule above, `state` = single-use nanoid persisted on the `connection_oauth` row's pending-flow columns (§3) so it survives restarts. Response `{authorizeUrl}`; SPA opens a popup. **Amended 2026-08-31:** arming transitions the row to `pending` *except on a grant that is already `connected`* — `getAccessToken` gates on exactly that value, so flipping it the moment a popup opens would fail every agent tool call and every probe on a token that is still valid, and an abandoned reconnect would never put it back. Everything discovery learned, plus the client identity, is staged on `pending_flow`; the flow also records `pending_started_by`, `expected_issuer` and `iss_parameter_supported`, and clears the previous attempt's `last_error_code`.
2. `GET /integrations/mcp-oauth/callback?code&state&iss` → validate state (single-use), require the session user to be the flow's initiator (`not_initiator` otherwise), validate the RFC 9207 `iss` against the flow's expected issuer, exchange code + verifier at the token endpoint (via the guarded egress helper), envelope-encrypt tokens, **promote `pending_flow` onto the grant in the same write**, status `connected`, then fire an async probe (§7). The callback returns a minimal page that `postMessage`s `{type, ok, connectionId, reason}` with `targetOrigin` pinned to the **SPA's** origin — `PUBLIC_WEB_URL`, defaulting to `PUBLIC_APP_URL` (never `*`, and never the API origin: they differ in local dev, and a mismatched `targetOrigin` is dropped by the browser in total silence, which made a successful consent read as a dismissal — fix plan F8) — and closes; the SPA invalidates the connection.
3. **Errors amended 2026-08-31 (F5/F9/F12).** Every start/callback failure persists a sanitized typed `last_error_code`, and the popup payload carries the same code as `reason` for the SPA's copy table — a code, never a provider message, and never an OAuth value. `status: error` is written **only when the flow had no usable grant to lose**: a first consent, or a re-consent of an expired/errored grant, really is broken and should say so, but a re-consent of a LIVE grant that the user merely dismissed (or that an AS fumbled for a minute) must leave the working grant exactly as it was.

**Discovery is flow state (amended 2026-08-31, adversarial review).** A start writes NO grant column. The endpoints it discovered — `token_endpoint` above all — are where `getAccessToken` replays a still-valid refresh token, with the client secret, months later, and the MCP server chooses its own authorization server. Writing discovery onto the row at start time therefore turned every re-consent that did not complete (a closed popup, a declined consent, a rejected `iss`) into delivery of the previous AS's refresh token to whatever endpoint the server had just advertised — and the F5 rule above, which deliberately keeps such a grant `connected`, is what made `getAccessToken` willing to send it. Deleting the connection made it worse: best-effort revocation posts the same token at the stored revocation endpoint. So one staged `pending_flow` object holds everything, the exchange reads its material from there whole, and a SUCCESSFUL exchange promotes it beside the tokens it minted. Rows armed before the column existed still exchange against the live columns — a compatibility path that expires with one `OAUTH_PENDING_TTL_MS`. No runtime issuer gate exists in `tokens.ts` because under this design the two values only ever move together; the invariant is stated in that module's header and guarded by broker.test.ts's "a re-consent that never completes cannot repoint a live grant". Accepted cost: two abandoned FIRST attempts register two dynamic clients, since nothing persists the first.

**Refresh** — central and lazy: every consumer goes through `getAccessToken(connectionId)` — including the health probe (§7), which is the whole point: it is the ONLY reader of a grant's tokens. It returns the cached access token unless it expires within a 60 s margin, else refreshes (single-flight via `SELECT … FOR UPDATE` on the `connection_oauth` row; correct even if the control plane ever gains replicas). Refresh failure with `invalid_grant` → status `expired`, health `auth_error`. **Amended 2026-08-31 (F4/P3.1): that is the ONLY terminal failure.** An AS 5xx, an egress timeout or a guard refusal never spent the refresh token, so nothing is persisted and the typed error is simply rethrown for the next demand to retry — writing a status there would trip this function's own `status !== "connected"` gate on every later call, making a 30-second outage indistinguishable from a dead grant and forcing a needless re-consent. No background refresh sweeps — nothing consumes tokens while nothing is running.

**Runtime delivery** (the broker's second half):

- Agent env gains `PLATFORM_API_URL` (control-plane base URL as reachable from the worker network; agents run in the worker's network namespace and never cross the public gateway). The compiler↔dispatcher env-name agreement guard extends to it.
- Codegen for `oauth` connections emits `auth: { getToken }` where the emitted helper: mints a platform JWT with the in-env `PLATFORM_JWT_SECRET`, audience `agent-version:<hash>`. Today's `codegen/libs.ts` emits only the **verifier** (`verifyJwtHmac`), so the helper gains a minimal HS256 signer on `node:crypto` — no new generated-project dependencies. It calls `POST ${PLATFORM_API_URL}/internal/connections/token` (joining the existing `/internal/*` namespace from the runtime-worker contract; this route is platform-JWT-authed, unlike its `x-worker-secret` siblings) with `{connectionId}`, caches `{token, expiresAt}` in-process, refetches past a 60 s margin. Failures throw typed errors so a tool call fails with "connection needs re-authorization", not a hang.
- **Server-side verification is exact, in this order**: parse the *unverified* `aud` claim → require the strict shape `agent-version:<64-hex>` (reject the bare `agent-version` audience used by channel dispatch, `runtime/jwt.ts:23`) → derive that version's secret via `derivePlatformJwtSecret` → verify signature/`exp`/issuer against it → only then resolve the version row by the hash and **authorize by membership**: the connection id must be in that version's compiled definition. The version hash comes only from the verified audience — never from the request body. The route returns `{token, expiresAt}` only — never refresh material. Audience and derived secret both bind the hash, so a compromised agent env can reach only its own version's connections. One-run-per-session and workspace row-ownership invariants are untouched.
- OAuth connections are excluded from `decryptMcpEnv` env injection entirely; static-auth connections keep today's env path byte-for-byte.

**Mid-run challenges.** eve's `authorization.required` / `authorization.completed` types are DOCS-DERIVED (`eve-events.ts:28-32`) and have never been captured live, so this slice is **gated on a spike capture first**: point a compiled agent at a stub server that rejects its token mid-session and record what eve actually emits (finding appended to `spike/REPORT.md` either way). The mechanics, once confirmed:

- The tailer gains an **authorization-pending latch** mirroring the existing `input.requested` latch: set on `authorization.required`, cleared on `authorization.completed`. While set, a settling `session.waiting` classifies the run as *waiting*, not *succeeded* — without this, the tailer's default classification lands the run `succeeded` and DeliveryService posts a truncated Slack reply (the exact unhandled-`session.waiting` hazard AGENTS.md documents).
- The event names the connection by its per-version slug; the compiler adapter's slug↔connection-id map is persisted on the agent version row so the tailer can resolve the row and flip its health to `auth_required`.
- The chat UI renders a waiting-amber card (server name, **target host shown prominently** — the consent URL is server-supplied content inside trusted chrome — instructions, user code, expiry) and `authorization.completed` resolves it (`authorized|declined|failed|timed-out`). No new run status.

This is deliberately minimal: the broker makes pre-authorized connections the norm; the card is the fallback for revocations and exotic servers.

**Reconnect** = re-run the start flow on the same row (state supersedes previous grants; old tokens are overwritten). **Mutations**: a PATCH that changes `auth_type` away from `oauth` performs best-effort RFC 7009 revocation at the AS, then deletes the `connection_oauth` row; changing a custom connection's URL revokes and resets OAuth to unconnected (issued tokens were bound to the old resource) and requires re-connect; connection delete also revokes best-effort. **Amended 2026-08-31 (F16):** a reset also clears the row's stale PROBE columns, which described a world that no longer exists — `health` becomes `auth_required` for the blank `pending` grant (or `unknown` when leaving oauth for a static credential nothing has tried yet), `last_error`/`last_checked_at` clear, and a URL change additionally drops `tools_cache` (those are a different server's tools). The grant's client identity goes with it: a registered client is only valid at the issuer that minted it. Entering oauth FROM a static auth type is the mirror image and clears the same way. URL and auth-mode changes alter the content hash, so compiled agents pick them up on the **next publish** — the UI says so inline.

## 7. Tool discovery, validation, health

A control-plane **probe service** using the official `@modelcontextprotocol/sdk` client (streamable-http, SSE fallback per the connection's transport): initialize handshake → `tools/list` → write `tools_cache` (+`tools_cached_at`), set `health`:

| Outcome | health |
|---|---|
| Handshake + list OK | `ok` |
| 401/403, no credentials presented | `auth_required` |
| 401/403 with a credential presented | `auth_error` |
| Timeout / network / protocol failure | `unreachable` (+`last_error`) |

**Where the credential comes from (amended 2026-08-31, fix plan F1/P1.1).** Static auth (`bearer`/`headers`) decrypts the row's `auth_config_encrypted` envelope, exactly as before. An `oauth` row's token lives in a different home and has exactly one reader — `getAccessToken` (§6) — so the probe branches: a grant that is not `connected` is `auth_required` **with no dial at all** (consent is the missing piece; a round trip cannot say anything new, and the badge should read "connect", not "rejected"), and a `connected` grant dials with `Authorization: Bearer <token>`, refreshing first if the stored one is stale. A 401 there is the only legitimate `auth_error`. `oauth_not_connected` from that call maps to `auth_required`, `oauth_exchange_failed` to `unreachable` (the third party we could not reach is the AS), and anything else is infrastructure failure → 502 `probe_failed`. Consequently **`hasCredentials` is derived from the grant, never from `auth_type === "oauth"`** — in the DTO and in the probe alike. The original code did neither: it dialled OAuth servers with no Authorization header, called the resulting 401 `auth_error`, and so every OAuth connection reported a rejected token it had never sent and never populated `tools_cache` — no tool picker, no per-tool approvals, no version tool directory, no copilot inventory.

**Triggers**: after create/install **for static auth only**; after OAuth callback; manual "Test connection"; lazy re-probe when a connection detail is opened and `last_checked_at` is >15 min stale **and the row is probeable** (an oauth row without a `connected` grant is not). Probes are never in the publish path — publish behavior (including "disabled connection fails publish with `context_resource_not_found`") is unchanged; the UI warns on unhealthy attachments instead.

**Why no create-time probe for oauth (amended 2026-08-31, F10/F11/P1.2).** Consent has not happened at create time, so the only thing that probe could report is the absence of a grant — which the create path already writes as `health: auth_required` without a round trip. Firing it anyway is what made a brand-new install read "http 401" the instant it appeared. Worse, once the post-callback probe carries a token, the create-time probe racing it can land LAST and overwrite a healthy result, leaving a connection that genuinely works showing a 401 forever. Not dialling removes the race by construction, which beats a probe-generation counter: a counter only narrows the window.

**SSRF policy** — this is a genuinely new egress surface (the probe dials user-supplied URLs; the registry proxy never did). One **guarded egress helper** owns every caller-influenced fetch: DNS-resolve, validate *all* resolved IPs against private/loopback/link-local ranges, then **pin the connection to a validated IP** (custom lookup/connect — resolve-validate-then-refetch-by-hostname is a rebinding TOCTOU), re-run validation on every redirect hop with cross-origin redirects refused, HTTPS-only, 10 s timeout, response size caps. Its consumers are the probe **and the entire OAuth broker** — PRM/AS-metadata discovery, DCR registration, token exchange, and refresh all hit attacker-influencible URLs (a malicious MCP server chooses its advertised authorization server, hence its token endpoint). `MCP_PROBE_ALLOW_PRIVATE=1` relaxes both the private-range check and HTTPS-only for dev/e2e/self-hosted stacks whose stubs live on `http://127.0.0.1`.

**Cache consumers**: the tool allow/block picker (checkbox list from `tools_cache`, free-text escape hatch for offline servers), the per-tool approval editor, the connection detail's tool listing, and the copilot inventory (tool names become part of the connection's inventory entry so the copilot can propose real tool filters). Bare-vs-qualified naming is unchanged: UI and DB use bare names; the compiler keeps qualifying `<slug>__<tool>` inside generated approval policies.

## 8. Compiler & eve compat

- `CompilerMcpConnection` gains `authMode: "none"|"bearer"|"headers"|"oauth"`, `connectionId`, `transport`. Codegen for `oauth` emits the broker `getToken` helper (§6); other modes are byte-identical to today. `defineMcpClientConnection`'s four-property surface (`url`, `description`, `auth.getToken`/`headers`, `tools`, `approval`) is untouched — no eve changes needed. Env reads stay inside lazy callbacks (keyless `eve build` invariant).
- **`COMPILER_VERSION` bump** (emitted bytes change) + new golden fixture `oauth-connection/`; `BUILD_ENV_EPOCH` untouched.
- Content-hash invariants preserved: auth *shape* (now including mode + connection id, which the emitted code embeds) is hashed; token/credential *values* still are not — OAuth reconnects and token refreshes never force a republish.
- Transport: install prefers a `streamable-http` remote when a server advertises several. `sse`-only servers are accepted and recorded; a gated spike test verifies eve's client against an SSE-only stub before we advertise support (spike REPORT gets the finding either way).

## 9. Control-plane API surface (delta)

| Route | Change |
|---|---|
| `GET /mcp-registry/search` | now Meilisearch-backed; adds `limit/offset`, `verified` in DTO |
| `GET /mcp-registry/server/:name` | unchanged (live upstream fetch) |
| `POST /workspaces/:id/connections` + `/me/connections` | create: `{source: catalog\|registry\|custom, …}` — replaces today's create/install pair; registry source keeps the live remote-provenance check |
| `PATCH /…/connections/:id` | full edit from anywhere (name, description, url for custom, auth rotate) — un-strands editing from the agent-editor popover |
| `POST /…/connections/:id/oauth/start` | §6 |
| `GET /integrations/mcp-oauth/callback`, `GET /integrations/mcp-oauth/client-metadata.json` | §6, public via existing `integrations` prefix |
| `POST /…/connections/:id/probe` | manual test-connection |
| `POST /internal/connections/token` | agent-facing broker endpoint (existing `/internal/*` namespace; platform-JWT-authed per §6, internal network only; documented in `docs/runtime-worker-contract.md`) |

All workspace routes go through `requireWorkspace` + row-ownership as usual; the authz matrix (outsider 403, member vs admin) extends to the new routes. Workspace-scoped connection mutations stay owner/admin-gated (`canManage`), matching today.

## 10. Web UI

E1 throughout (tokens, capsule controls, designed empty/loading/error states, `focus-visible`, reduced-motion).

- **Add connection** becomes a full-height glass dialog: featured catalog row → category-grouped catalog grid (icon, title, one-liner, auth badge, "Added" state) → a single search field that fuzzy-matches the catalog client-side and queries community search server-side (catalog matches pinned, community results below with `verified` badge) → "Add custom server" entry point (URL + transport + auth form, as today). Replaces `RegistryBrowserModal`.
- **Connect flow**: OAuth catalog/community/custom → popup consent → card polls to `connected` → probe result appears (tool count, health dot). Header/API-key recipes → one-shot secret form (existing pattern).
- **Connection detail** (new surface, Context page): identity (rename/description), endpoint (URL/transport, custom only), auth panel (status, Reconnect, rotate static creds), tool policy (checkbox picker from `tools_cache` + free-text escape), approval editor, health panel (state, last checked, last error, Test connection), danger zone (delete with the existing in-use blocker).
- **Cards** gain: health dot (`ok` green / `auth_*` amber / `unreachable` red per E1 color-as-meaning), auth chip (OAuth-connected shield / Reconnect), tool count.
- **Chat**: the `authorization.required` card (§6). Amber waiting treatment, consent link, expiry countdown; resolves on `authorization.completed`.
- **Agent editor**: `ContextAttachments` keeps attach/detach + inline settings, but the tool filter becomes the picker, and a "Manage" link deep-links to the connection detail instead of duplicating editing.

## 11. Copilot

Unchanged scope: `addContext`/`removeContext` with existing guardrails (enabled-connection check, inventory-scoped ids, @ref-requires-attachment). The inventory gains `health` and cached tool names so proposals can reference real tools. Copilot-driven search/install is a non-goal (§15).

## 12. Error taxonomy (delta)

Typed, following `runtime/errors.ts` conventions: `search_unavailable` (503), `oauth_discovery_failed`, `oauth_registration_failed`, `oauth_state_invalid`, `oauth_exchange_failed`, `oauth_not_connected` (runtime token route), `probe_failed` (carrying the health classification), plus existing `registry_*` errors unchanged. The structured logger (never `console.*`) covers the new hot paths; token values are on the redaction list by key convention.

**Amended 2026-08-31 (F9).** The consent popup cannot throw an API error at anyone — it is a separate window rendering an HTML page — so the callback carries a sanitized `reason` CODE in its `postMessage` (`oauth_state_invalid`, `oauth_exchange_failed`, `not_initiator`, `forbidden`, `unauthenticated`, `encryption_key_missing`, `oauth_internal_error`) and the same code persists as `connection_oauth.last_error_code`. A `POST …/oauth/start` failure never reaches the popup at all and arrives as a normal typed `ApiError` instead. Both feed ONE copy table in the SPA (`OAUTH_FAILURE_COPY`, `apps/web/src/lib/queries/connections.ts`) so the add-connection dialog and the connection detail never disagree about what went wrong; before this they collapsed into a single "Authorization failed", which is the same sentence for "you declined", "this deployment can never register with that provider" and "someone else started this flow". Codes are a routing key, never rendered raw, and never carry a provider message.

## 13. Security summary

- Refresh tokens and client secrets: envelope-encrypted at rest, AAD-bound to owning row + column, never serialized, never in agent env, never logged.
- Access tokens: reach the agent only via the authenticated runtime route, short-lived, cached in-process only.
- Runtime route authz: platform-JWT audience (per-version derived secret) + connection-membership-in-version check.
- OAuth `state`: single-use, TTL'd, server-side bound to connection + user — the user half is `pending_started_by`, checked on the callback (added 2026-08-31, F15: state alone binds a flow to a connection, not to a person, so any workspace admin could otherwise complete somebody else's consent).
- Server-supplied endpoints are never trusted as flow-independent facts: they are scheme-validated at discovery, staged on `pending_flow`, and promoted onto the grant only by a successful exchange, so no failed or abandoned consent can choose where a live refresh token is later replayed (added 2026-08-31 — see §6 "Discovery is flow state").
- Probe/discovery egress: guarded helper (private-range rejection post-DNS-resolution, HTTPS-only, no cross-origin redirects) — the only module allowed to fetch caller-influenced URLs. It is not the only lock on a server-supplied URL: the consent popup is NAVIGATED to the authorization endpoint from a window that inherits the app's origin, which no fetch guard sees, so discovery and the SPA each require `https:` independently.
- Registry search/install egress: still exactly one hardcoded host.
- Catalog: reviewed-in-repo, so a malicious "connector" requires a malicious PR, not a registry submission.
- Leaked-agent-env blast radius grows and is accepted: `PLATFORM_JWT_SECRET` previously only authenticated that version's channel; it now also lets a holder pull live third-party access tokens — still strictly scoped to the connections in that one version's definition (§6).
- The mid-run authorization card renders a server-supplied URL inside trusted chrome; the target host is displayed prominently (§6).

## 14. Testing

| Lane | Coverage |
|---|---|
| Unit (default) | catalog schema validation (every entry parses, slugs unique, icons resolve; every oauth preset declares an executable client-identity strategy, and a registration-gated host may not re-enter as `dynamic`); registry→document mapping incl. installable/latest filtering and id encoding; discovery metadata parsing; PKCE/state helpers; token-refresh margin logic; codegen goldens (new `oauth-connection` fixture, `COMPILER_VERSION` guard); egress-guard unit tests (private-range matrix) |
| DB-gated integration | connections + connection_oauth CRUD & authz matrix; broker flow against an in-process stub authorization server (start→callback→refresh→invalid_grant); runtime token route (strict audience shape incl. rejection of the bare `agent-version` channel audience, membership, single-flight); tailer fixtures for `authorization.required`/`authorization.completed` — latch set/clear, and `session.waiting`-while-latched classifying *waiting*, never *succeeded*; probe against the stub MCP server with `MCP_PROBE_ALLOW_PRIVATE=1`; sync ETL against the stub registry writing to a **real Meilisearch** (suite skips cleanly when `MEILISEARCH_URL` unset, mirroring the DB-gated pattern; CI integration job adds the service) |
| E2E | full journeys: catalog install with OAuth (stub AS auto-approves) → probe → tool picker → attach → publish → chat tool call through the compiled agent — the OAuth fixture demands a bearer on the `initialize`/`tools/list` handshake too (amended 2026-08-31: the stub used to leave the handshake open, so the green badge certified a probe that never read the token); community search (seeded index) → install; custom URL + header auth (existing stub retained); reconnect after simulated revocation. The e2e harness compose gains meilisearch + the stub AS; `stub-mcp.ts` grows a bearer-protected endpoint |
| Catalog preflight (gated, `CATALOG_PREFLIGHT=1`) | every `dynamic` oauth preset walked LIVE: PRM → AS metadata → CIMD or a registration endpoint that accepts this deployment's redirect URI, with the DCR POST shaped like the broker's own (added 2026-08-31, P2.1 — the assertion that would have caught Vercel) |
| Keyed / spike | gated SSE-only-server compat check (§8); gated capture of eve's real behavior when a server rejects the `getToken` credential mid-session — the gate for the §6 mid-run-challenge slice; spike REPORT findings appended for both |

## 15. Non-goals

- Proxying MCP tool traffic through the control plane (token delivery only; eve's client dials servers directly).
- Per-provider manually registered OAuth apps (CIMD/DCR only; the catalog schema may later gain a pinned-client-id field for providers that require preregistration — not present at launch).
- stdio / npm-package servers (remote-only remains the platform contract).
- Copilot-driven connector search/install.
- Conversation search — out of scope as a feature, but it is the declared reason Meilisearch (a stateful service) was chosen over Postgres FTS for a corpus this small: the adoption is deliberately sized so a future conversations index reuses the service.
- Per-member credentials on a workspace-scoped connection (workspace = shared identity; personal scope covers individual identity).

## 16. Ops & documentation obligations (same-commit rule)

- `.env.example`: `MEILISEARCH_URL`, `MEILISEARCH_MASTER_KEY`, `REGISTRY_SYNC_INTERVAL_MS`, `MCP_PROBE_ALLOW_PRIVATE`, `PLATFORM_API_URL` — plus backfill the missing `MCP_REGISTRY_BASE_URL`. **Added 2026-08-31:** `PUBLIC_WEB_URL` (the SPA origin the consent popup posts to; defaults to `PUBLIC_APP_URL`, and the dev bootstrap ships it set to `http://localhost:5173` because the split-origin failure is silent) and the optional `MCP_OAUTH_<PREFIX>_CLIENT_ID` / `_CLIENT_SECRET` / `_ISSUER` family for pre-registered clients (no shipped preset needs one today; prod compose passes neither through to the container yet).
- `docker-compose` dev + prod: meilisearch service (healthcheck, no backup volume commitments); `bun run dev` bootstrap generates the master key.
- `docs/DEPLOY.md`: meilisearch operation (disposable index, resync-on-empty, key handling). `docs/runtime-worker-contract.md`: the `/internal/connections/token` route and its JWT auth model. `AGENTS.md`: this spec joins the living-documents table; the constraints list gains the probe-egress guard and the broker route; the **test-lane table gains the `MEILISEARCH_URL`-gated suite**. `README.md`: connectors surface description. `packages/compiler/README.md`: `oauth` auth mode + version ritual. `e2e/README.md`: new stubs/services. `packages/db/src/schema/product.ts` header comment ("Product rows use uuid PKs") updated for the nanoid tables.
- Known residuals: `mcp_connections` (table + enums + indexes) is dead pending a cleanup pass, joining `agent_sessions.continuation_token`.
- Changeset: one entry, `minor`, naming the shipped workspaces touched (`control-plane`, `web`, `compiler`, `db`, `shared`, `worker` as applicable).

## 17. Rollout order (implementation phases)

1. Schema + shared contracts (tables, enums, DTOs, catalog schema + initial catalog).
2. Meilisearch service + ETL + search route swap (immediate UX win, independently shippable).
3. Probe service + health + tool cache + pickers.
4. OAuth broker (discovery → consent → storage → refresh) + runtime token route + codegen + `authorization.required` chat card.
5. UI overhaul (add dialog, detail page, cards) rides alongside 2–4 per surface.

Each phase lands with its tests and doc updates; the plan document sequences tasks inside phases.
