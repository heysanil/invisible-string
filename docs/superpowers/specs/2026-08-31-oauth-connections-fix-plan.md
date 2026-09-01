# 2026-08-31 — MCP OAuth connections: root causes and fix plan

Status: **landed** — every phase implemented except the two `low` findings
noted in §8, which are recorded as deliberate residuals. Scope: the
`connections` domain's OAuth broker, the health probe, and the catalog's OAuth
presets. No compiler bytes changed, so **no `COMPILER_VERSION` bump** was
required or taken. §8 is the honest ledger of what shipped and what did not;
the sections above it are preserved as written so the diagnosis stays readable
next to the outcome.

Method: three independent reviews (an in-session trace, a Fable subagent, and
Codex `gpt-5.6-sol` at `xhigh`), reconciled and then **verified on the wire**
against the live Vercel and MCP endpoints. Every claim below is labelled
CONFIRMED (traced in code, or reproduced live) or SUSPECTED.

---

## 1. Reported symptoms

1. **"Connected but 401."** Consent completes, the UI shows `oauth connected`,
   then health reports a 401 / auth error.
2. **"Popup then 502."** Some catalog presets — notably Vercel — open the
   consent popup and then fail with a 502.

Both are now root-caused. They are **unrelated bugs** that happen to share a
surface.

---

## 2. Root cause 1 — the health probe never sends the OAuth token

**CONFIRMED** by all three reviews independently.

The broker writes the access token to `connection_oauth.access_token_encrypted`.
Every probe reads credentials from `connections.auth_config_encrypted`, which is
always NULL for an OAuth row. The two never meet.

```
broker.ts:368        callback succeeds → connection_oauth.status = 'connected'   → UI says "Connected"
broker.ts:392        void deps.probeConnection(connection)
index.ts:481         → probeAndPersist(resourceDeps, connection)
probe/service.ts:44  const headers = decryptConnectionAuthHeaders(row, masterKey)
mcp-crypto.ts:76     if (row.authType === "none" || row.authType === "oauth") return {};
mcp-probe.ts:82      → transport dials with headers: {}          → server returns 401
probe/service.ts:51  hasCredentials: … || row.authType === "oauth"   → true
mcp-probe.ts:141     → classified auth_error (not auth_required)
probe/service.ts:56  → persisted to connections.health            → UI says "401"
```

The decisive evidence: `getAccessToken` (`oauth/tokens.ts:80`) — the only
function that decrypts and refreshes an OAuth access token — has exactly **one**
production caller in the repo, `runtime/routes.ts:918` (the agent-facing token
route). The probe and tool-discovery paths never call it.

The DTO faithfully renders two independent columns, which is why the UI
contradicts itself: `oauthStatus` from `connection_oauth.status`, `health` from
`connections.health` (`resources/common.ts:147`).

**The code violates the spec, not the reverse.** The design requires that
"every consumer goes through `getAccessToken(connectionId)`"
(`2026-08-09-connectors-redesign-design.md:145-153`), and lists "after OAuth
callback" as a probe trigger ending in a tool count.

### Consequences beyond the error badge

- `tools_cache` is written only on `ok` (`probe/service.ts:61`), so **no OAuth
  connection ever populates** the tool picker, per-tool approvals, the
  agent-version tool directory, or the copilot inventory.
- It re-asserts continuously: the detail view auto-probes when
  `lastCheckedAt` is >15 min stale (`ConnectionDetail.tsx:93`), and
  "Test connection" does the same (`resources/connections.ts:512`).
- **Five of six OAuth presets are affected.** Linear, Notion, Sentry (CIMD +
  open DCR) and Neon, PayPal (open DCR) all complete consent successfully and
  then hit the token-less probe. (Verified live.)

### Why the tests did not catch it

The tests encode the bug rather than covering it:

- `oauth/broker.test.ts:44-69` — the MCP stub always returns 401, and the
  success-path test asserts only that a probe *fired* (`mcpHits` increased),
  never its outcome or headers. Health after that passing test is `auth_error`.
- `e2e/scripts/stub-mcp.ts:176-207` — documents the accommodation in prose:
  handshake and `tools/list` stay open because "OAuth probes carry no broker
  token — plan-2 probe semantics". The stub is more permissive than any real
  OAuth MCP server.
- `probe/service.test.ts` — has no OAuth case at all.

