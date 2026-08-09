/**
 * Gated: needs a live Meilisearch (docker compose up -d meilisearch) plus
 * MEILISEARCH_URL + MEILISEARCH_MASTER_KEY. Skips cleanly in the unit lane.
 */
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
