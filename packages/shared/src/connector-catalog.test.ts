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
    expect(() => parseConnectorCatalog([...entries, entries[0]])).toThrow(
      /duplicate/i,
    );
  });
});
