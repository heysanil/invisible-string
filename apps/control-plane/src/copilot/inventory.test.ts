/**
 * Inventory loader — DB-gated (skips cleanly when TEST_DATABASE_URL is
 * unset). Covers the connectors-plan-2 enrichment: connection entries carry
 * `health` and the bare tool names from the probe's `toolsCache` (capped at
 * 40, with the full cached count alongside so the prompt can render a
 * truncation marker). Rendering of these fields is covered in copilot.test.ts.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { schema } from "@invisible-string/db";

import { createDb, type DbHandle } from "../db";
import { runMigrations } from "../migrate";
import { createInventoryLoader } from "./inventory";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (!TEST_DATABASE_URL) {
  console.warn(
    "[inventory] TEST_DATABASE_URL not set — skipping inventory loader tests",
  );
}

const nano16 = () => randomUUID().replace(/-/g, "").slice(0, 16);

describe.skipIf(!TEST_DATABASE_URL)(
  "createInventoryLoader — connection tools + health",
  () => {
    let handle: DbHandle;
    let orgId: string;
    let userId: string;
    const probedId = `cn_${nano16()}`;
    const unprobedId = `cn_${nano16()}`;

    beforeAll(async () => {
      await runMigrations(TEST_DATABASE_URL!);
      handle = createDb(TEST_DATABASE_URL!, { max: 2 });
      orgId = `org-inv-${nano16()}`;
      userId = `user-inv-${nano16()}`;
      await handle.db.insert(schema.user).values({
        id: userId,
        name: "Inventory Tester",
        email: `inventory-${nano16()}@example.com`,
      });
      await handle.db.insert(schema.organization).values({
        id: orgId,
        name: "Inventory Org",
        slug: `inv-${nano16()}`,
        createdAt: new Date(),
      });
      await handle.db.insert(schema.connections).values([
        {
          id: probedId,
          scope: "workspace",
          organizationId: orgId,
          name: "Probed Notes",
          source: "custom",
          url: "https://mcp.example.com/mcp",
          health: "ok",
          lastCheckedAt: new Date(),
          toolsCache: Array.from({ length: 45 }, (_, i) => ({
            name: `tool_${i + 1}`,
            description: `tool number ${i + 1}`,
            params: ["note"],
          })),
          toolsCachedAt: new Date(),
        },
        {
          id: unprobedId,
          scope: "workspace",
          organizationId: orgId,
          name: "Unprobed Notes",
          source: "custom",
          url: "https://mcp.example.com/mcp-b",
          // health defaults to `unknown`; toolsCache stays null.
        },
      ]);
    }, 30_000);

    afterAll(async () => {
      // Org delete cascades the connections; keep the shared test DB clean.
      await handle?.db
        .delete(schema.organization)
        .where(eq(schema.organization.id, orgId));
      await handle?.db.delete(schema.user).where(eq(schema.user.id, userId));
      await handle?.close();
    }, 15_000);

    test("entries carry health + bare tool names from toolsCache, capped at 40 with the full count", async () => {
      const load = createInventoryLoader(handle.db);
      const inventory = await load(orgId, userId);

      const probed = inventory.connections.find((c) => c.id === probedId);
      expect(probed).toBeDefined();
      expect(probed!.health).toBe("ok");
      expect(probed!.tools).toHaveLength(40);
      expect(probed!.tools[0]).toBe("tool_1");
      expect(probed!.tools[39]).toBe("tool_40");
      expect(probed!.tools).not.toContain("tool_41");
      expect(probed!.toolCount).toBe(45);
    });

    test("a never-probed connection reads unknown health and an empty tool list", async () => {
      const load = createInventoryLoader(handle.db);
      const inventory = await load(orgId, userId);

      const unprobed = inventory.connections.find((c) => c.id === unprobedId);
      expect(unprobed).toBeDefined();
      expect(unprobed!.health).toBe("unknown");
      expect(unprobed!.tools).toEqual([]);
      expect(unprobed!.toolCount).toBe(0);
    });
  },
);
