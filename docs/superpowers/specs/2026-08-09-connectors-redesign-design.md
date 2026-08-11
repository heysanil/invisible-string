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
| `authorization_endpoint` / `token_endpoint` | resolved RFC 8414 metadata |
| `scopes` | jsonb `string[]` granted |
| `client_id` | from CIMD (our hosted URL) or DCR registration |
| `client_secret_encrypted` | nullable (DCR may issue one) |
| `access_token_encrypted` / `access_token_expires_at` | |
| `refresh_token_encrypted` | nullable (some servers issue none) |
| `status` | enum `connection_oauth_status` (`pending`\|`connected`\|`expired`\|`revoked`\|`error`) |
| `pending_state` / `pending_code_verifier_encrypted` / `pending_expires_at` | the in-flight consent (single-use `state`, PKCE verifier, 10 min TTL) — one pending flow per connection; a new start supersedes it. Cleared on callback |
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

- **Inclusion criteria** (documented in the file header): domain-verified publisher namespace or first-party vendor documentation, working `streamable-http` remote, known auth recipe, description written by us. Target ~25–40 entries at launch (Linear, Notion, Sentry, GitHub, Stripe, Cloudflare, Supabase, Figma, Atlassian, Context7, DeepWiki, …); curation is a PR, reviewed like code.
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

**Discovery** (`oauth-discovery` module): given the connection URL — read the `WWW-Authenticate` challenge from a 401, and fetch RFC 9728 protected-resource metadata using the **path-aware well-known variants** the MCP auth spec requires (for a server at `https://host/mcp`, try `/.well-known/oauth-protected-resource/mcp` before the root variant — real servers mount MCP under a path). From the PRM: the canonical `resource` identifier (used for RFC 8707, not assumed equal to the connection URL) and the authorization server issuer → AS metadata via RFC 8414 path-inserted and OIDC discovery variants, in spec order. Discovery results are stored on `connection_oauth`. A server with no OAuth metadata is not an OAuth connection (typed `oauth_discovery_failed` guides the user to header auth instead). All discovery fetches go through the guarded egress helper (§7) — a malicious MCP server controls its advertised authorization servers.

**Client identity**: Client ID Metadata Documents first — our `client_id` is `https://<PUBLIC_URL>/integrations/mcp-oauth/client-metadata.json`, a static document served by the control plane (rides the already-enumerated `integrations` nginx prefix). CIMD requires the AS to fetch that URL, i.e. a publicly reachable HTTPS control plane — dev and non-public self-hosted stacks skip straight to the fallback: Dynamic Client Registration (RFC 7591), the registration record living on the connection's 1:1 `connection_oauth` row (per-connection registration; some ASes rate-limit DCR, so the flow registers once per connection and reuses the record thereafter). No per-provider manual app registration.

**Flow**:

1. `POST /…/connections/:id/oauth/start` → row status `pending`; server builds the authorization URL: PKCE S256, `resource` indicator = the PRM's canonical resource (RFC 8707 — sent on the authorization request **and on every token request**: exchange and refresh), scopes from discovery metadata, `state` = single-use nanoid persisted on the `connection_oauth` row's pending-flow columns (§3) so it survives restarts. Response `{authorizeUrl}`; SPA opens a popup.
2. `GET /integrations/mcp-oauth/callback?code&state` → validate state (single-use), exchange code + verifier at the token endpoint (via the guarded egress helper), envelope-encrypt tokens, status `connected`, then fire an async probe (§7). The callback returns a minimal page that `postMessage`s success/failure with `targetOrigin` pinned to `PUBLIC_URL` (never `*`) and closes; the SPA polls the connection DTO.
3. Errors at any step land in `status: error` with a typed reason surfaced on the connection card.

**Refresh** — central and lazy: every consumer goes through `getAccessToken(connectionId)`, which returns the cached access token unless it expires within a 60 s margin, else refreshes (single-flight via `SELECT … FOR UPDATE` on the `connection_oauth` row; correct even if the control plane ever gains replicas). Refresh failure with `invalid_grant` → status `expired`, health `auth_error`; other failures → status `error`, retry on next demand. No background refresh sweeps — nothing consumes tokens while nothing is running.

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

**Reconnect** = re-run the start flow on the same row (state supersedes previous grants; old tokens are overwritten). **Mutations**: a PATCH that changes `auth_type` away from `oauth` performs best-effort RFC 7009 revocation at the AS, then deletes the `connection_oauth` row; changing a custom connection's URL revokes and resets OAuth to unconnected (issued tokens were bound to the old resource) and requires re-connect; connection delete also revokes best-effort. URL and auth-mode changes alter the content hash, so compiled agents pick them up on the **next publish** — the UI says so inline.

## 7. Tool discovery, validation, health

