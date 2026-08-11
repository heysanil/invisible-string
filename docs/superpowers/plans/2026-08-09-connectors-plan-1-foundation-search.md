# Connectors Redesign — Plan 1 of 3: Foundation, Catalog, Search

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the connections domain (new tables, nanoid ids, catalog-as-code) and replace the junk registry passthrough with a curated catalog + Meilisearch-mirrored community search.

**Architecture:** New `connections`/`connection_oauth`/`registry_sync_state` tables replace `mcp_connections` (left dead — additive migrations). A checked-in, zod-validated connector catalog renders with zero network calls. A control-plane ETL (ticker + advisory-lock pattern, like `schedule-ticker.ts`) mirrors the official MCP registry into a **disposable** Meilisearch index; `GET /mcp-registry/search` queries Meilisearch instead of the upstream substring API. Install provenance still live-fetches the official registry (SSRF stance unchanged). Spec: `docs/superpowers/specs/2026-08-09-connectors-redesign-design.md` §1–§5, §9–§11 (static-auth slices). Plan 2 = probe/health/tools. Plan 3 = OAuth broker.

**Tech Stack:** Bun + Elysia (control plane), drizzle + Postgres (`packages/db`), zod contracts (`packages/shared`), Meilisearch (`meilisearch` npm client), React SPA (`apps/web`, E1 design system), Playwright e2e.

## Global Constraints

- Conventional commits; **never mention AI assistance or Claude in any commit message** (AGENTS.md golden rule 1).
- Migrations are **additive only**: `bun run --cwd packages/db generate`; never edit an applied migration; `mcp_connections` is retired dead-in-place, never dropped here.
- Secrets: AES-256-GCM envelope via `packages/shared/src/crypto.ts`; AAD binds table+column+row id; DTOs expose `hasCredentials` only; structured logger, never `console.*`.
- TypeScript strict; contracts live in `packages/shared`; server and web import from shared, never drift.
- Every route resolves workspace scope via `requireWorkspace`/`requireUser` patterns already in `resources/plugin.ts`; test the authz matrix (outsider 403, member vs admin).
- Ids: lowercase-alphanumeric nanoid, 16 chars, 2-letter prefix + underscore (`cn_`, `co_`).
- E1 design system in `apps/web`: tokens from `@invisible-string/design-tokens/tokens.css`, primitives from `src/components/ui`, color only as meaning (`#16a34a` ok / `#f59e0b` waiting / `#dc2626` error).
- Docs move with code **in the same commit** (AGENTS.md same-commit rule): each task below lists its doc touches.
- New env vars are added to `.env.example` with comments in the same commit they are introduced.
- Run from repo root unless stated. Unit lane = `bun test` (must stay green with NO services running — new gated suites skip cleanly when `MEILISEARCH_URL`/`TEST_DATABASE_URL` are unset).
- Gated lane for this plan: `docker compose up -d postgres garage dex meilisearch`, then `DATABASE_URL=postgres://dev:dev@localhost:5432/product bun run --cwd packages/db migrate`, then `TEST_DATABASE_URL=postgres://dev:dev@localhost:5432/product MEILISEARCH_URL=http://localhost:7700 MEILISEARCH_MASTER_KEY=dev-meili-master-key bun test <file>`.

---

### Task 1: Nanoid id helper in `packages/shared`

**Files:**
- Create: `packages/shared/src/id.ts`
- Create: `packages/shared/src/id.test.ts`
- Modify: `packages/shared/src/index.ts` (add `export * from "./id";`)
- Modify: `packages/shared/package.json` (add dependency `"nanoid": "5.1.5"`)

**Interfaces:**
- Consumes: nothing.
- Produces: `newId(prefix: string): string` → `<prefix>_<16 lowercase-alnum chars>`; `ID_ALPHABET` (exported for tests). Used by Tasks 2/5 (`newId("cn")`, `newId("co")`).

- [ ] **Step 1: Add the dependency**

```bash
cd packages/shared && bun add nanoid@5.1.5 && cd ../..
```

- [ ] **Step 2: Write the failing test**

```ts
// packages/shared/src/id.test.ts
import { describe, expect, test } from "bun:test";
import { newId } from "./id";

describe("newId", () => {
  test("shape: prefix underscore + 16 lowercase alphanumerics", () => {
    const id = newId("cn");
    expect(id).toMatch(/^cn_[0-9a-z]{16}$/);
  });

  test("ids are unique across a large batch", () => {
    const ids = new Set(Array.from({ length: 10_000 }, () => newId("cn")));
    expect(ids.size).toBe(10_000);
  });

  test("prefix is used verbatim", () => {
    expect(newId("co").startsWith("co_")).toBe(true);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `bun test packages/shared/src/id.test.ts`
Expected: FAIL — `Cannot find module './id'`

- [ ] **Step 4: Implement**

```ts
// packages/shared/src/id.ts
/**
 * House id convention: `<2-letter-prefix>_<16 lowercase-alnum nanoid>`.
 * 16 chars over a 36-symbol alphabet is the medium-volume tier; new product
 * tables use this instead of uuid PKs (see the connectors redesign spec §3).
 */
import { customAlphabet } from "nanoid";

export const ID_ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

const generate = customAlphabet(ID_ALPHABET, 16);

export function newId(prefix: string): string {
  return `${prefix}_${generate()}`;
}
```

- [ ] **Step 5: Run tests + typecheck, then commit**

Run: `bun test packages/shared/src/id.test.ts && bun run --cwd packages/shared typecheck`
Expected: PASS

```bash
git add packages/shared
git commit -m "feat(shared): nanoid house-convention id helper"
```

---

### Task 2: New DB schema — `connections`, `connection_oauth`, `registry_sync_state`

**Files:**
- Modify: `packages/db/src/schema/product.ts` (new enums + tables; update the header comment "Product rows use uuid PKs" — connectors tables now use prefixed nanoids)
- Create: migration via `bun run --cwd packages/db generate` (never hand-edit)

**Interfaces:**
- Consumes: existing `resourceScope` enum, `organization`/`user` tables, drizzle helpers already imported in `product.ts`.
- Produces: `schema.connections`, `schema.connectionOauth`, `schema.registrySyncState`; enums `connectionSource` (`catalog|registry|custom`), `mcpTransport` (`streamable-http|sse`), `connectionAuthType` (`none|bearer|headers|oauth`), `connectionHealth` (`unknown|ok|unreachable|auth_required|auth_error`), `connectionOauthStatus` (`pending|connected|expired|revoked|error`). Row types via `$inferSelect`. Ids are **app-generated** (`newId` at the resource layer — required anyway because the crypto AAD binds the id before insert; no DB default).

- [ ] **Step 1: Add enums + tables to `product.ts`**

Append in the Enums section:

```ts
/** Where a connection came from (connectors redesign spec §2). */
export const connectionSource = pgEnum("connection_source", [
  "catalog",
  "registry",
  "custom",
]);

/** MCP remote transport, persisted at install (spec §3). */
export const mcpTransport = pgEnum("mcp_transport", ["streamable-http", "sse"]);

/** Connection auth mode. `oauth` rows pair with `connection_oauth`. */
export const connectionAuthType = pgEnum("connection_auth_type", [
  "none",
  "bearer",
  "headers",
  "oauth",
]);

/** Probe-derived health (spec §7). `unknown` until first probe. */
export const connectionHealth = pgEnum("connection_health", [
  "unknown",
  "ok",
  "unreachable",
  "auth_required",
  "auth_error",
]);

/** OAuth grant lifecycle (spec §3). */
export const connectionOauthStatus = pgEnum("connection_oauth_status", [
  "pending",
  "connected",
  "expired",
  "revoked",
  "error",
]);
```

Append in the tables section (mirror `mcpConnections`' owner-CHECK pattern — read the existing `mcp_connections` definition at `product.ts:159-212` and copy its `scope`/owner/check construction exactly):

```ts
/**
 * Connections — the rebuilt MCP connection domain (spec §3). Replaces
 * `mcp_connections`, which is DEAD (kept only because migrations are
 * additive; see AGENTS.md known residuals). Ids are `cn_<nanoid16>`,
 * generated app-side (the auth envelope AAD binds the id pre-insert).
 */
