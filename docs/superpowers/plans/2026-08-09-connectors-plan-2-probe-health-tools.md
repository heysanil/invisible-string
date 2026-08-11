# Connectors Redesign — Plan 2 of 3: Probe, Health, Tool Picker

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give every connection a real health state, a cached tool list, and a test-connection affordance — powered by a control-plane MCP probe behind a hardened egress guard — and turn the blind free-text tool filter into a picker.

**Architecture:** A guarded egress helper (`apps/control-plane/src/net/guarded-fetch.ts`) owns ALL caller-influenced outbound fetches: DNS-resolve, validate every IP, pin the connection to a validated IP (rebinding TOCTOU closed), same-origin-only redirects re-validated per hop, HTTPS-only, timeouts, size caps. A probe service dials a connection with the official `@modelcontextprotocol/sdk` client through that guard, classifies health (spec §7 table), and caches a trimmed `tools/list`. The SPA gets a connection detail surface, health dots, and a checkbox tool picker. Spec: `docs/superpowers/specs/2026-08-09-connectors-redesign-design.md` §7, §9 (probe route), §10 (detail/cards/picker), §11 (copilot tool names). Baseline: Plan 1 landed (`connections` domain, Meilisearch search, add dialog).

**Tech Stack:** as Plan 1, plus `@modelcontextprotocol/sdk` in `apps/control-plane` (pin the exact version `e2e/package.json` already uses — the stub proves it under Bun).

## Global Constraints

Identical to Plan 1's (same repo, same rules — read `docs/superpowers/plans/2026-08-09-connectors-plan-1-foundation-search.md` Global Constraints and AGENTS.md first). Additions:

- The egress guard is the ONLY module allowed to fetch caller-influenced URLs from the control plane; the registry proxy's fixed-host stance and the Meilisearch client are exempt (operator-configured hosts).
- Plaintext credentials decrypted for a probe live in function scope only — never logged, never persisted, never in a DTO.
- `MCP_PROBE_ALLOW_PRIVATE=1` (dev/e2e/self-hosted) relaxes private-range rejection AND HTTPS-only; document it in `.env.example` in the same commit that reads it.
- Post-Plan-1 module facts (use these names): resource fns in `apps/control-plane/src/resources/connections.ts` (`createConnection` at ~line 202, `updateConnection` ~277); DTO mapper `connectionDto` in `resources/common.ts`; crypto helpers in `resources/mcp-crypto.ts` (`connectionAuthAad`, `encryptConnectionAuthConfig`); web hooks in `apps/web/src/lib/queries/connections.ts` (`useConnections`, `useConnection`, `useCreateConnection`, `useUpdateConnection`, `useDeleteConnection`, `useToggleConnection`, `invalidateConnections`); context components in `apps/web/src/components/context/` (`McpConnectionCard`, `McpConnectionsGrid`, `ContextAttachments` — its `ConnectionSettings` popover starts ~line 244 and uses `TagInput` ~line 326); e2e stub `e2e/scripts/stub-mcp.ts` (MCP at `/mcp` + `/mcp-b`, tool `save_note`, call log at `GET /__calls`).

---

### Task 1: Guarded egress helper

**Files:**
- Create: `apps/control-plane/src/net/guarded-fetch.ts`, `apps/control-plane/src/net/guarded-fetch.test.ts`
- Modify: `apps/control-plane/src/runtime/config.ts` (+`mcpProbeAllowPrivate: boolean` from `MCP_PROBE_ALLOW_PRIVATE === "1"`), `.env.example`

