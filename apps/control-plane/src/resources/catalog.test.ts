import { describe, expect, test } from "bun:test";
import { loadConnectorCatalog } from "./catalog";

describe("catalog loader", () => {
  test("loads keyed by slug", () => {
    const catalog = loadConnectorCatalog();
    expect(catalog.get("deepwiki")?.url).toBe("https://mcp.deepwiki.com/mcp");
  });
});