---

## 3. Root cause 2 — Vercel gates DCR by redirect-URI allowlist

**CONFIRMED by live replay** (reproduced independently twice).

The popup is a red herring: the SPA opens `about:blank` **synchronously** in the
click handler to survive popup blockers (`lib/queries/connections.ts:205`), and
only afterwards awaits `POST /oauth/start`. A start failure therefore always
looks like "popup opened, then error".

Discovery **succeeds** for Vercel. Every hop verified live, no redirects, all
HTTPS:

| Hop | Result |
|---|---|
| `POST https://mcp.vercel.com` | `401` + `WWW-Authenticate … resource_metadata=…` |
| PRM | `authorization_servers: ["https://vercel.com"]`, `scopes_supported: ["openid"]` |
| AS metadata `https://vercel.com/.well-known/oauth-authorization-server` | `200`, `registration_endpoint: https://api.vercel.com/login/oauth/register` |
| `client_id_metadata_document_supported` | **absent** → CIMD skipped (`client-identity.ts:157`) |

So the broker falls through to DCR, and Vercel rejects it:

```
POST https://api.vercel.com/login/oauth/register     ← byte-exact broker body
HTTP/2 400
{"error":"invalid_redirect_uri",
 "error_description":"The provided redirect URIs are not approved for use by this authorization server."}
```

→ `client-identity.ts:249` → `errors.oauthRegistrationFailed("… (HTTP 400: invalid_redirect_uri)")`
→ **502 `oauth_registration_failed`** (`runtime/errors.ts:225`).

This is a **redirect-URI allowlist**, not a malformed-request nit. Vercel's
registration endpoint exists and is reachable; it only accepts redirect URIs
belonging to clients Vercel has approved. No tuning of the DCR body
(`application_type`, auth methods, client name) can pass it.

**Second, independent incompatibility:** Vercel advertises
`"response_modes_supported": ["web_message.opener"]` and does **not** list
`query`. The broker's entire callback design is a redirect carrying `?code=`.
Even with an approved client, Vercel's AS is signalling it expects the
web-message flow. Assume approval alone is insufficient until proven otherwise.

The catalog entry (`connector-catalog.json:112`) therefore promises a flow no
deployment of this broker can complete as coded. `connector-catalog.test.ts:26`
claims live verification in its comment but only asserts that OAuth recipes
equal `{type:"oauth"}`.

### Ruled out

