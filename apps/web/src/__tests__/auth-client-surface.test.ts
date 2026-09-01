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

/**
 * Dropping the re-exports is necessary but NOT sufficient: `authClient` is
 * Better Auth's dynamic path proxy, so `authClient.useSession()` resolves at
 * runtime whether or not anything imports or re-exports it. The atom, and the
 * whole bug, comes back through that door without a single new import.
 */
function bannedHookUse(text: string): string[] {
  const hits: string[] = [];
  for (const name of BANNED) {
    // `authClient.useSession`, and through any intermediate segment
    // (`authClient.organization.useListOrganizations`).
    if (new RegExp(`authClient\\s*(?:\\.\\s*\\w+\\s*)*\\.\\s*${name}\\b`).test(text)) {
      hits.push(`authClient.${name}`);
    }
  }
  // The same hook by another route: `const { useSession } = authClient`.
  for (const match of text.matchAll(
    /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*authClient\b/g,
  )) {
    for (const name of BANNED) {
      if (new RegExp(`\\b${name}\\b`).test(match[1] ?? "")) {
        hits.push(`{ ${name} } = authClient`);
      }
    }
  }
  return hits;
}

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

test("no source file reaches a Better Auth React hook through authClient", async () => {
  const glob = new Bun.Glob("**/*.{ts,tsx}");
  const root = new URL("../", import.meta.url).pathname;
  const offenders: string[] = [];
  for await (const file of glob.scan({ cwd: root })) {
    if (file.startsWith("__tests__/")) continue;
    const text = await Bun.file(`${root}${file}`).text();
    for (const hit of bannedHookUse(text)) offenders.push(`${file}: ${hit}`);
  }
  expect(offenders).toEqual([]);
});

/** The scanner has to actually catch the thing it exists to catch. */
test("the authClient hook scanner catches every way in", () => {
  expect(bannedHookUse("const s = authClient.useSession();")).toHaveLength(1);
  expect(
    bannedHookUse("authClient.organization.useListOrganizations()"),
  ).toHaveLength(1);
  expect(bannedHookUse("const { useSession } = authClient;")).toHaveLength(1);
  // The app's own chat-session hook must NOT trip it.
  expect(bannedHookUse('import { useSession } from "./queries/sessions";')).toEqual(
    [],
  );
});
