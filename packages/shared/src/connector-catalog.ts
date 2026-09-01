/**
 * Connector catalog contract (connectors redesign spec §4) — the zod shape of
 * the checked-in, curated catalog (`connector-catalog.json`). Catalog-as-code:
 * the control plane parses the JSON at module load (fail-fast at boot), the
 * SPA renders the same entries with zero network calls.
 *
 * Auth recipes cover static credentials (`none`/`bearer`/`headers`) and
 * broker-mediated OAuth (`oauth` — the consent flow supplies the grant,
 * connectors spec §6). No `icon` field — v1 renders E1 monogram tiles.
 *
 * ## OAuth client identity (2026-08-31 OAuth fix plan §3 / P2)
 *
 * An `oauth` recipe also declares HOW the broker is to obtain its OAuth CLIENT
 * identity, because that is a property of the provider, not of the runtime:
 *
 * - `dynamic` — the default, and exactly what a bare `{"type":"oauth"}` still
 *   means. The broker works it out per deployment: CIMD when the authorization
 *   server advertises `client_id_metadata_document_supported`, else RFC 7591
 *   dynamic client registration against the discovered `registration_endpoint`.
 *   Executable only against an AS whose registration is genuinely OPEN.
 * - `preregistered` — the AS gates client registration (typically a
 *   redirect-URI allowlist), so no DCR body can ever be accepted and CIMD is
 *   not on offer. The client_id (and optional secret) come from OPERATOR
 *   CONFIGURATION, named by `clientEnvPrefix` via `preregisteredClientEnvVars`:
 *   `MCP_OAUTH_<PREFIX>_CLIENT_ID` / `MCP_OAUTH_<PREFIX>_CLIENT_SECRET`.
 *   Nothing else about the consent flow changes — only where the identity
 *   comes from.
 *
 * These two values COLLAPSE the three the database records
 * (`connection_oauth.client_identity_mode` = `cimd` | `dcr` | `preregistered`):
 * `dynamic` covers `cimd` ∪ `dcr`, because which of the two applies is a
 * runtime fact about the AS metadata and unknowable when the entry is authored.
 * The catalog states the strategy; the row records the outcome.
 *
 * Why the field exists: Vercel (`https://mcp.vercel.com`) shipped as a bare
 * `oauth` preset and could never work. Its AS omits CIMD support, so the broker
 * falls through to DCR, and `https://api.vercel.com/login/oauth/register`
 * answers `400 invalid_redirect_uri` to every client Vercel has not approved —
 * surfacing as a 502 `oauth_registration_failed` behind an already-open consent
 * popup (fix plan F2, reproduced live). The entry was REMOVED; re-adding it
 * needs `clientIdentity: "preregistered"` plus real approved credentials, and
 * note Vercel additionally advertises `response_modes_supported:
 * ["web_message.opener"]` without `query`, which this broker's redirect-based
 * callback does not speak. `connector-catalog.test.ts` now preflights every
 * oauth preset rather than asserting the recipe's shape.
 */
import { z } from "zod";
import { mcpTransportSchema } from "./api";

/** Curated browse categories (spec §4). */
export const connectorCategorySchema = z.enum([
  "productivity",
  "project-management",
  "dev-tools",
  "data",
  "communication",
  "commerce",
  "other",
]);
export type ConnectorCategory = z.infer<typeof connectorCategorySchema>;

const httpsUrlSchema = z
  .url()
  .refine((value) => value.startsWith("https://"), {
    message: "must be an https URL",
  });

/**
 * How the broker is to obtain its OAuth client identity for a preset — see the
 * module doc. Widening this enum means teaching the broker a new strategy;
 * the catalog preflight fails on any value it cannot execute.
 */
export const connectorOauthClientIdentitySchema = z.enum([
  "dynamic",
  "preregistered",
]);
export type ConnectorOauthClientIdentity = z.infer<
  typeof connectorOauthClientIdentitySchema
>;

/**
 * The operator-configuration contract for a `preregistered` client, derived
 * from the catalog-authored prefix so the catalog, the broker, and
 * `.env.example` cannot disagree about the spelling. The secret is optional —
 * a public client registered by hand still has none.
 */
export function preregisteredClientEnvVars(prefix: string): {
  clientId: string;
  clientSecret: string;
} {
  return {
    clientId: `MCP_OAUTH_${prefix}_CLIENT_ID`,
    clientSecret: `MCP_OAUTH_${prefix}_CLIENT_SECRET`,
  };
}