The cross-origin-redirect theory (an initial hypothesis, and Codex's finding
#10) is **not implicated**. `EgressBlockedError` never escapes raw:

- during **start** → caught and typed as `oauth_discovery_failed` /
  `oauth_registration_failed` 502 (`discovery.ts:318`, `client-identity.ts:240`);
- during the **probe** → caught in `probeMcpServer` and classified `unreachable`
  inside a 200 (`mcp-probe.ts:107,147`) — it can never produce `probe_failed`;
- during the **callback** → always rendered as the HTML popup page
  (`integrations/routes.ts:276`).

And no Vercel hop redirects at all. Keep the same-origin redirect policy; it is
a latent interop risk for future providers, not a current defect.

---

## 4. Findings register

Severity is impact on a working product, reconciled across reviews. Where the
reviews disagreed, the adjudication is noted.

| # | Finding | Sev | Status | Evidence |
|---|---|---|---|---|
| F1 | Probe never reads the OAuth token (root cause 1) | **critical** | CONFIRMED ×3 | `probe/service.ts:44`, `mcp-crypto.ts:76` |
| F2 | Vercel DCR redirect-URI allowlist → 502 (root cause 2) | **critical** | CONFIRMED live ×2 | `client-identity.ts:249`, live 400 |
| F3 | Server-supplied endpoints are never scheme-validated; SPA navigates the popup to `authorizationEndpoint` verbatim, enabling a `javascript:` URL from a malicious **custom** MCP server | **high** | CONFIRMED (adjudicated) | `discovery.ts:73` (`z.string().min(1)`), `broker.ts:188`, `lib/queries/connections.ts:286`; `isPublicHttpsUrl` is only ever applied to our own URL at `client-identity.ts:159` |
| F4 | Any transient refresh failure permanently bricks a live grant | **high** | CONFIRMED | `tokens.ts:170` sets `status:"error"`; `tokens.ts:98` then hard-fails every later demand |
| F5 | A failed or declined **re-consent** bricks an already-working grant | **high** | CONFIRMED | `broker.ts:374` sets `status:"error"` unconditionally |
| F6 | Scope selection ignores the `WWW-Authenticate` challenge scope (authoritative per MCP spec) and falls back to **AS-wide** scopes when PRM omits them | **high** | CONFIRMED | `discovery.ts:139` `prm.scopes_supported ?? meta.scopes_supported`; challenge parser drops `scope` at `discovery.ts:255` |
| F7 | `offline_access` never requested → ASes that gate refresh tokens on it issue none → grant dies at first expiry | **medium** | SUSPECTED | `broker.ts:198`; consequence of F6 |
| F8 | Popup `postMessage` targets `publicAppUrl` (the **API** origin) instead of the SPA origin — silently dropped whenever they differ, which is **always in local dev** (`:3000` vs `:5173`) | **medium** | CONFIRMED | `broker.ts:443`, `routes.ts:292`; `.env.example:192` vs `:75` |
| F9 | Callback payload carries no failure `reason`, so the SPA can only show a generic error | **medium** | CONFIRMED | `broker.ts:420` drops `CallbackOutcome.reason` |
| F10 | Pending grants are counted as credentialed, and a create-time probe fires **before** consent → a brand-new OAuth connection immediately reads `auth_error` instead of `auth_required` | **medium** | CONFIRMED | `probe/service.ts:51`, `common.ts:162`, `connections.ts:369` |
| F11 | Create-time and post-callback probes race; once the probe is token-aware the earlier unauthenticated one can land last and overwrite a healthy result | **medium** | SUSPECTED | `connections.ts:369` vs `broker.ts:392`, both write unconditionally at `probe/service.ts:55` |
| F12 | `/oauth/start` never transitions to `pending` and never records an error; discovery/DCR failures leave the row's prior status | **medium** | CONFIRMED | `broker.ts:128,173` |
| F13 | No issuer validation, no callback `iss`, DCR credentials not keyed by issuer → AS mix-up exposure, and breakage on a migrated AS | **medium** | CONFIRMED | `discovery.ts:72` never parses `issuer`; `broker.ts:217`; `client-identity.ts:131` |
| F14 | PRM `resource` accepted unvalidated — never compared to the requested MCP URL | **medium** | CONFIRMED | `discovery.ts:66,111` |
| F15 | Pending state is bound to the connection but **not** the initiating user; any workspace admin can complete another's flow | **medium** | CONFIRMED | `broker.ts:205` uses `userId` for logging only; no column in `product.ts:805` |
| F16 | `updateConnection` resets the grant on URL change but leaves stale `health`/`last_error` | **low** | CONFIRMED | `connections.ts:448` |
| F17 | Refresh holds a `FOR UPDATE` row lock across a network call (deliberate single-flight, but pins a pool connection for up to the 10s egress timeout) | **low** | CONFIRMED | `tokens.ts:87-223` |
| F18 | Same-origin-only redirect policy will break a future AS that redirects its metadata/token endpoints | **low** | SUSPECTED | `guarded-fetch.ts:211`; all six shipped presets verified redirect-free today |

Audited clean, no finding: state single-use claim (`broker.ts:275`), pre-claim
authz (`broker.ts:240`), AAD envelope binding (`client-identity.ts:81`), the
token route's JWT + version-membership check (`runtime/routes.ts:860`), error
scrubbing (`mcp-probe.ts:179`), workspace scoping on connection mutations
(`plugin.ts:189`). No plaintext token reaches a DTO, log, or agent env.

---

## 5. Implementation plan

Ordered so each phase is independently shippable and independently verifiable.

### Phase 0 — Security (small, do first)

**P0.1 — Validate every server-supplied URL before use or navigation.** (F3)

- In `discovery.ts`, parse `authorization_endpoint`, `token_endpoint`,
  `registration_endpoint`, `revocation_endpoint` as URLs and require `https:`
  (permit `http:` only under the existing `MCP_PROBE_ALLOW_PRIVATE` dev switch,
  to match the guarded fetch's own stance). Reject at discovery time with a
  typed `oauth_discovery_failed` reason.
- Defence in depth in the SPA: assert `new URL(authorizeUrl).protocol === "https:"`
  before `popup.location.replace`.

*Migration:* none. *Test:* an AS advertising `javascript:` / `http:` /
`data:` endpoints fails discovery with a typed reason, and the SPA refuses to
navigate.

### Phase 1 — Make OAuth connections work (fixes symptom 1)

**P1.1 — Teach the probe to use the broker token.** (F1, F10)

In `probe/service.ts`, inject the token lifecycle and branch on auth type:

- `authType !== "oauth"` → unchanged.
- `authType === "oauth"`, grant not `connected` → **do not dial**. Persist
  `health: "auth_required"` with no error string. This is the honest state and
  costs no network call.
- grant `connected` → `getAccessToken(deps, connection.id)` and pass
  `Authorization: Bearer <token>`. Keep the token in function scope; it must
  never reach `last_error` (the existing `scrubSecrets` path already covers the
  header values it is given — pass the bearer header through it).
- `getAccessToken` throws `oauth_not_connected` → `auth_required`, not
  `auth_error`. Re-consent is the recovery, and the badge should say so.

Then fix `hasCredentials` in **both** `probe/service.ts:51` and
`common.ts:162`: derive it from the actual grant state, never from
`authType === "oauth"`. The current hardcoding is what disguises "I have no
token" as "your token was rejected" and sends debugging down the wrong path.

**P1.2 — Do not fire the create-time probe for OAuth connections.** (F10, F11)

`connections.ts:369` — skip it when `authType === "oauth"`; the post-callback
probe is the meaningful one. This also removes the race in F11 outright, which
is preferable to adding probe generation counters.

**P1.3 — Replace the tests that enshrine the bug.**

- `e2e/scripts/stub-mcp.ts` — require the bearer token for `initialize` and
  `tools/list` on the OAuth fixture, matching every real server.
- `oauth/broker.test.ts` — assert the persisted **health is `ok`**, that tools
  were cached, and that the captured `Authorization` header equals the
  broker-issued token.
- `probe/service.test.ts` — add OAuth cases: connected/valid → `ok`;
  pending → `auth_required` with no dial; dead grant → `auth_required`.
- Add a regression asserting `decryptConnectionAuthHeaders` is not the sole
  credential source on the OAuth path.

*Migration:* none. *Compiler:* no bump.

### Phase 2 — Decide Vercel (fixes symptom 2)

Vercel cannot work as shipped, and the fix is a product decision, not a code
change. Options:

- **(a) Remove Vercel from the catalog now.** Honest, immediate, unblocks the
  502. Recommended as the interim step.
- **(b) Add a "pre-registered client" auth mode** — operator-supplied
  `client_id`/`client_secret` per catalog entry, skipping DCR. This is the
  general fix for every provider that gates client registration, and Vercel is
  unlikely to be the last.
- **(c) Apply to Vercel for approved-client status.** A business process, not an
  engineering task — and note the `response_modes_supported` problem above may
  mean approval alone is insufficient.

**Recommendation: (a) now, (b) next, (c) in parallel out-of-band.**

**P2.1 — Add a real catalog preflight test.** `connector-catalog.test.ts`
currently claims live verification but asserts only the recipe shape. Make it
verify (in the gated network lane, not the default one) that every
`auth.type === "oauth"` preset advertises either CIMD or an open DCR endpoint
this broker can actually use. That is the guard that would have caught Vercel
before it shipped.

*Migration:* none for (a); additive columns for (b).

### Phase 3 — Make failures recoverable and legible

**P3.1 — Only `invalid_grant` is terminal.** (F4) In `tokens.ts:170`, a
transient `RuntimeApiError` must return the error **without** writing
`status:"error"`, so the next demand retries with the still-valid refresh token.
*Test:* first refresh fails with 503/timeout, second demand succeeds, rotation
persists, and concurrent callers still produce exactly one refresh request.

**P3.2 — A failed re-consent must not destroy a working grant.** (F5) In
`broker.ts:374`, only move to `error` when there was no prior usable grant;
otherwise leave the existing grant intact and report the failure to the popup.

**P3.3 — Fix popup result delivery.** (F8, F9) Introduce a separate SPA-origin
config (default: `publicAppUrl`, preserving single-origin prod) and use it as
`targetOrigin`. Add a sanitized `reason` code to the payload and render it in
`ConnectionDetail`. *Test:* a split-origin case that asserts the message is
actually **received**, not that the DB eventually settles — the current tests
pass through invalidation regardless.

**P3.4 — Implement the documented start state machine.** (F12, F16) Transition
to `pending` when arming a flow, persist a sanitized typed error on every
start/callback failure, and clear stale `health`/`last_error` when a URL change
resets the grant.

*Migration:* additive only if a persistent `oauth_last_error_code` column is
wanted; the popup-side fix needs none.

### Phase 4 — Protocol conformance

**P4.1 — Scopes.** (F6, F7) Parse the Bearer challenge's `scope` and treat it as
authoritative; else PRM scopes; else omit `scope` entirely. **Delete the AS-wide
fallback.** Request `offline_access` when the AS advertises it and a refresh
token is wanted.

**P4.2 — Issuer.** (F13) Parse and validate `issuer`; record the expected issuer
and `authorization_response_iss_parameter_supported` with the pending flow;
validate the callback's `iss` before exchange; key DCR credentials by issuer and
re-register when it changes. Note `discovery.test.ts:235` currently *asserts*
the permissive behaviour and must be updated.

**P4.3 — Resource binding.** (F14) Canonicalize and verify PRM `resource`
identifies the requested MCP endpoint. Handle the trailing slash deliberately —
Vercel's root PRM returns `https://mcp.vercel.com/` while the catalog URL is
`https://mcp.vercel.com`, so a naive string compare would break a correct server.

**P4.4 — Bind state to the initiator.** (F15) Add `pending_started_by`; require
the callback session user to match.

*Migration:* **yes, additive** — `pending_started_by`,
`client_registration_issuer`, expected-issuer/`iss`-capability columns.

---

## 6. Verification

- Phase 1 is proven by an MCP stub that **requires** the bearer token: post-consent
  health must reach `ok` and the tool cache must populate. That single assertion
  is the one the current suite is missing.
- Phase 2 is proven by the catalog preflight test.
- Phases 3–4 are conformance tests against a stub AS (`oauth/stub-as.ts` already
  exists and can be extended).
- Nothing here changes emitted agent bytes, so no `COMPILER_VERSION` bump. A bump
  becomes mandatory only if `codegen/connections.ts` or the emitted
  `platform-token` helper changes.
- Docs to update in the same commit: `AGENTS.md` (probe/OAuth constraint bullets),
  and the connectors design spec's §7 probe-trigger text if Phase 1.2 removes the
  create-time OAuth probe.

---

## 7. Addendum (adversarial review) — discovery is flow state

Two independent reviews of the implemented diff found the same defect, and it
is **CONFIRMED**: reproduced by simulating the old write and watching a live
refresh token arrive at a second authorization server.

`armConsentFlow` persisted discovery (`authorization_server`,
`authorization_endpoint`, `token_endpoint`, `resource`, `revocation_endpoint`,
`scopes`) — and, via `persistRegistration`, the DCR `client_id` /
`client_secret` — onto the `connection_oauth` row at START time,
unconditionally, on a row that may be `connected` with live tokens. P3.2's
rule (F5) then deliberately keeps such a row `connected` through a failed or
abandoned callback, and P3.4's arming skips the `pending` transition for the
same reason. `getAccessToken` refreshes against `row.token_endpoint` with the
stored refresh token and client secret and performs **no issuer binding at
all** — F13's keying protects only the DCR client credentials.

So: a compromised (or merely repointed) MCP server changes its PRM to name
`https://evil-as.example`; an admin clicks Reconnect; discovery overwrites
`token_endpoint`; the admin closes the popup. Sixty seconds before expiry, any
agent tool call or health probe POSTs the ORIGINAL server's refresh token
there. Deleting the connection makes it worse — `revokeBestEffort` posts the
same token to the attacker's revocation endpoint. The abandon-the-popup half
of the window pre-dated the F5/F12 work; broadening the survival rule without
also protecting the endpoint columns is what made every failed re-consent
reach the refresh path.

**Resolution — the endpoints are promoted, never written early.** A start now
stages everything it discovered as one `connection_oauth.pending_flow` jsonb
object (schema type `PendingOauthFlow`; migration `0014`, additive), including
the client identity. The exchange reads its material from there — whole, never
mixed with the live columns — and a SUCCESSFUL exchange promotes it onto the
grant in the same write that stores the tokens. A start that ends in anything
but a successful exchange therefore leaves the grant byte-identical, which is
what makes F5's "changed nothing" literally true of every column the refresh
reads rather than only of the two token columns. Rows armed before the column
existed still exchange against the live columns (a compatibility path that
expires with one `OAUTH_PENDING_TTL_MS`).

No runtime issuer gate was added to `tokens.ts`: under this design any such
check compares two values that now only ever move together, so it would be
tautological. The invariant is instead stated in that module's header and
enforced by broker.test.ts's `a re-consent that never completes cannot repoint
a live grant`, which drives a second stub authorization server and asserts it
receives **zero** token requests when the refresh actually fires.

Accepted cost: two abandoned FIRST consent attempts register two dynamic
clients, since nothing persists the first. "The start route writes no
credential column at all" is a much easier invariant to hold than "writes one
only when there is no grant to lose"; a re-consent of a live grant at the same
issuer still reuses its registration untouched.

---

## 8. What landed (ledger)

Written after implementation. Where the plan and the code diverged, the CODE is
described and the reason stated — this section is the one to trust.

### Per-phase

| Phase | Status | Notes |
|---|---|---|
| **P0.1** scheme validation (F3) | **done** | `discovery.ts` parses `resource_metadata`, PRM `resource`/`authorization_servers[0]`, and the AS's authorization/token/registration/revocation endpoints, requiring `https:` with no embedded credentials and no fragment; `http:` only when the MCP URL itself is `http:` (the `MCP_PROBE_ALLOW_PRIVATE` stance, inherited rather than re-read). Typed reason `insecure_endpoint`. The SPA lock is `isSafeAuthorizeUrl` (https, or http on loopback) before `popup.location.replace`. |
| **P1.1** token-aware probe (F1, F10) | **done** | `probe/service.ts` `classifyConnection` branches on auth type; `getAccessToken` is the only OAuth credential source; `oauth_not_connected` → `auth_required`, `oauth_exchange_failed` → `unreachable`, anything else rethrows as `probe_failed`. `hasCredentials` is derived from the grant in BOTH homes (`probe/service.ts`, `resources/common.ts` `connectionDto`). |
| **P1.2** no create-time probe for oauth (F10, F11) | **done** | `createConnection` stamps `health: "auth_required"` on the row and skips the probe for `authType === "oauth"`. `ConnectionDetail`'s 15-minute stale re-probe skips a grant-less row too (`isProbeable`) — the plan did not name that surface, but it fires the same probe. |
| **P1.3** replace the tests that enshrined the bug | **done** | `e2e/scripts/stub-mcp.ts` now demands the bearer on `initialize`/`tools/list` as well as `tools/call`; broker.test.ts asserts `health === "ok"`, the populated `tools_cache`, and `Bearer <the broker's own access token>` in the captured headers (plus that the fixture really refuses an unauthenticated dial); `probe/service.test.ts` gained the connected / pending / dead-grant / rejected-token / unreachable-AS cases. |
| **P2 (a)** remove Vercel | **done** | Entry deleted from `connector-catalog.json`. |
| **P2 (b)** pre-registered client mode | **done, and unused** | `clientIdentity: "preregistered"` + `clientEnvPrefix` on the catalog recipe, `connection_oauth.client_identity_mode`, `MCP_OAUTH_<PREFIX>_CLIENT_ID`/`_CLIENT_SECRET`/`_ISSUER` parsed at boot (`loadOauthClientRegistrations`), and first place in the identity order. **No shipped preset uses it** — see "not done" below. |
| **P2 (c)** approved-client status with Vercel | **not done** | A business process, out of band. Nothing in the tree depends on it. |
| **P2.1** catalog preflight | **done** | Offline half in the default lane (every oauth preset declares an executable strategy; a `preregistered` one names its config; `REGISTRATION_GATED_HOSTS` blocks `mcp.vercel.com` from re-entering as `dynamic`). Live half gated behind `CATALOG_PREFLIGHT=1`. |
| **P3.1** only `invalid_grant` is terminal (F4) | **done** | `tokens.ts` persists nothing on a transient refresh failure and rethrows typed. |
| **P3.2** a failed re-consent keeps a live grant (F5) | **done** | `status: "error"` only when there was no usable grant (`connected` + a stored access token) to lose. |
| **P3.3** popup delivery + reasons (F8, F9) | **done** | `PUBLIC_WEB_URL` (`publicWebUrlFromEnv`, defaults to `PUBLIC_APP_URL`, boot-fatal if malformed) is the `postMessage` `targetOrigin`; the payload gained a sanitized `reason` code, and both it and the start route's `ApiError` codes feed one SPA copy table (`OAUTH_FAILURE_COPY`). |
| **P3.4** start state machine + stale probe columns (F12, F16) | **done, amended** | Arming transitions to `pending` **except on an already-`connected` grant** — the plan said "transition to `pending`" unconditionally, which would fail every agent tool call and every probe the moment a reconnect popup opened, because `getAccessToken` gates on that value. Failures persist `last_error_code` (a new column; the plan listed it as optional). A grant reset clears `health`/`last_error`/`last_checked_at`, drops `tools_cache` on a URL change, and the mirror case (entering oauth from static auth) clears the same way. |
| **P4.1** scopes (F6, F7) | **done** | Challenge → PRM → nothing; the AS-wide fallback is deleted; `offline_access` is appended only to an already-resolved set and only when the AS advertises it. |
| **P4.2** issuer (F13) | **done** | `issuer` is required and must match the well-known asked for (a mismatch is a MISS, so probing continues); `expected_issuer` + `iss_parameter_supported` ride the flow and gate the callback; DCR credentials are keyed by `client_registration_issuer`, with an unrecorded issuer reused-and-backfilled rather than re-registered. `discovery.test.ts`'s permissive assertion was rewritten. |
| **P4.3** resource binding (F14) | **done** | Same origin + path-ancestry, trailing slashes normalised on both sides, value then used verbatim. |
| **P4.4** bind state to the initiator (F15) | **done** | `pending_started_by` (FK, `SET NULL` on user delete); the callback answers `not_initiator`. |
| **§7 addendum** discovery is flow state | **done** | `connection_oauth.pending_flow` (migration `0014`), promoted onto the grant only by a successful exchange. Guarded by broker.test.ts's "a re-consent that never completes cannot repoint a live grant" and its succeeding twin. |

Migrations: `0013` (client identity mode + registration issuer + initiator +
expected issuer + `iss` capability + `last_error_code`) and `0014`
(`pending_flow`), both additive.

### Not done, deliberately

- **F17** — the refresh still holds its `SELECT … FOR UPDATE` row lock across
  the token-endpoint round trip. It is a correct single-flight and the cost is
  one pinned pool connection for up to the 10 s egress timeout; removing it
  needs a claim column and a retry loop, which is a bigger change than the
  finding's `low` severity earns.
- **F18** — the guarded fetch's same-origin-only redirect policy is unchanged.
  All six shipped presets are redirect-free today (verified live); this is a
  latent interop risk for a future AS, and the fix belongs in
  `net/guarded-fetch.ts`, not in the broker.
- **Vercel stays out of the catalog.** Option (b) exists but ships with no
  preset using it, because nobody holds approved Vercel client credentials —
  and its AS advertises `response_modes_supported: ["web_message.opener"]`
  without `query`, so approval alone may still not be enough for a
  redirect-based callback. Re-adding the entry requires `clientIdentity:
  "preregistered"`, real credentials, and a live `CATALOG_PREFLIGHT=1` run.
- **No `COMPILER_VERSION` bump**, as predicted: `codegen/connections.ts` and
  the emitted `platform-token` helper were untouched.

### Known gaps in the surrounding harness

- **The e2e harness does not set `PUBLIC_WEB_URL`.** `e2e/config.ts`
  `controlPlaneEnv()` leaves it unset, so the callback page posts to the
  control-plane origin (`:4310`) while the SPA under test is served from
  `:5173` — exactly the split-origin case F8 is about. The oauth spec still
  passes because the consent outcome invalidates the connection query either
  way, but it is therefore covering the close-poll fallback rather than the
  fix. Setting `PUBLIC_WEB_URL: PREVIEW_URL` there would make the browser lane
  exercise the real path; `broker.test.ts` asserts the target origin directly
  in the meantime.
- **Prod compose passes no `MCP_OAUTH_*` variable through to the
  control-plane container.** Harmless while no preset is `preregistered`, but
  the first one that is will need those names added to
  `docker-compose.prod*.yml` (and to `docs/DEPLOY.md`'s configuration table)
  before an operator can configure it.