A control-plane **probe service** using the official `@modelcontextprotocol/sdk` client (streamable-http, SSE fallback per the connection's transport): initialize handshake → `tools/list` → write `tools_cache` (+`tools_cached_at`), set `health`:

| Outcome | health |
|---|---|
| Handshake + list OK | `ok` |
| 401/403, no credentials configured | `auth_required` |
| 401/403 with credentials present | `auth_error` |
| Timeout / network / protocol failure | `unreachable` (+`last_error`) |

**Triggers**: after create/install; after OAuth callback; manual "Test connection"; lazy re-probe when a connection detail is opened and `last_checked_at` is >15 min stale. Probes are never in the publish path — publish behavior (including "disabled connection fails publish with `context_resource_not_found`") is unchanged; the UI warns on unhealthy attachments instead.

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

Typed, following `runtime/errors.ts` conventions: `search_unavailable` (503), `oauth_discovery_failed`, `oauth_state_invalid`, `oauth_exchange_failed`, `oauth_not_connected` (runtime token route), `probe_failed` (carrying the health classification), plus existing `registry_*` errors unchanged. The structured logger (never `console.*`) covers the new hot paths; token values are on the redaction list by key convention.

## 13. Security summary

- Refresh tokens and client secrets: envelope-encrypted at rest, AAD-bound to owning row + column, never serialized, never in agent env, never logged.
- Access tokens: reach the agent only via the authenticated runtime route, short-lived, cached in-process only.
- Runtime route authz: platform-JWT audience (per-version derived secret) + connection-membership-in-version check.
- OAuth `state`: single-use, TTL'd, server-side bound to connection + user.
- Probe/discovery egress: guarded helper (private-range rejection post-DNS-resolution, HTTPS-only, no cross-origin redirects) — the only module allowed to fetch caller-influenced URLs.
- Registry search/install egress: still exactly one hardcoded host.
- Catalog: reviewed-in-repo, so a malicious "connector" requires a malicious PR, not a registry submission.
- Leaked-agent-env blast radius grows and is accepted: `PLATFORM_JWT_SECRET` previously only authenticated that version's channel; it now also lets a holder pull live third-party access tokens — still strictly scoped to the connections in that one version's definition (§6).
- The mid-run authorization card renders a server-supplied URL inside trusted chrome; the target host is displayed prominently (§6).

## 14. Testing

| Lane | Coverage |
|---|---|
| Unit (default) | catalog schema validation (every entry parses, slugs unique, icons resolve); registry→document mapping incl. installable/latest filtering and id encoding; discovery metadata parsing; PKCE/state helpers; token-refresh margin logic; codegen goldens (new `oauth-connection` fixture, `COMPILER_VERSION` guard); egress-guard unit tests (private-range matrix) |
| DB-gated integration | connections + connection_oauth CRUD & authz matrix; broker flow against an in-process stub authorization server (start→callback→refresh→invalid_grant); runtime token route (strict audience shape incl. rejection of the bare `agent-version` channel audience, membership, single-flight); tailer fixtures for `authorization.required`/`authorization.completed` — latch set/clear, and `session.waiting`-while-latched classifying *waiting*, never *succeeded*; probe against the stub MCP server with `MCP_PROBE_ALLOW_PRIVATE=1`; sync ETL against the stub registry writing to a **real Meilisearch** (suite skips cleanly when `MEILISEARCH_URL` unset, mirroring the DB-gated pattern; CI integration job adds the service) |
| E2E | full journeys: catalog install with OAuth (stub AS auto-approves) → probe → tool picker → attach → publish → chat tool call through the compiled agent; community search (seeded index) → install; custom URL + header auth (existing stub retained); reconnect after simulated revocation. The e2e harness compose gains meilisearch + the stub AS; `stub-mcp.ts` grows a bearer-protected endpoint |
| Keyed / spike | gated SSE-only-server compat check (§8); gated capture of eve's real behavior when a server rejects the `getToken` credential mid-session — the gate for the §6 mid-run-challenge slice; spike REPORT findings appended for both |

## 15. Non-goals

- Proxying MCP tool traffic through the control plane (token delivery only; eve's client dials servers directly).
- Per-provider manually registered OAuth apps (CIMD/DCR only; the catalog schema may later gain a pinned-client-id field for providers that require preregistration — not present at launch).
- stdio / npm-package servers (remote-only remains the platform contract).
- Copilot-driven connector search/install.
- Conversation search — out of scope as a feature, but it is the declared reason Meilisearch (a stateful service) was chosen over Postgres FTS for a corpus this small: the adoption is deliberately sized so a future conversations index reuses the service.
- Per-member credentials on a workspace-scoped connection (workspace = shared identity; personal scope covers individual identity).

## 16. Ops & documentation obligations (same-commit rule)

- `.env.example`: `MEILISEARCH_URL`, `MEILISEARCH_MASTER_KEY`, `REGISTRY_SYNC_INTERVAL_MS`, `MCP_PROBE_ALLOW_PRIVATE`, `PLATFORM_API_URL` — plus backfill the missing `MCP_REGISTRY_BASE_URL`.
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