export const connections = pgTable(
  "connections",
  {
    id: text("id").primaryKey(),
    scope: resourceScope("scope").notNull(),
    organizationId: text("organization_id").references(
      () => organization.id,
      { onDelete: "cascade" },
    ),
    userId: text("user_id").references(() => user.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    description: text("description"),
    source: connectionSource("source").notNull(),
    catalogSlug: text("catalog_slug"),
    registryName: text("registry_name"),
    url: text("url").notNull(),
    transport: mcpTransport("transport").notNull().default("streamable-http"),
    authType: connectionAuthType("auth_type").notNull().default("none"),
    authConfigEncrypted: text("auth_config_encrypted"),
    toolAllow: jsonb("tool_allow").$type<string[]>(),
    toolBlock: jsonb("tool_block").$type<string[]>(),
    approvalPolicy: jsonb("approval_policy"),
    enabled: boolean("enabled").notNull().default(true),
    health: connectionHealth("health").notNull().default("unknown"),
    lastCheckedAt: timestamp("last_checked_at", { withTimezone: true }),
    lastError: text("last_error"),
    toolsCache: jsonb("tools_cache").$type<
      Array<{ name: string; description: string; params: string[] }>
    >(),
    toolsCachedAt: timestamp("tools_cached_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow()
      .$onUpdate(() => new Date()),
  },
  (t) => [
    index("connections_organization_id_idx").on(t.organizationId),
    index("connections_user_id_idx").on(t.userId),
    uniqueIndex("connections_org_name_uq")
      .on(t.organizationId, t.name)
      .where(sql`${t.organizationId} IS NOT NULL`),
    uniqueIndex("connections_user_name_uq")
      .on(t.userId, t.name)
      .where(sql`${t.userId} IS NOT NULL`),
    check(
      "connections_scope_owner_check",
      sql`(${t.scope} = 'workspace' AND ${t.organizationId} IS NOT NULL AND ${t.userId} IS NULL)
       OR (${t.scope} = 'user' AND ${t.userId} IS NOT NULL AND ${t.organizationId} IS NULL)`,
    ),
  ],
);

/** 1:1 OAuth grant state for `auth_type = 'oauth'` connections (spec §3/§6). */
export const connectionOauth = pgTable("connection_oauth", {
  id: text("id").primaryKey(),
  connectionId: text("connection_id")
    .notNull()
    .unique()
    .references(() => connections.id, { onDelete: "cascade" }),
  authorizationServer: text("authorization_server"),
  authorizationEndpoint: text("authorization_endpoint"),
  tokenEndpoint: text("token_endpoint"),
  scopes: jsonb("scopes").$type<string[]>(),
  clientId: text("client_id"),
  clientSecretEncrypted: text("client_secret_encrypted"),
  accessTokenEncrypted: text("access_token_encrypted"),
  accessTokenExpiresAt: timestamp("access_token_expires_at", {
    withTimezone: true,
  }),
  refreshTokenEncrypted: text("refresh_token_encrypted"),
  status: connectionOauthStatus("status").notNull().default("pending"),
  pendingState: text("pending_state"),
  pendingCodeVerifierEncrypted: text("pending_code_verifier_encrypted"),
  pendingExpiresAt: timestamp("pending_expires_at", { withTimezone: true }),
  connectedBy: text("connected_by").references(() => user.id, {
    onDelete: "set null",
  }),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow()
    .$onUpdate(() => new Date()),
});

/** Registry→Meilisearch ETL cursor (spec §5). Single row, id = 'official'. */
export const registrySyncState = pgTable("registry_sync_state", {
  id: text("id").primaryKey(),
  lastUpdatedSince: timestamp("last_updated_since", { withTimezone: true }),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
});
```

Also update the file-header comment line `Product rows use uuid PKs (gen_random_uuid()).` to: `Product rows use uuid PKs (gen_random_uuid()); connectors-redesign tables (connections, connection_oauth) use prefixed nanoids (cn_/co_, packages/shared newId).`

- [ ] **Step 2: Generate the migration**

Run: `bun run --cwd packages/db generate`
Expected: a new migration file appears under `packages/db` (drizzle output dir); inspect it — it must be purely additive (CREATE TYPE / CREATE TABLE / CREATE INDEX only, no ALTER/DROP of existing objects).

- [ ] **Step 3: Apply + typecheck**

Run: `docker compose up -d postgres && DATABASE_URL=postgres://dev:dev@localhost:5432/product bun run --cwd packages/db migrate && bun run --cwd packages/db typecheck`
Expected: migration applies cleanly; typecheck passes.

- [ ] **Step 4: Commit**

```bash
git add packages/db
git commit -m "feat(db): connections, connection_oauth, registry_sync_state tables"
```

---

### Task 3: Shared contracts — connection DTOs + AgentDefinition id union

**Files:**
- Modify: `packages/shared/src/api.ts` (new schemas near the existing MCP block, which starts ~line 812)
- Modify: `packages/shared/src/agent-definition.ts:76-97` (id union)
- Test: `packages/shared/src/api.test.ts`, `packages/shared/src/agent-definition.test.ts` (extend both)

**Interfaces:**
- Consumes: existing `resourceScopeSchema`, `mcpAuthWriteSchema` (`{type:"none"} | {type:"bearer",values:{token}} | {type:"headers",values:Record<string,string>}`), `mcpApprovalPolicySchema` — all already in `api.ts`; `registryServerSummarySchema` unchanged.
- Produces (consumed by Tasks 5, 6, 11):
  - `connectionIdSchema` — accepts uuid **or** `/^cn_[0-9a-z]{16}$/` (spec §3 shared-contract ripple).
  - `connectionSourceSchema`, `mcpTransportSchema`, `connectionAuthTypeSchema`, `connectionHealthSchema`, `connectionOauthStatusSchema` — zod enums mirroring Task 2 exactly.
  - `connectionToolSchema = z.object({ name: z.string(), description: z.string(), params: z.array(z.string()) })`.
  - `connectionDtoSchema` and `ConnectionDto`: `{ id, scope, name, description: string|null, source, catalogSlug: string|null, registryName: string|null, url, transport, authType, hasCredentials: boolean, oauthStatus: ConnectionOauthStatus|null, toolAllow: string[]|null, toolBlock: string[]|null, approvalPolicy: McpApprovalPolicy|null, enabled: boolean, health, lastCheckedAt: string|null, lastError: string|null, tools: ConnectionTool[]|null, toolsCachedAt: string|null, createdAt, updatedAt }`.
  - `createConnectionRequestSchema` — discriminated union on `source`:
    - `{source:"catalog", slug: string, auth?: McpAuthWrite}`
    - `{source:"registry", registryName: string, remoteUrl: httpUrl, version?: string, name?: string, description?: string, auth?: McpAuthWrite}`
    - `{source:"custom", name: string, url: httpUrl, transport?: McpTransport, description?: string, auth?: McpAuthWrite}`
  - `updateConnectionRequestSchema` — all-optional `{name, description, url, transport, toolAllow, toolBlock, approvalPolicy, enabled, auth}` (url/transport rejected server-side for non-custom sources — Task 5).
  - `ListConnectionsResponse = { connections: ConnectionDto[] }`, `GetConnectionResponse = { connection: ConnectionDto }`.
  - In `agent-definition.ts`: `agentContextSchema.mcpConnectionIds` accepts the union (uuid for immutable published definitions, `cn_` for new rows), still deduped, still defaulting `[]`.

- [ ] **Step 1: Write failing tests**

Append to `packages/shared/src/agent-definition.test.ts`:

```ts
describe("agentContextSchema mcpConnectionIds id shapes", () => {
  test("accepts historical uuid ids", () => {
    const r = agentContextSchema.safeParse({
      mcpConnectionIds: ["7f6c2d9e-2b7a-4f6e-9c1d-3a5b7c9d1e2f"],
      skillIds: [],
    });
    expect(r.success).toBe(true);
  });
  test("accepts cn_ nanoid ids", () => {
    const r = agentContextSchema.safeParse({
      mcpConnectionIds: ["cn_a1b2c3d4e5f6g7h8"],
      skillIds: [],
    });
    expect(r.success).toBe(true);
  });
  test("rejects other shapes and duplicates", () => {
    expect(
      agentContextSchema.safeParse({ mcpConnectionIds: ["nope"], skillIds: [] })
        .success,
    ).toBe(false);
    expect(
      agentContextSchema.safeParse({
        mcpConnectionIds: ["cn_a1b2c3d4e5f6g7h8", "cn_a1b2c3d4e5f6g7h8"],
        skillIds: [],
      }).success,
    ).toBe(false);
  });
});
```

Append to `packages/shared/src/api.test.ts`:

```ts
describe("connection contracts", () => {
  test("connectionDtoSchema round-trips a full row DTO", () => {
    const dto = {
      id: "cn_a1b2c3d4e5f6g7h8",
      scope: "workspace",
      name: "Linear",
      description: null,
      source: "catalog",
      catalogSlug: "linear",
      registryName: null,
      url: "https://mcp.linear.app/mcp",
      transport: "streamable-http",
      authType: "none",
      hasCredentials: false,
      oauthStatus: null,
      toolAllow: null,
      toolBlock: null,
      approvalPolicy: null,
      enabled: true,
      health: "unknown",
      lastCheckedAt: null,
      lastError: null,
      tools: null,
      toolsCachedAt: null,
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
    };
    expect(connectionDtoSchema.parse(dto)).toEqual(dto);
  });

  test("createConnectionRequestSchema discriminates on source", () => {
    expect(
      createConnectionRequestSchema.safeParse({
        source: "catalog",
        slug: "deepwiki",
      }).success,
    ).toBe(true);
    expect(
      createConnectionRequestSchema.safeParse({
        source: "custom",
        name: "CMS",
        url: "https://cms.example.com/mcp",
      }).success,
    ).toBe(true);
    // registry create without remoteUrl is invalid
    expect(
      createConnectionRequestSchema.safeParse({
        source: "registry",
        registryName: "app.linear/linear",
      }).success,
    ).toBe(false);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/shared/src/agent-definition.test.ts packages/shared/src/api.test.ts`
Expected: FAIL (missing exports / uuid-only rejection of `cn_`).

- [ ] **Step 3: Implement**

In `agent-definition.ts`, replace the `uuidArray` helper usage for connections (keep `skillIds` on uuid):

```ts
/** Historical uuid rows AND connectors-redesign `cn_` nanoid rows (spec §3). */
const connectionIdShape = z.union([z.uuid(), z.string().regex(/^cn_[0-9a-z]{16}$/)]);

const idArray = (shape: z.ZodType<string>, what: string) =>
  z
    .array(shape)
    .superRefine((ids, ctx) => {
      if (new Set(ids).size !== ids.length) {
        ctx.addIssue({ code: "custom", message: `duplicate ${what} ids` });
      }
    })
    .default([]);

export const agentContextSchema = z.object({
  mcpConnectionIds: idArray(connectionIdShape, "MCP connection"),
  skillIds: idArray(z.uuid(), "skill"),
});
```

In `api.ts`, add the schemas from the Interfaces block above, next to the existing MCP block. Enum values must match Task 2 verbatim. Export everything through the package index (check `packages/shared/src/index.ts` re-exports `./api` — it does).

- [ ] **Step 4: Run tests + full typecheck**

Run: `bun test packages/shared && bun run typecheck`
Expected: PASS (typecheck confirms no consumer breaks — none consume the new names yet).

- [ ] **Step 5: Commit**

```bash
git add packages/shared
git commit -m "feat(shared): connection DTOs, create/update contracts, definition id union"
```

---

### Task 4: Connector catalog — schema, seed entries, boot loader

**Files:**
- Create: `packages/shared/src/connector-catalog.ts`
- Create: `packages/shared/src/connector-catalog.json`
- Create: `packages/shared/src/connector-catalog.test.ts`
- Create: `apps/control-plane/src/resources/catalog.ts`
- Create: `apps/control-plane/src/resources/catalog.test.ts`
- Modify: `packages/shared/src/index.ts` (export the module — NOT the raw JSON)

**Interfaces:**
- Consumes: `mcpTransportSchema` (Task 3).
- Produces (consumed by Tasks 5, 11):
  - `connectorCatalogEntrySchema` / `ConnectorCatalogEntry`: `{ slug, title, category, description, modelDescription, url, transport, auth: {type:"none"} | {type:"bearer", tokenLabel: string, tokenHint?: string} | {type:"headers", headers: Array<{name, description, isSecret}>}, registryName?, websiteUrl?, featured?: boolean }`. (No `oauth` recipe in Plan 1 — Plan 3 extends the union; no `icon` field — v1 renders E1 monogram tiles.)
  - `connectorCategorySchema`: `z.enum(["productivity","project-management","dev-tools","data","communication","commerce","other"])`.
  - `connectorCatalogSchema = z.array(connectorCatalogEntrySchema)` + `parseConnectorCatalog(raw: unknown): ConnectorCatalogEntry[]` (throws with slug context; also rejects duplicate slugs and non-https URLs).
  - `apps/control-plane/src/resources/catalog.ts`: `loadConnectorCatalog(): Map<string, ConnectorCatalogEntry>` — imports the JSON, parses at module load (fail-fast at boot), keyed by slug.

- [ ] **Step 1: Write failing tests**

```ts
// packages/shared/src/connector-catalog.test.ts
import { describe, expect, test } from "bun:test";
import raw from "./connector-catalog.json";
import { parseConnectorCatalog } from "./connector-catalog";

describe("connector catalog", () => {
  test("the checked-in catalog parses", () => {
    const entries = parseConnectorCatalog(raw);
    expect(entries.length).toBeGreaterThanOrEqual(4);
  });
  test("slugs are unique, urls https, transports streamable-http", () => {
    const entries = parseConnectorCatalog(raw);
    const slugs = new Set(entries.map((e) => e.slug));
    expect(slugs.size).toBe(entries.length);
    for (const e of entries) {
      expect(e.url.startsWith("https://")).toBe(true);
      expect(e.transport).toBe("streamable-http");
    }
  });
  test("duplicate slugs are rejected", () => {
    const entries = parseConnectorCatalog(raw);
    expect(() => parseConnectorCatalog([...entries, entries[0]])).toThrow(/duplicate/i);
  });
});
```

```ts
// apps/control-plane/src/resources/catalog.test.ts
import { describe, expect, test } from "bun:test";
import { loadConnectorCatalog } from "./catalog";

describe("catalog loader", () => {
  test("loads keyed by slug", () => {
    const catalog = loadConnectorCatalog();
    expect(catalog.get("deepwiki")?.url).toBe("https://mcp.deepwiki.com/mcp");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `bun test packages/shared/src/connector-catalog.test.ts apps/control-plane/src/resources/catalog.test.ts`
Expected: FAIL — modules missing.

- [ ] **Step 3: Implement schema + loader + seed catalog**

`packages/shared/src/connector-catalog.ts`: the zod schemas from the Interfaces block; `parseConnectorCatalog` = `connectorCatalogSchema.parse` + duplicate-slug check + `https://` refine on `url`.

`packages/shared/src/connector-catalog.json` — v1 ships **static-auth entries only** (OAuth-recipe entries arrive with Plan 3, which is how the spec's 25–40-entry target is met). Seed with these four, verified below:

```json
[
  {
    "slug": "deepwiki",
    "title": "DeepWiki",
    "category": "dev-tools",
    "description": "Ask questions about any public GitHub repo.",
    "modelDescription": "DeepWiki: look up documentation and answer questions about public GitHub repositories.",
    "url": "https://mcp.deepwiki.com/mcp",
    "transport": "streamable-http",
    "auth": { "type": "none" },
    "websiteUrl": "https://deepwiki.com",
    "featured": true
  },
  {
    "slug": "context7",
    "title": "Context7",
    "category": "dev-tools",
    "description": "Up-to-date docs for any library or framework.",
    "modelDescription": "Context7: fetch current documentation and code examples for libraries, frameworks, SDKs, and APIs.",
    "url": "https://mcp.context7.com/mcp",
    "transport": "streamable-http",
    "auth": {
      "type": "headers",
      "headers": [
        { "name": "CONTEXT7_API_KEY", "description": "Context7 API key (context7.com/dashboard)", "isSecret": true }
      ]
    },
    "websiteUrl": "https://context7.com",
    "featured": true
  },
  {
    "slug": "hugging-face",
    "title": "Hugging Face",
    "category": "data",
    "description": "Search models, datasets, papers, and Spaces.",
    "modelDescription": "Hugging Face Hub: search and inspect models, datasets, papers, and Spaces.",
    "url": "https://huggingface.co/mcp",
    "transport": "streamable-http",
    "auth": { "type": "bearer", "tokenLabel": "HF access token", "tokenHint": "hf.co/settings/tokens" },
    "websiteUrl": "https://huggingface.co"
  },
  {
    "slug": "stripe",
    "title": "Stripe",
    "category": "commerce",
    "description": "Query and act on your Stripe account.",
    "modelDescription": "Stripe: customers, payments, invoices, subscriptions, and docs search.",
    "url": "https://mcp.stripe.com",
    "transport": "streamable-http",
    "auth": { "type": "bearer", "tokenLabel": "Stripe secret or restricted key", "tokenHint": "dashboard.stripe.com/apikeys" },
    "websiteUrl": "https://stripe.com"
  }
]
```

`apps/control-plane/src/resources/catalog.ts`:

```ts
/** Catalog-as-code (spec §4): validated at module load — a broken catalog
 * fails the control plane at boot, not at first install. */
import rawCatalog from "@invisible-string/shared/connector-catalog.json" with { type: "json" };
import {
  parseConnectorCatalog,
  type ConnectorCatalogEntry,
} from "@invisible-string/shared";

const entries = parseConnectorCatalog(rawCatalog);
const bySlug = new Map(entries.map((e) => [e.slug, e]));

export function loadConnectorCatalog(): Map<string, ConnectorCatalogEntry> {
  return bySlug;
}
```

(If the subpath JSON import fails under the workspace's exports map, add `"./connector-catalog.json": "./src/connector-catalog.json"` to `packages/shared/package.json` `exports` — the SPA imports the same path in Task 11.)

- [ ] **Step 4: Verify each catalog URL is a live MCP endpoint**

Run, for each entry URL:

```bash
for u in https://mcp.deepwiki.com/mcp https://mcp.context7.com/mcp https://huggingface.co/mcp https://mcp.stripe.com; do
  printf "%s → %s\n" "$u" "$(curl -s -o /dev/null -w "%{http_code}" -X POST "$u" -H 'content-type: application/json' -H 'accept: application/json, text/event-stream' --data '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"probe","version":"0.0.0"}}}')"
done
```

Expected: each returns an HTTP status (200/401/4xx — anything but connection failure/404-HTML). **Drop or fix any entry that does not resolve to a real MCP endpoint** — the catalog test suite is the guard for shape, this manual step is the guard for truth. Record the check output in the commit message body.

- [ ] **Step 5: Run tests, commit**

Run: `bun test packages/shared/src/connector-catalog.test.ts apps/control-plane/src/resources/catalog.test.ts && bun run typecheck`
Expected: PASS

```bash
git add packages/shared apps/control-plane/src/resources/catalog.ts apps/control-plane/src/resources/catalog.test.ts
git commit -m "feat(shared,control-plane): connector catalog schema, seed entries, boot loader"
```

---

> **Mid-plan state note (Tasks 5–10):** the server cuts over to the new domain before the SPA does (Task 11) and before e2e catches up (Task 12). Unit/typecheck/DB-gated lanes stay green at every commit; the live connections UI and the e2e suite are transiently broken *on this feature branch only* between Tasks 5 and 12. Do not "fix" this by keeping the old routes alive — split-brain between two connection tables is worse.

### Task 5: Control-plane `connections` resource + routes (replaces `mcp-connections` routes)

**Files:**
- Create: `apps/control-plane/src/resources/connections.ts`
- Modify: `apps/control-plane/src/resources/common.ts` (add `connectionDto` mapper next to `mcpConnectionDto`)
- Modify: `apps/control-plane/src/resources/mcp-crypto.ts` (new AAD helper for the new table)
- Modify: `apps/control-plane/src/resources/plugin.ts:179-262` (replace the `mcp-connections` route block with `/connections` routes)
- Modify: `apps/control-plane/src/runtime/errors.ts` (add `catalogEntryNotFound`, `duplicateConnectionName`, `duplicateConnectionSlug`)
- Modify: `packages/compiler/src/index.ts` (export the existing slugify used for connection filenames — locate with `grep -rn "slugify\|slug(" packages/compiler/src` — so create-time checks use the compiler's exact function)
- Test: extend `apps/control-plane/src/resources/integration.test.ts` (DB-gated)

**Interfaces:**
- Consumes: Task 2 `schema.connections`; Task 3 `createConnectionRequestSchema`/`updateConnectionRequestSchema`/`connectionDtoSchema`; Task 4 `loadConnectorCatalog()`; Task 1 `newId`; existing `deps.registry.getServer` (unchanged live provenance check), `scopeWhere`/`scopeInsertValues`/`parseBody` from `common.ts`, `encryptSecret` plumbing via `mcp-crypto.ts`.
- Produces (consumed by Tasks 6, 11): module functions `listConnections`, `getConnection`, `createConnection`, `updateConnection`, `deleteConnection`, `connectionReferences` (moved here from `mcp-connections.ts`, same SQL — it is id-shape-agnostic); routes `GET|POST /workspaces/:workspaceId/connections`, `GET|PATCH|DELETE /workspaces/:workspaceId/connections/:id`, and the `/me/connections` mirrors; DTO field names exactly as Task 3's `connectionDtoSchema`.

- [ ] **Step 1: Write failing DB-gated tests** (extend `integration.test.ts`, following its existing setup helpers)

Cover, using the new `/connections` routes:
- create `{source:"custom"}` → 200, DTO has `cn_`-prefixed id, `authType:"none"`, `health:"unknown"`; with `auth:{type:"bearer",...}` → `hasCredentials:true`, `authType:"bearer"`.
- create `{source:"catalog", slug:"deepwiki"}` → row seeded from the catalog recipe (url/transport/description from the entry, `catalogSlug:"deepwiki"`); unknown slug → 404 `catalog_entry_not_found`; catalog entry whose recipe demands a secret (`context7`) created without `auth` → 422.
- create `{source:"registry", ...}` with a remoteUrl the (test-injected) registry client does not advertise → 409 `registry_remote_mismatch`; advertised → 200 with `registryName` set.
- duplicate `name` in the same scope → 409 `duplicate_connection_name`; same name in the *other* scope → 200.
- two names that slugify identically ("Notion HQ" vs "notion-hq") → second create 409 `duplicate_connection_slug`.
- PATCH `url` on a `catalog`-source connection → 422; on `custom` → 200.
- authz matrix: outsider 403/404 on every route; member can read, only owner/admin mutate workspace scope (mirror the existing matrix cases verbatim).
- delete blocked while referenced: insert an agent whose `draft.context.mcpConnectionIds` contains the `cn_` id → 409 listing the agent name.

- [ ] **Step 2: Run to verify failure**

Run: `TEST_DATABASE_URL=postgres://dev:dev@localhost:5432/product bun test apps/control-plane/src/resources/integration.test.ts`
Expected: new cases FAIL (routes/modules missing); existing cases still PASS.

- [ ] **Step 3: Implement the resource module**

`mcp-crypto.ts` — add alongside the existing helpers (leave those in place until Task 6 deletes the old module):

```ts
/** AAD for the connectors-redesign table (spec §3). */
export function connectionAuthAad(id: string): string {
  return `connections:auth_config:${id}`;
}

export function encryptConnectionAuthConfig(
  auth: McpAuthWrite,
  masterKey: string,
  connectionId: string,
): string | null {
  if (auth.type === "none") return null;
  return encryptSecret(JSON.stringify(auth), masterKey, connectionAuthAad(connectionId));
}
```

`common.ts` — `connectionDto(row: typeof schema.connections.$inferSelect, oauthStatus: ConnectionOauthStatus | null = null): ConnectionDto` mapping every Task 3 DTO field (`tools: row.toolsCache ?? null`, timestamps `.toISOString()`, `hasCredentials: row.authConfigEncrypted != null || row.authType === "oauth"`).

`connections.ts` — the create path (other functions mirror today's `mcp-connections.ts` shapes against the new table):

```ts
export async function createConnection(
  deps: ResourceDeps,
  scope: Scope,
  body: unknown,
): Promise<GetConnectionResponse> {
  const input = parseBody(createConnectionRequestSchema, body);
  const id = newId("cn");

  let values: typeof schema.connections.$inferInsert;
  if (input.source === "catalog") {
    const entry = loadConnectorCatalog().get(input.slug);
    if (!entry) throw errors.catalogEntryNotFound(input.slug);
    const auth = requireRecipeAuth(entry, input.auth); // 422 unless input.auth satisfies entry.auth
    values = {
      id, ...scopeInsertValues(scope),
      name: entry.title, description: entry.modelDescription,
      source: "catalog", catalogSlug: entry.slug,
      url: entry.url, transport: entry.transport,
      authType: auth.type,
      authConfigEncrypted: encryptConnectionAuthConfig(auth, deps.masterKey, id),
      enabled: true,
    };
  } else if (input.source === "registry") {
    const server = await deps.registry.getServer(input.registryName, input.version);
    if (!server) throw errors.registryServerNotFound(input.registryName);
    if (server.remotes.length === 0) throw errors.registryServerNotInstallable(input.registryName);
    if (!server.remotes.some((r) => r.url === input.remoteUrl)) {
      throw errors.registryRemoteMismatch(input.registryName); // provenance check, verbatim from the old install path
    }
    const remote = server.remotes.find((r) => r.url === input.remoteUrl)!;
    values = {
      id, ...scopeInsertValues(scope),
      name: input.name ?? server.title ?? server.name,
      description: input.description ?? (server.description || null),
      source: "registry", registryName: input.registryName,
      url: input.remoteUrl,
      transport: remote.type === "sse" ? "sse" : "streamable-http",
      authType: input.auth?.type === "bearer" ? "bearer" : input.auth?.type === "headers" ? "headers" : "none",
      authConfigEncrypted: input.auth ? encryptConnectionAuthConfig(input.auth, deps.masterKey, id) : null,
      enabled: true,
    };
  } else {
    values = {
      id, ...scopeInsertValues(scope),
      name: input.name, description: input.description ?? null,
      source: "custom", url: input.url,
      transport: input.transport ?? "streamable-http",
      authType: input.auth?.type === "bearer" ? "bearer" : input.auth?.type === "headers" ? "headers" : "none",
      authConfigEncrypted: input.auth ? encryptConnectionAuthConfig(input.auth, deps.masterKey, id) : null,
      enabled: true,
    };
  }

  await assertNameAndSlugFree(deps.db, scope, values.name); // 409 duplicate_connection_name / duplicate_connection_slug
  const rows = await deps.db.insert(schema.connections).values(values).returning();
  return { connection: connectionDto(rows[0]!) };
}
```

`requireRecipeAuth(entry, auth)` validates the caller's auth against the catalog recipe: recipe `{type:"none"}` → returns `{type:"none"}` (any supplied auth is a 422); recipe `bearer` → requires `auth.type === "bearer"` with a non-empty token; recipe `headers` → requires `auth.type === "headers"` supplying every `isSecret` header the recipe declares — otherwise 422 via `parseBody`-style `errors.validation`.

`assertNameAndSlugFree` selects sibling names in-scope, compares exact name and `slugifyConnectionName(name)` (the compiler export) — 409 on either collision. `updateConnection` re-runs it on rename, rejects `url`/`transport` patches when `source !== "custom"` (422), and keeps the tool-filter-conflict check verbatim from the old module. `deleteConnection` keeps the `connectionReferences` 409 guard.

`plugin.ts`: replace the two `mcp-connections` route groups with `/connections` equivalents (same `requireWorkspace`/`canManage`/user-scope wiring, same handler-per-route shape as `plugin.ts:179-262`; drop the separate `/install` routes — registry install is now `POST /connections` with `source:"registry"`).

- [ ] **Step 4: Run the gated tests + typecheck**

Run: `TEST_DATABASE_URL=postgres://dev:dev@localhost:5432/product bun test apps/control-plane/src/resources/integration.test.ts && bun run typecheck`
Expected: PASS. (Old `mcp-connections.ts` module still exists and typechecks; it dies in Task 6.)

- [ ] **Step 5: Commit**

```bash
git add apps/control-plane packages/compiler/src/index.ts
git commit -m "feat(control-plane): connections resource on the rebuilt schema, unified create routes"
```

---

### Task 6: Rewire every consumer to the new table; delete the old module

**Files:**
- Modify: `apps/control-plane/src/runtime/compile-service.ts:94-129` (`resolveCompileInputs` reads `schema.connections`)
- Modify: `apps/control-plane/src/runtime/agent-env.ts` (decrypt path: new AAD + table; skip `authType === "oauth"` rows with a comment pointing at Plan 3)
- Modify: `apps/control-plane/src/copilot/inventory.ts:134-260` and `apps/control-plane/src/copilot/validate.ts` (inventory + guardrails read `schema.connections`)
- Delete: `apps/control-plane/src/resources/mcp-connections.ts` (its `connectionReferences` moved in Task 5)
- Modify: `apps/control-plane/src/resources/mcp-crypto.ts` + `mcp-crypto.test.ts` (drop the old-table helpers, keep/retest `connectionAuthAad` — including the AAD-relocation-fails case against the new AAD string)
- Modify: any test fixture that inserts `schema.mcpConnections` rows (find them all in Step 1)

**Interfaces:**
- Consumes: Task 5's module; Task 2 schema.
- Produces: the invariant later tasks rely on — **`schema.mcpConnections` has zero runtime consumers**; `resolveCompileInputs` output shape (`CompilerMcpConnection[]`) is byte-identical to before (same slugs, same env-var names), so publishes reproduce existing artifacts.

- [ ] **Step 1: Enumerate every consumer**

Run: `grep -rn "mcpConnections\|mcp_connections" apps packages --include="*.ts" | grep -v "product.ts\|\.test\."`
Expected: a finite list — `compile-service.ts`, `agent-env.ts`, `copilot/inventory.ts`, `copilot/validate.ts`, `resources/mcp-connections.ts`, `resources/common.ts`, `resources/plugin.ts` (imports), plus shared schema names. Convert each; the compile-service resolver keeps its enabled+ownership checks and `context_resource_not_found` behavior exactly (disabling a referenced connection still fails publish — spec §7 keeps this).

- [ ] **Step 2: Convert, delete the old module, drop dead shared schemas**

In `packages/shared/src/api.ts`, delete `createMcpConnectionRequestSchema` / `installMcpConnectionRequestSchema` / `updateMcpConnectionRequestSchema` / `mcpConnectionDtoSchema` and their response aliases (the web still compiles — it is migrated in Task 11; until then it imports only the *new* names added in Task 3 — verify with `grep -rn "McpConnectionDto\|mcp-connections" apps/web/src` and leave the web files untouched until Task 11 if the grep shows usage; in that case defer the shared deletion to Task 11's commit instead — **do not leave both DTO families exported past Task 11 either way**).

In `agent-env.ts`, the decrypt loop keys on `authType`:

```ts
if (row.authType === "oauth") continue; // Plan 3: broker-delivered, never env-injected (spec §6)
```

- [ ] **Step 3: Full verification sweep**

Run: `bun run typecheck && bun test && TEST_DATABASE_URL=postgres://dev:dev@localhost:5432/product bun test apps/control-plane`
Then: `grep -rn "schema.mcpConnections" apps packages --include="*.ts" | grep -v product.ts`
Expected: all green; grep returns nothing.

- [ ] **Step 4: Commit**

```bash
git add -A apps/control-plane packages/shared
git commit -m "integrate: move compile, dispatch env, and copilot onto the connections table"
```

---

### Task 7: Meilisearch service + client module

**Files:**
- Modify: `docker-compose.yml` (dev service), `docker-compose.prod.yml` (prod service + volume + control-plane env)
- Modify: `.env.example` (`MEILISEARCH_URL`, `MEILISEARCH_MASTER_KEY`, `MEILISEARCH_PORT` under port overrides)
- Modify: `scripts/dev.ts` (first-run bootstrap writes the two vars into `.env`, following its existing generated-secret pattern)
- Modify: `apps/control-plane/src/runtime/config.ts` (read the vars), `apps/control-plane/src/index.ts` (construct client at boot, non-fatal)
- Create: `apps/control-plane/src/search/meili.ts`, `apps/control-plane/src/search/meili.test.ts`
- Modify: `apps/control-plane/package.json` (add `"meilisearch"` — pin the current stable 0.x/1.x client exactly, no `^`)
- Modify: `docs/DEPLOY.md` (new service section: disposable index, resync-on-empty, master-key secret, NO backups)

**Interfaces:**
- Consumes: nothing new.
- Produces (Tasks 8–10): `REGISTRY_INDEX = "mcp_registry"`; `createMeiliClient(cfg: {url: string; apiKey: string}): MeiliClient` (the `meilisearch` package's `MeiliSearch` instance, re-exported type); `ensureRegistryIndex(client): Promise<void>` — creates the index (primaryKey `"id"`) and applies settings `{ searchableAttributes: ["title","name","description"], filterableAttributes: ["verified"], rankingRules: ["words","typo","proximity","attribute","sort","exactness","verified:desc"] }`; config fields `meilisearchUrl?: string`, `meilisearchMasterKey?: string` — **absent = search degraded, never fatal** (spec §5 degradation).

- [ ] **Step 1: Compose services**

`docker-compose.yml` (dev — hardcoded throwaway key, same stance as the file header documents):

```yaml
  meilisearch:
    image: getmeili/meilisearch:v1.16   # pin the current stable tag at implementation time; use the SAME tag in docker-compose.prod.yml
    ports:
      - "${MEILISEARCH_PORT:-7700}:7700"
    environment:
      MEILI_MASTER_KEY: dev-meili-master-key
      MEILI_NO_ANALYTICS: "true"
    volumes:
      - meili-data:/meili_data
    healthcheck:
      test: ["CMD-SHELL", "curl -fs http://localhost:7700/health || exit 1"]
      interval: 5s
      timeout: 3s
      retries: 12
```

(add `meili-data:` to the volumes block; mirror into `docker-compose.prod.yml` with `MEILI_MASTER_KEY: ${MEILISEARCH_MASTER_KEY:?}` and `MEILI_ENV: production`, and add `MEILISEARCH_URL: http://meilisearch:7700` + `MEILISEARCH_MASTER_KEY: ${MEILISEARCH_MASTER_KEY:?}` to the control-plane service env. If the meilisearch image lacks curl, use the documented alternative healthcheck from Meilisearch's docs at the pinned version.)

- [ ] **Step 2: Write the gated failing test**

```ts
// apps/control-plane/src/search/meili.test.ts
import { describe, expect, test } from "bun:test";
import { createMeiliClient, ensureRegistryIndex, REGISTRY_INDEX } from "./meili";

const url = process.env.MEILISEARCH_URL;
const key = process.env.MEILISEARCH_MASTER_KEY;

describe.skipIf(!url || !key)("meili registry index", () => {
  test("ensureRegistryIndex is idempotent and applies settings", async () => {
    const client = createMeiliClient({ url: url!, apiKey: key! });
    await ensureRegistryIndex(client);
    await ensureRegistryIndex(client); // second call must not throw
    const settings = await client.index(REGISTRY_INDEX).getSettings();
    expect(settings.filterableAttributes).toContain("verified");
    expect(settings.rankingRules?.at(-1)).toBe("verified:desc");
  });
});
```

Run: `bun test apps/control-plane/src/search/meili.test.ts` → SKIPS (unit lane stays service-free). Then `docker compose up -d meilisearch` and run with `MEILISEARCH_URL=http://localhost:7700 MEILISEARCH_MASTER_KEY=dev-meili-master-key` → FAIL (module missing).

- [ ] **Step 3: Implement `meili.ts`, config, boot wiring**

`meili.ts` wraps the pinned `meilisearch` client; `ensureRegistryIndex` = `createIndex(REGISTRY_INDEX, {primaryKey:"id"})` swallowing the already-exists error, then `updateSettings` with the exact settings object, awaiting task completion (`client.tasks.waitForTask` or the pinned client's equivalent). `index.ts`: when both env vars present → create client, `ensureRegistryIndex` in a `.catch()` that logs a structured warn (`logger`, never `console`).

- [ ] **Step 4: Run gated test + docs**

Gated run → PASS. Write the `docs/DEPLOY.md` section (service, same pinned tag, key from secret manager, **no backup: empty index rebuilds via full resync**, Task 9's job does it automatically).

- [ ] **Step 5: Commit**

```bash
git add docker-compose.yml docker-compose.prod.yml .env.example scripts/dev.ts apps/control-plane docs/DEPLOY.md
git commit -m "feat(control-plane): meilisearch service and registry index client"
```

---

### Task 8: Registry entry → search document mapping

**Files:**
- Create: `apps/control-plane/src/search/registry-docs.ts`
- Create: `apps/control-plane/src/search/registry-docs.test.ts`

**Interfaces:**
- Consumes: `mapRegistryEntry` + the `serverAndMeta`/`officialMeta` helpers from `resources/registry.ts` (export the latter two — they are file-local today).
- Produces (Tasks 9, 10):

```ts
export interface RegistryDocument {
  id: string;            // UNPADDED base64url of server name
  name: string;          // "app.linear/linear"
  title?: string;
  description: string;
  websiteUrl?: string;
  remotes: Array<{ type: string; url: string; headers: unknown[] }>;
  verified: boolean;     // namespace is NOT io.github.* (domain-verified publisher)
  updatedAt?: string;
}
export function registryDocId(name: string): string;
export type SyncAction = { kind: "upsert"; doc: RegistryDocument } | { kind: "delete"; id: string } | { kind: "skip" };
export function syncEntryToAction(entry: Record<string, unknown>): SyncAction;
```

Rules (spec §5): non-latest → `skip`; deleted/inactive status → `delete`; active+latest but zero valid remotes → `delete` (a server that lost its remotes must leave the index); otherwise `upsert` built from the `mapRegistryEntry` trim.

- [ ] **Step 1: Write failing tests**

```ts
// registry-docs.test.ts — build entries inline, mirroring real /v0.1/servers rows
const entry = (over: object, meta: object = {}) => ({
  server: {
    name: "app.linear/linear", description: "Linear MCP", version: "1.0.1",
    remotes: [{ type: "streamable-http", url: "https://mcp.linear.app/mcp" }],
    ...over,
  },
  _meta: { "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true, ...meta } },
});

test("id is unpadded base64url", () => {
  expect(registryDocId("app.linear/linear")).not.toContain("=");
  expect(Buffer.from(registryDocId("app.linear/linear"), "base64url").toString()).toBe("app.linear/linear");
});
test("latest active server with remotes upserts, verified for non-io.github namespaces", () => {
  const a = syncEntryToAction(entry({}));
  expect(a.kind).toBe("upsert");
  if (a.kind === "upsert") expect(a.doc.verified).toBe(true);
});
test("io.github.* namespace is unverified", () => {
  const a = syncEntryToAction(entry({ name: "io.github.someone/fork" }));
  if (a.kind === "upsert") expect(a.doc.verified).toBe(false);
});
test("non-latest skips; deleted deletes; remote-less deletes", () => {
  expect(syncEntryToAction(entry({}, { isLatest: false })).kind).toBe("skip");
  expect(syncEntryToAction(entry({}, { status: "deleted" })).kind).toBe("delete");
  expect(syncEntryToAction(entry({ remotes: [] })).kind).toBe("delete");
});
```

- [ ] **Step 2: Run → FAIL, implement, run → PASS**

`registryDocId` = `Buffer.from(name, "utf8").toString("base64url")` (Bun's `base64url` is unpadded; the test guards it). `verified` = `!doc.name.startsWith("io.github.")`.

- [ ] **Step 3: Commit**

```bash
git add apps/control-plane/src/search apps/control-plane/src/resources/registry.ts
git commit -m "feat(control-plane): registry-to-search-document mapping"
```

---

### Task 9: Registry → Meilisearch sync ETL

**Files:**
- Create: `apps/control-plane/src/search/registry-sync.ts`
- Create: `apps/control-plane/src/search/registry-sync.test.ts` (DB+meili-gated)
- Modify: `apps/control-plane/src/runtime/config.ts` (`REGISTRY_SYNC_INTERVAL_MS`, default `21_600_000`), `apps/control-plane/src/index.ts` (start/stop next to the schedule ticker), `.env.example`
- Docs: `.env.example` comments; AGENTS.md architecture line lands in Task 13

**Interfaces:**
- Consumes: Task 7 client + `ensureRegistryIndex`; Task 8 `syncEntryToAction`; Task 2 `schema.registrySyncState`; the `MCP_REGISTRY_BASE_URL` override (same seam as `registry.ts` — pass the resolved base URL in, default `REGISTRY_HOST`).
- Produces: `createRegistrySync(deps: { db: Db; meili: MeiliClient; registryBaseUrl: string; logger: Logger; intervalMs: number }): RegistrySync` with `{ start(): void; stop(): Promise<void>; runOnce(): Promise<RegistrySyncOutcome> }`; `RegistrySyncOutcome = { ran: boolean; pages: number; upserted: number; deleted: number }` (`ran:false` = lost the advisory lock — normal).

Mechanics (modeled on `schedule-ticker.ts`, spec §5):
1. `runOnce` opens a transaction, takes `SELECT pg_try_advisory_xact_lock(hashtext('registry_sync'))` — `false` → `{ran:false,…}` (another instance is syncing).
2. Read `registry_sync_state` row `'official'` (insert on first run). `syncStartedAt = new Date()` **before** fetching.
3. Page `GET <base>/v0.1/servers?limit=100&version=latest` — plus `&updated_since=<lastUpdatedSince ISO>` when the cursor exists (upstream then includes deleted entries; keep `&include_deleted=true` explicit) — following `metadata.nextCursor` until absent. 10 s timeout per page (`AbortSignal.timeout`), any page failure aborts the run WITHOUT advancing the cursor.
4. Map every entry through `syncEntryToAction`; batch `index.addDocuments(upserts)` / `index.deleteDocuments(ids)`; await task completion.
5. On full success only: upsert state `{ lastUpdatedSince: syncStartedAt, lastSyncedAt: new Date() }` (start-time cursor — entries updated mid-run are re-fetched next run rather than lost).
6. `start()` = immediate `runOnce().catch(log)` then `setInterval`; `stop()` clears and awaits in-flight.

- [ ] **Step 1: Write the gated failing test**

`describe.skipIf(!process.env.TEST_DATABASE_URL || !process.env.MEILISEARCH_URL)`. In-process stub registry via `Bun.serve` on port 0 serving two pages of `/v0.1/servers` fixtures (verified + io.github fork + stdio-only + a deleted entry; `metadata.nextCursor` links page 1→2). Assertions:
- `runOnce()` → `{ran:true, pages:2}`; meili index contains the installable docs only; the deleted entry absent; `registry_sync_state.last_updated_since` set.
- second `runOnce()` receives `updated_since` (assert the stub captured the query param).
- stub returning 500 on page 2 → outcome throws/aborts, cursor NOT advanced, previously indexed docs still present.
- two concurrent `runOnce()` calls → exactly one `ran:true`.

- [ ] **Step 2: Run → FAIL. Implement. Run → PASS**

Gated run per the Global Constraints lane command, plus `bun run typecheck`.

- [ ] **Step 3: Wire into `index.ts` + env docs, commit**

Sync starts only when the meili client exists. `.env.example` gains `REGISTRY_SYNC_INTERVAL_MS` (commented, default noted) and — fixing the pre-existing gap the spec calls out — documents `MCP_REGISTRY_BASE_URL` as the dev/CI-only registry override.

```bash
git add apps/control-plane .env.example
git commit -m "feat(control-plane): official-registry sync job feeding the search index"
```

---

### Task 10: Search route swap — Meilisearch-backed `/mcp-registry/search`

**Files:**
- Create: `apps/control-plane/src/search/registry-search.ts` + `registry-search.test.ts`
- Modify: `apps/control-plane/src/resources/plugin.ts:263-271` (route handler), `apps/control-plane/src/runtime/errors.ts` (`searchUnavailable` → 503 `search_unavailable`)
- Modify: `packages/shared/src/api.ts` (`registrySearchResultSchema`: the community-search DTO `{name, title?, description, verified, remotes}` + `registrySearchResponseSchema = {results, total}`)
- Modify: `apps/control-plane/src/resources/registry.ts` (**delete** the `search()` method + its cache from `RegistryClient` — `getServer` stays, verbatim, for install provenance), `apps/control-plane/src/resources/registry.test.ts` (drop search cases, keep getServer cases)

**Interfaces:**
- Consumes: Task 7 client (`REGISTRY_INDEX`), Task 8 `RegistryDocument`.
- Produces (Task 11): `searchRegistry(meili: MeiliClient | null, q: string, opts: {limit?: number; offset?: number}): Promise<{results: RegistrySearchResult[]; total: number}>` — throws `errors.searchUnavailable()` when `meili` is null or the query fails; route `GET /mcp-registry/search?q=&limit=&offset=` (limit clamp 1–50, default 20) returning the new response DTO. Empty `q` short-circuits to `{results: [], total: 0}` as today.

- [ ] **Step 1: Write failing tests**

`registry-search.test.ts`: gated (`skipIf` no meili) — seed 3 docs via Task 8's mapper (verified "linear", unverified "io.github.x/linear-fork", unrelated "sentry"), then:
- `searchRegistry(client, "linear", {})` returns both linear docs with the **verified one ranked first**, and not sentry;
- typo query `"linaer"` still returns them (typo tolerance — the reason Meilisearch exists);
- `searchRegistry(null, "x", {})` throws `search_unavailable`;
- limit/offset paginate (`limit:1` → `total ≥ 2`, second page differs).
Plus a unit (ungated) route test in the plugin's existing test style asserting the 503 body shape when no client is configured.

- [ ] **Step 2: Run → FAIL, implement, run → PASS**

`searchRegistry` = `client.index(REGISTRY_INDEX).search(q, { limit, offset })` mapped to the DTO (Meilisearch applies `verified:desc` from Task 7's ranking rules; no filter needed — non-installable docs never enter the index). Route swap in `plugin.ts` replaces `deps.registry.search(q)`.

- [ ] **Step 3: Full sweep + commit**

Run: `bun test apps/control-plane && bun run typecheck` (unit lane), then the gated lane for the search tests.

```bash
git add apps/control-plane packages/shared
git commit -m "feat(control-plane): meilisearch-backed community search with typed degradation"
```

---

### Task 11: Web — add-connection dialog v1, hooks on the new API

**Files:**
- Create: `apps/web/src/lib/queries/connections.ts` (list/get/create/update/delete hooks against `/connections`; delete `apps/web/src/lib/queries/mcp-connections.ts`)
- Modify: `apps/web/src/lib/queries/registry.ts` (new response shape `{results, total}`, `search_unavailable` surfaced as a distinct state)
- Create: `apps/web/src/components/context/AddConnectionDialog.tsx` (replaces `RegistryBrowserModal.tsx` — delete it and `RegistryResultCard.tsx`/`InstallServerForm.tsx` after the new dialog covers their tests)
- Create: `apps/web/src/components/context/CatalogTile.tsx`, `apps/web/src/components/context/CatalogSecretForm.tsx`
- Modify: `apps/web/src/components/context/{ContextHome,McpConnectionsGrid,McpConnectionCard,CustomConnectionForm,ContextAttachments}.tsx` (new DTO field names: `authType`, `health`, `registryName`; grid/card otherwise unchanged this plan)
- Test: rewrite `apps/web/src/__tests__/registry-browser.test.tsx` as `add-connection-dialog.test.tsx`; update `mcp-delete-blocker.test.tsx`, `agent-context.test.tsx` fixtures to `cn_` ids + new DTO

**Interfaces:**
- Consumes: Task 3 DTOs (import from `@invisible-string/shared`), Task 4 catalog (`import raw from "@invisible-string/shared/connector-catalog.json"` + `parseConnectorCatalog` at module scope), Task 5 routes, Task 10 search DTO.
- Produces: the user-facing add flow. E1 throughout (capsule controls, designed empty/loading/error states, `focus-visible`, `prefers-reduced-motion`).

Dialog structure (spec §10, v1 scope — no OAuth lane, no health dot yet):
1. **Catalog lane (default):** featured row, then category-grouped grid of `CatalogTile`s — E1 monogram tile (first letter of `title` on an ink-scale capsule; no brand assets in v1), title, one-line `description`, auth badge ("API key" / "No auth"), and an "Added" state when a connection with that `catalogSlug` already exists in the current scope. Click → `{type:"none"}` installs immediately; secret recipes open `CatalogSecretForm` (password inputs from the recipe's `headers`/`tokenLabel`, one-shot submit — reuse the existing send-secret-exactly-once pattern from the old `InstallServerForm` test).
2. **Search field (single, top):** client-side fuzzy match over catalog titles/slugs (simple `includes` on lowercased title/slug is fine at ≤40 entries) pinned above server results from `useRegistrySearch(q)` (250 ms debounce, `keepPreviousData` — both preserved from the old hook). Community results show `verified` as a badge; every result is installable by construction (index ingests installable-only). Install → `POST /connections {source:"registry", registryName, remoteUrl, auth?}` with the header-declaration secret form when the chosen remote declares headers. `search_unavailable` renders an inline degraded state under the pinned catalog matches — catalog stays fully usable (spec §5 degradation).
3. **"Add custom server" entry point:** existing `CustomConnectionForm`, now submitting `{source:"custom", …, transport}`.

- [ ] **Step 1: Rewrite the dialog test first** (`add-connection-dialog.test.tsx`, same harness style as the old `registry-browser.test.tsx`): catalog tile renders + no-auth install fires exactly one POST with `{source:"catalog", slug}`; secret recipe validates before any request and sends the secret exactly once; community search result installs via `{source:"registry"}`; `search_unavailable` shows the degraded state while catalog tiles stay interactive; custom form still validates against the shared schema. Run → FAIL.

- [ ] **Step 2: Implement hooks + components; delete the superseded ones.** Run: `bun test apps/web && bun run typecheck` → PASS.

- [ ] **Step 3: Visual pass** — `bun run dev`, open the Context page: verify E1 states (empty/loading/error), keyboard flow, reduced-motion. Fix regressions.

- [ ] **Step 4: Commit**

```bash
git add -A apps/web packages/shared
git commit -m "feat(web): add-connection dialog with curated catalog and community search"
```

---

### Task 12: E2E — meilisearch in the harness, journeys on the new flow

**Files:**
- Modify: `e2e/global-setup.ts` / `e2e/global-teardown.ts` / `e2e/config.ts` (meilisearch container in the harness stack — mind the AGENTS.md port-collision rules: pick a fixed non-default host port below the ephemeral range, e.g. 7710, distinct from other harness projects), `e2e/scripts/stub-mcp.ts` (its registry REST fixtures gain `_meta.isLatest/status` so the sync ingests them), `e2e/README.md`
- Modify: `e2e/specs/*.e2e.ts` that exercised the old registry browser
- Create: `e2e/specs/add-connection.e2e.ts`

**Interfaces:**
- Consumes: everything prior; `MCP_REGISTRY_BASE_URL` pointed at the stub, `MEILISEARCH_URL`/`MEILISEARCH_MASTER_KEY` pointed at the harness container, `REGISTRY_SYNC_INTERVAL_MS` low (5000) so global-setup can await the first sync.
- Produces: green e2e lane — the branch-wide broken window from Task 5's note closes here.

- [ ] **Step 1: Harness** — add the container (same pinned tag as Task 7), env-wire the control plane under test, and in global-setup wait until `GET /mcp-registry/search?q=<stub-server-name>` returns the stub server (sync completed) before specs run.

- [ ] **Step 2: Journeys** in `add-connection.e2e.ts`:
- community search → type the stub server's title → verified badge visible → install with its declared secret header → connection card appears → attach to an agent → publish → chat message that triggers the stub tool → reply arrives (the full spine, proving compile/dispatch still work on `cn_` ids end-to-end);
- custom URL → the stub's `/mcp-b` path (kept distinct so eve doesn't dedupe — preserve the existing stub comment's reasoning) → card appears;
- catalog lane renders the seeded entries; degraded state: stop the meili container mid-suite? — no: assert the degraded state via a spec that queries with the control plane booted **without** `MEILISEARCH_URL` only if the harness makes that cheap; otherwise leave degradation to Task 10's unit test and skip it here.

- [ ] **Step 3: Run** — `cd e2e && bunx playwright test` (respect the AGENTS.md e2e memory: `--workers=1`, don't pipe through `tail`). Expected: PASS.

- [ ] **Step 4: Commit**

```bash
git add e2e
git commit -m "test(e2e): add-connection journeys over catalog and mirrored search"
```

---

### Task 13: Docs sweep, residuals, changeset

**Files:**
- Modify: `AGENTS.md` — living-documents table (+ this plan's spec row), architecture paragraph (registry sync + meilisearch + catalog line), constraints list (disposable-index stance; `mcp_connections` note), **test-lane table row** for the meili-gated suites, known-residuals entry: `mcp_connections` (table, `mcp_source` enum, indexes) is dead pending a cleanup pass, joining `agent_sessions.continuation_token`
- Modify: `README.md` (connectors surface: catalog / community search / custom), `docs/PLAN.md` (one status line: connectors redesign Plan 1 landed, Plans 2–3 pending)
- Create: `.changeset/connectors-foundation-search.md`
- Verify: `.env.example` already carries every var introduced (Tasks 7, 9) — re-read it against `grep -rn "process.env.MEILI\|REGISTRY_SYNC\|MCP_REGISTRY_BASE_URL" apps/control-plane/src scripts`

**Interfaces:** none — this task exists because AGENTS.md treats stale docs as bugs.

- [ ] **Step 1: Write the changeset** (summary is ONE line; bold scope label derives from the package list — name only shipped workspaces):

```md
---
"@invisible-string/control-plane": minor
"@invisible-string/db": minor
"@invisible-string/shared": minor
"@invisible-string/web": minor
"@invisible-string/compiler": patch
---

**Breaking:** Rebuild the connections domain on new `connections` tables with a curated connector catalog, Meilisearch-mirrored community registry search, and unified create routes replacing the registry install flow.
```

(`compiler` is `patch`: it only gained an export, emitted bytes unchanged — no `COMPILER_VERSION` bump in this plan. **Never `git clean -fd .changeset`.**)

- [ ] **Step 2: Docs edits per the file list.** Cross-check every claim against the code you just wrote — a doc that lies is worse than no doc.

- [ ] **Step 3: Full verification** — `bun run typecheck && bun test`, gated lane, `cd e2e && bunx playwright test`. All green.

- [ ] **Step 4: Commit**

```bash
git add AGENTS.md README.md docs/PLAN.md .changeset .env.example
git commit -m "docs: connectors plan-1 documentation sweep and changeset"
```

---

## Out of scope for Plan 1 (tracked by the spec)

- **Plan 2:** guarded egress helper (SSRF/IP-pinning), probe service, health states + dot, `tools_cache` population, tool allow/block picker, connection detail page, `POST /…/connections/:id/probe`.
- **Plan 3:** OAuth broker end-to-end (discovery, CIMD/DCR, consent, refresh, `/internal/connections/token`, `PLATFORM_API_URL`, codegen `oauth` mode + `COMPILER_VERSION` bump, spike-gated `authorization.required` handling + tailer latch, OAuth catalog entries, OAuth e2e). Until Plan 3, `auth_type = 'oauth'` is unreachable via the API (create restricted to none/bearer/headers) — the schema and DTO fields ship now so contracts don't churn twice.
