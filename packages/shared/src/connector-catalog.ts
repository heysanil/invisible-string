/**
 * Connector catalog contract (connectors redesign spec §4) — the zod shape of
 * the checked-in, curated catalog (`connector-catalog.json`). Catalog-as-code:
 * the control plane parses the JSON at module load (fail-fast at boot), the
 * SPA renders the same entries with zero network calls.
 *
 * Auth recipes cover static credentials (`none`/`bearer`/`headers`) and
 * broker-mediated OAuth (`oauth` — no fields: the consent flow supplies the
 * grant, connectors spec §6). No `icon` field — v1 renders E1 monogram tiles.
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
 * Auth recipe: what the install form must collect. `bearer` labels the single
 * token field; `headers` enumerates every header (secret headers are required
 * at install — the create route 422s without them); `oauth` collects nothing —
 * install yields a pending grant and the UI chains into the consent popup.
 */
export const connectorAuthRecipeSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("none") }),
  z.strictObject({ type: z.literal("oauth") }),
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