/**
 * Auth recipe: what the install form must collect. `bearer` labels the single
 * token field; `headers` enumerates every header (secret headers are required
 * at install — the create route 422s without them); `oauth` collects nothing
 * from the user — install yields a pending grant and the UI chains into the
 * consent popup — but it does declare where the broker's own client identity
 * comes from.
 */
export const connectorAuthRecipeSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("none") }),
  z
    .strictObject({
      type: z.literal("oauth"),
      /** Omitted = `dynamic`; a bare `{"type":"oauth"}` stays legal. */
      clientIdentity: connectorOauthClientIdentitySchema.optional(),
      /**
       * UPPER_SNAKE token naming the operator-supplied credentials. Required
       * for `preregistered` and forbidden otherwise: a preregistered recipe
       * with no home for its credentials cannot be executed, and a prefix on a
       * dynamic one promises config nothing ever reads.
       */
      clientEnvPrefix: z
        .string()
        .regex(/^[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)*$/, "UPPER_SNAKE env prefix")
        .optional(),
    })
    .refine(
      (recipe) =>
        (recipe.clientIdentity === "preregistered") ===
        (recipe.clientEnvPrefix !== undefined),
      {
        message:
          'clientEnvPrefix is required when clientIdentity is "preregistered", and not allowed otherwise',
        path: ["clientEnvPrefix"],
      },
    ),
  z.strictObject({
    type: z.literal("bearer"),
    tokenLabel: z.string().min(1),
    tokenHint: z.string().min(1).optional(),
  }),
  z.strictObject({
    type: z.literal("headers"),
    headers: z
      .array(
        z.strictObject({
          name: z.string().min(1),
          description: z.string().min(1),
          isSecret: z.boolean(),
        }),
      )
      .min(1),
  }),
]);
export type ConnectorAuthRecipe = z.infer<typeof connectorAuthRecipeSchema>;

/**
 * The client-identity strategy a recipe relies on — `null` for the non-OAuth
 * recipes. Single-sources the `dynamic` default so no consumer has to spell
 * `?? "dynamic"` (and get it wrong) on its own.
 */
export function connectorOauthClientIdentity(
  recipe: ConnectorAuthRecipe,
): ConnectorOauthClientIdentity | null {
  return recipe.type === "oauth" ? (recipe.clientIdentity ?? "dynamic") : null;
}

/** One curated connector. Strict: a typo in the JSON fails the parse. */
export const connectorCatalogEntrySchema = z.strictObject({
  /** Stable install key, persisted on `connections.catalog_slug`. */
  slug: z
    .string()
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, "lowercase-kebab slug"),
  title: z.string().min(1),
  category: connectorCategorySchema,
  /** Human-facing card copy. */
  description: z.string().min(1),
  /** Model-facing summary — becomes the connection's `description` at install. */
  modelDescription: z.string().min(1),
  url: httpsUrlSchema,
  transport: mcpTransportSchema,
  auth: connectorAuthRecipeSchema,
  /** registry.modelcontextprotocol.io name, when the server is published there. */
  registryName: z.string().min(1).optional(),
  websiteUrl: httpsUrlSchema.optional(),
  featured: z.boolean().optional(),
});
export type ConnectorCatalogEntry = z.infer<typeof connectorCatalogEntrySchema>;

export const connectorCatalogSchema = z.array(connectorCatalogEntrySchema);

/**
 * Parse + cross-entry validation. Throws with slug context on a bad entry,
 * and rejects duplicate slugs (per-field checks — https urls, strict keys —
 * live on the entry schema).
 */
export function parseConnectorCatalog(raw: unknown): ConnectorCatalogEntry[] {
  if (!Array.isArray(raw)) {
    throw new Error("connector catalog: expected a JSON array of entries");
  }
  const entries: ConnectorCatalogEntry[] = [];
  const seen = new Set<string>();
  raw.forEach((item, index) => {
    const parsed = connectorCatalogEntrySchema.safeParse(item);
    if (!parsed.success) {
      const slug =
        typeof item === "object" &&
        item !== null &&
        "slug" in item &&
        typeof (item as { slug: unknown }).slug === "string"
          ? (item as { slug: string }).slug
          : `entry #${index}`;
      throw new Error(
        `connector catalog (${slug}): ${z.prettifyError(parsed.error)}`,
      );
    }
    if (seen.has(parsed.data.slug)) {
      throw new Error(
        `connector catalog: duplicate slug "${parsed.data.slug}"`,
      );
    }
    seen.add(parsed.data.slug);
    entries.push(parsed.data);
  });
  return entries;
}
