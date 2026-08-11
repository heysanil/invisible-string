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

  // Plan-3 Task 10: every oauth entry was verified live — (a) the endpoint
  // answers the MCP initialize probe, (b) discoverOauth resolves an
  // authorization server against it. Candidates failing either were dropped
  // (results recorded in the entry-adding commit).
  test("oauth recipes are present and collect nothing at install", () => {
    const entries = parseConnectorCatalog(raw);
    const oauth = entries.filter((e) => e.auth.type === "oauth");
    expect(oauth.length).toBeGreaterThanOrEqual(4);
    for (const entry of oauth) {
      // The recipe is bare: the consent broker supplies the grant.
      expect(entry.auth).toEqual({ type: "oauth" });
    }
    for (const slug of ["linear", "notion", "sentry"]) {
      const entry = entries.find((e) => e.slug === slug);
      expect(entry?.auth.type).toBe("oauth");
      expect(entry?.featured).toBe(true);
    }
  });
});