**Interfaces:**
- Produces (Tasks 2, and Plan 3's whole OAuth broker):

```ts
export interface GuardedFetchOptions {
  allowPrivate: boolean;      // MCP_PROBE_ALLOW_PRIVATE: also permits http:
  timeoutMs?: number;         // default 10_000
  maxResponseBytes?: number;  // default 5_000_000
  maxRedirects?: number;      // default 3, same-origin only
}
export function createGuardedFetch(opts: GuardedFetchOptions): typeof fetch;
export function isForbiddenIp(ip: string): boolean;  // exported for the test matrix
export class EgressBlockedError extends Error { reason: string }
```

Semantics: `createGuardedFetch` returns a WHATWG-fetch-compatible function. Per request: parse URL (reject non-https unless `allowPrivate`); `dns.promises.lookup(host, {all: true})`; every resolved IP must pass `isForbiddenIp` (unless `allowPrivate`) — forbidden: v4 10/8, 172.16/12, 192.168/16, 127/8, 0/8, 169.254/16, 100.64/10, and v6 `::1`, `fc00::/7`, `fe80::/10`, plus `::ffff:` v4-mapped forms re-checked as v4; then issue the request via `node:https`/`node:http` `request({ host: <validated ip>, servername: <hostname>, headers: { ...init.headers, host: hostname }, ... })` so the socket is **pinned to the validated IP** while TLS still verifies the real hostname. 3xx: only same-origin locations, full guard re-run per hop, `maxRedirects` cap. Response streams through a byte-counting TransformStream (abort past `maxResponseBytes`) into a standard `Response` (streaming preserved — Plan 3's SSE consumers need it; build via `Readable.toWeb(nodeRes)`).

- [ ] **Step 1: Failing tests** — the matrix, no network needed for most:

```ts
import { describe, expect, test } from "bun:test";
import { createGuardedFetch, isForbiddenIp, EgressBlockedError } from "./guarded-fetch";

describe("isForbiddenIp", () => {
  const forbidden = ["10.0.0.1","172.16.0.1","172.31.255.255","192.168.1.1","127.0.0.1","0.0.0.0","169.254.1.1","100.64.0.1","::1","fc00::1","fe80::1","::ffff:10.0.0.1","::ffff:127.0.0.1"];
  const allowed = ["1.1.1.1","8.8.8.8","172.32.0.1","100.128.0.1","2606:4700:4700::1111"];
  for (const ip of forbidden) test(`${ip} forbidden`, () => expect(isForbiddenIp(ip)).toBe(true));
  for (const ip of allowed) test(`${ip} allowed`, () => expect(isForbiddenIp(ip)).toBe(false));
});

describe("createGuardedFetch", () => {
  test("rejects http when private not allowed", async () => {
    const gf = createGuardedFetch({ allowPrivate: false });
    await expect(gf("http://example.com/")).rejects.toThrow(EgressBlockedError);
  });
  test("rejects a hostname resolving to loopback", async () => {
    const gf = createGuardedFetch({ allowPrivate: false });
    await expect(gf("https://localhost/")).rejects.toThrow(EgressBlockedError);
  });
  test("allowPrivate serves a local http server, and caps response size", async () => {
    using srv = Bun.serve({ port: 0, fetch: () => new Response("x".repeat(64)) });
    const gf = createGuardedFetch({ allowPrivate: true, maxResponseBytes: 16 });
    const res = await gf(`http://127.0.0.1:${srv.port}/`);
    await expect(res.text()).rejects.toThrow(/response too large/i);
  });
  test("cross-origin redirect refused", async () => {
    using srv = Bun.serve({ port: 0, fetch: () => new Response(null, { status: 302, headers: { location: "https://evil.example/" } }) });
    const gf = createGuardedFetch({ allowPrivate: true });
    await expect(gf(`http://127.0.0.1:${srv.port}/`)).rejects.toThrow(EgressBlockedError);
  });
});
```

- [ ] **Step 2: Run → FAIL. Implement. Run → PASS** (`bun test apps/control-plane/src/net && bun run typecheck`)
- [ ] **Step 3: Commit** — `feat(control-plane): guarded egress fetch with IP pinning and redirect re-validation`

---

### Task 2: MCP probe client

**Files:**
- Create: `apps/control-plane/src/probe/mcp-probe.ts`, `apps/control-plane/src/probe/mcp-probe.test.ts`
- Modify: `apps/control-plane/package.json` (add `@modelcontextprotocol/sdk` pinned EXACTLY to `e2e/package.json`'s version), `apps/control-plane/src/resources/mcp-crypto.ts` (+`decryptConnectionAuthHeaders`)

**Interfaces:**
- Consumes: Task 1 `createGuardedFetch`; `schema.connections` row shape.
- Produces (Task 3):

```ts
export interface ProbeOutcome {
  health: "ok" | "unreachable" | "auth_required" | "auth_error";
  tools: Array<{ name: string; description: string; params: string[] }> | null; // null unless ok; cap 200, description truncated at 500
  error: string | null; // classification detail for last_error; NEVER contains credential material
}
export function probeMcpServer(input: {
  url: string;
  transport: "streamable-http" | "sse";
  headers: Record<string, string>;   // decrypted static auth, possibly empty
  hasCredentials: boolean;
  fetchImpl: typeof fetch;           // the guarded fetch
  timeoutMs?: number;
}): Promise<ProbeOutcome>;
```

In `mcp-crypto.ts`: `decryptConnectionAuthHeaders(row, masterKey): Record<string, string>` — `bearer` → `{ Authorization: "Bearer <token>" }`, `headers` → as stored, `none`/`oauth` → `{}` (oauth probing arrives in Plan 3).

Mechanics: SDK `Client` + `StreamableHTTPClientTransport` (or `SSEClientTransport` for `sse` rows), passing `{ fetch: fetchImpl, requestInit: { headers } }` in transport options — verify the pinned SDK's transport options carry a custom-fetch field (`grep -rn "fetch" node_modules/@modelcontextprotocol/sdk/dist/esm/client/streamableHttp.d.ts`); if the pin predates it, bump BOTH `e2e` and `apps/control-plane` to the same newer exact version in this commit. `initialize` + `tools/list`, then `close()` in `finally`. Classification: HTTP 401/403 (from transport error) → `auth_required` when `!hasCredentials`, else `auth_error`; `EgressBlockedError`, timeout, DNS, connection, or protocol errors → `unreachable`; success → `ok` + trimmed tools (`params = Object.keys(tool.inputSchema?.properties ?? {})`).

- [ ] **Step 1: Failing gated test** — in-process protocol-correct fixture mirroring `e2e/scripts/stub-mcp.ts`'s pattern (SDK `McpServer` + `StreamableHTTPServerTransport` on `node:http`, port 0), one variant that 401s every request. Cases: ok server → `{health:"ok"}` with `save_note`-style tool trimmed correctly; 401 server without creds → `auth_required`; 401 with `hasCredentials:true` → `auth_error`; closed port → `unreachable`; oversized/hung server → `unreachable` via timeout. All through `createGuardedFetch({allowPrivate:true})`.
- [ ] **Step 2: Run → FAIL. Implement. Run → PASS** (plus `bun test` unit lane still green with no services).
- [ ] **Step 3: Commit** — `feat(control-plane): mcp probe client with health classification and tool trimming`

---

### Task 3: Probe service, route, persistence, create-hook

**Files:**
- Create: `apps/control-plane/src/probe/service.ts`, `apps/control-plane/src/probe/service.test.ts` (DB-gated)
- Modify: `apps/control-plane/src/resources/connections.ts` (fire-and-forget probe after create; export a `probeConnectionRoute` handler), `apps/control-plane/src/resources/plugin.ts` (`POST /workspaces/:workspaceId/connections/:id/probe` + `/me/connections/:id/probe`, same `canManage` gating as other mutations), `apps/control-plane/src/runtime/errors.ts` (`probeFailed` 502 — only for infrastructure failure of the probe itself, not an unhealthy result: an unreachable server is a 200 with `health:"unreachable"`)

**Interfaces:**
- Consumes: Tasks 1–2; `connectionDto`.
- Produces (Tasks 4–5, e2e): `probeAndPersist(deps: ResourceDeps & { probeFetch: typeof fetch }, row): Promise<ConnectionRow>` — runs `probeMcpServer`, writes `health/lastCheckedAt/lastError/toolsCache/toolsCachedAt` (tools written only on `ok`; prior cache KEPT on failure so a blip doesn't wipe the picker), returns the fresh row; probe routes return `{connection: ConnectionDto}` from the updated row. `deps.probeFetch` is constructed once in `index.ts` from config's `mcpProbeAllowPrivate`.

- [ ] **Step 1: Failing DB-gated tests** — with the Task 2 fixture server: probe route persists `ok` + tools; second probe after fixture starts 401ing → `auth_error` (creds present) with tools cache retained; authz matrix on both routes (outsider 403/404, member vs admin per existing matrix idiom); create → row's health transitions from `unknown` without blocking the create response (poll the row).
- [ ] **Step 2: Run → FAIL. Implement. Run → PASS.** After-create hook: `void probeAndPersist(...).catch(logger.warn)` — never awaited, never throws into the request.
- [ ] **Step 3: Commit** — `feat(control-plane): probe service, test-connection route, health persistence`

---

### Task 4: Web — connection detail surface + health on cards

**Files:**
- Create: `apps/web/src/components/context/ConnectionDetail.tsx`, `apps/web/src/components/context/HealthBadge.tsx`
- Modify: `apps/web/src/components/context/{McpConnectionCard,McpConnectionsGrid,ContextHome}.tsx`, `apps/web/src/lib/queries/connections.ts` (+`useProbeConnection(ref)` mutation hook posting to the probe route, invalidating the connection)
- Test: create `apps/web/src/__tests__/connection-detail.test.tsx`; update `mcp-delete-blocker.test.tsx` (delete moves into the detail's danger zone — keep the blocker-dialog assertions)

**Interfaces:**
- Consumes: DTO fields shipped in Plan 1 (`health`, `lastCheckedAt`, `lastError`, `tools`, `authType`, `hasCredentials`), Task 3 route.
- Produces: `ConnectionDetail` opened from a card click (E1 glass slide-over panel, consistent with the app's existing overlay idiom — follow whatever `AddConnectionDialog` uses); `HealthBadge` (dot + label: `ok` `#16a34a`, `auth_required`/`auth_error` `#f59e0b`, `unreachable` `#dc2626`, `unknown` ink-muted) reused by Task 5 and the card.

