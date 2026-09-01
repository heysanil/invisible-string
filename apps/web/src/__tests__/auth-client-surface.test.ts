import { expect, test } from "bun:test";

/**
 * Better Auth's React hooks are nanostores atoms whose freshness is tied to
 * component mount lifecycle, and NO signal fires on sign-in — so an atom that
 * resolved while signed out stays 401 for the life of the page. That is the
 * bug this whole surface was rebuilt to remove; re-exporting a hook is how it
 * comes back. Identity comes from lib/auth/viewer.ts, and only from there.
 */
const BANNED = ["useSession", "useActiveOrganization", "useListOrganizations"];

test("lib/auth-client re-exports no Better Auth React hook", async () => {
  const mod = await import("../lib/auth-client");
  for (const name of BANNED) {
    expect(Object.keys(mod)).not.toContain(name);
  }
});

test("no source file imports a Better Auth React hook", async () => {
  const glob = new Bun.Glob("**/*.{ts,tsx}");
  const root = new URL("../", import.meta.url).pathname;
  const offenders: string[] = [];
  for await (const file of glob.scan({ cwd: root })) {
    if (file.startsWith("__tests__/")) continue;
    const text = await Bun.file(`${root}${file}`).text();
    // Only flag imports FROM better-auth itself; the app has its own
    // useSession (chat sessions) in lib/queries/sessions.ts.
    if (/from\s+["']better-auth\/react["']/.test(text) && file !== "lib/auth-client.ts") {
      offenders.push(file);
    }
  }
  expect(offenders).toEqual([]);
});