Detail sections (spec §10): identity (rename/description via `useUpdateConnection`; name-collision 409 surfaced inline); endpoint (URL + transport, editable only when `source === "custom"`); auth panel (authType label, `hasCredentials` shield, rotate = one-shot secret form reusing `CatalogSecretForm`'s pattern → PATCH `auth`); tool policy (Task 5's picker); approval editor (default-decision `Select` from `ContextAttachments`' popover idiom, PLUS per-tool overrides when `tools` is cached — a row per selected tool with its own ask/allow/deny `Select`, emitting the existing `{default, tools?: Record<name, decision>}` `approvalPolicy` shape with bare names); health panel (HealthBadge, relative `lastCheckedAt`, `lastError` when set, **Test connection** button → `useProbeConnection`, disabled while in flight); danger zone (delete + existing in-use blocker dialog). Card: `HealthBadge` dot + tool count chip when `tools` present. **Stale re-probe** (spec §7): on detail open, when `lastCheckedAt` is null or older than 15 minutes, fire `useProbeConnection` automatically once (guard against loops with a per-open ref).

- [ ] **Step 1: Failing component tests** — detail renders every section from a full DTO; Test connection fires exactly one POST and re-renders the returned health; rename 409 shows the inline error and keeps the field editable; auth rotate sends the secret exactly once; delete-in-use still shows the blocker.
- [ ] **Step 2: Implement; `bun test apps/web && bun run typecheck` → PASS.**
- [ ] **Step 3: Visual pass** (`bun run dev`): E1 states, focus order, reduced motion.
- [ ] **Step 4: Commit** — `feat(web): connection detail surface with health, auth rotation, test-connection`

---

### Task 5: Web — tool picker replaces free-text tool filters

**Files:**
- Create: `apps/web/src/components/context/ToolPicker.tsx`
- Modify: `apps/web/src/components/context/ContextAttachments.tsx` (the `ConnectionSettings` popover ~line 244: replace the `TagInput` at ~line 326 with the picker + a "Manage" link that opens Task 4's detail), `ConnectionDetail.tsx` (embed the same picker)
- Test: update `apps/web/src/__tests__/agent-context.test.tsx`; create `tool-picker.test.tsx`

**Interfaces:**
- Consumes: DTO `tools`, `toolAllow`/`toolBlock`, `useUpdateConnection`.
- Produces: `ToolPicker({ connection, onChange })` — mode switch (All tools / Allow list / Block list, mirroring the existing popover's mode semantics), then: when `connection.tools` is non-null → checkbox list (bare names, description as title/tooltip) plus a free-text escape row for names not in the cache; when `tools` is null → the free-text input with an inline hint to run Test connection. Emits the same `toolAllow`/`toolBlock` payloads the API already accepts (bare names — the compiler qualifies internally; never render `slug__tool` here).

- [ ] **Step 1: Failing tests** — checkboxes render from `tools`; checking two + saving PATCHes `toolAllow: [both]`; block mode PATCHes `toolBlock`; null `tools` falls back to free text; free-text escape merges with checked names without duplicates.
- [ ] **Step 2: Implement; run web tests + typecheck → PASS.**
- [ ] **Step 3: Commit** — `feat(web): checkbox tool picker from the cached tool list`

---

### Task 6: Copilot inventory carries tool names + health

**Files:**
- Modify: `apps/control-plane/src/copilot/inventory.ts` (connection entries gain `tools: string[]` (bare names from `toolsCache`, cap 40) and `health`), its prompt-rendering site, and `apps/control-plane/src/copilot/inventory.test.ts` (or the module's existing test home — locate with `grep -rn "inventory" apps/control-plane/src/copilot/*.test.ts`)

**Interfaces:** consumes `toolsCache`; produces richer inventory lines so copilot tool-filter proposals reference real names (spec §11). `validate.ts` untouched.

- [ ] **Step 1: Failing test** — inventory entry for a connection with cached tools lists the names; >40 tools truncates with a count marker; null cache renders no tools clause.
- [ ] **Step 2: Implement; unit + gated copilot tests → PASS.**
- [ ] **Step 3: Commit** — `feat(control-plane): copilot inventory lists cached connection tools and health`

---

### Task 7: E2E — probe/tool-picker journey

**Files:**
- Modify: `e2e/global-setup.ts` or the harness env wiring (control plane under test gets `MCP_PROBE_ALLOW_PRIVATE=1` — the stub is 127.0.0.1), `e2e/specs/add-connection.e2e.ts` (extend) or create `e2e/specs/connection-health.e2e.ts`, `e2e/README.md`

**Journey:** custom-install the stub (`/mcp`) → the after-create probe lands: card shows the green dot and a tool count → open detail → health panel shows `ok` with a recent timestamp → ToolPicker lists `save_note` → allow-list it → Test connection button re-probes successfully → attach to an agent (existing flow still green).

- [ ] **Step 1: Write the spec, run `cd e2e && bunx playwright test --workers=1` → new spec FAILS (env not wired), existing specs PASS.**
- [ ] **Step 2: Wire the env; full e2e run → PASS.**
- [ ] **Step 3: Commit** — `test(e2e): connection health and tool-picker journey`

---

### Task 8: Docs, changeset

**Files:**
- Modify: `AGENTS.md` (constraints: the egress-guard-is-the-only-caller-influenced-fetch rule + `MCP_PROBE_ALLOW_PRIVATE`; architecture line gains probe/health), `README.md` (context surface mentions health + tool picker), `apps/site/src/content/docs/building/context-mcp.mdx` (add one sentence: connections carry a live health state and a discovered tool list used for tool filtering — **this file was Plan 1's missed-doc lesson; do not miss it again**), `docs/PLAN.md` (status line: Plan 2 landed)
- Create: `.changeset/connectors-probe-health.md`:

```md
---
"@invisible-string/control-plane": minor
"@invisible-string/web": minor
---

Add connection health probes, cached tool discovery with a checkbox tool picker, a connection detail surface with test-connection, and a hardened SSRF-guarded egress path for all caller-influenced control-plane fetches.
```

(Name additional workspaces ONLY if the executed tasks actually modified them — verify with `git diff --stat <baseline>..HEAD` per workspace before writing.)

- [ ] **Step 1: Docs edits; cross-check every sentence against the shipped code.**
- [ ] **Step 2: Full verification** — `bun run typecheck && bun test`; gated lane (compose up + migrate + gated env incl. `MCP_PROBE_ALLOW_PRIVATE=1` for the probe suites); `cd e2e && bunx playwright test --workers=1`. All green, tree clean.
- [ ] **Step 3: Commit** — `docs: connectors plan-2 documentation sweep and changeset`
