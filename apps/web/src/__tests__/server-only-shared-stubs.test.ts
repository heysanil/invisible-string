/**
 * Guard: every server-only module in the `@invisible-string/shared` barrel has
 * a browser stub, and every stub still mirrors its real module's runtime
 * surface.
 *
 * WHY THIS EXISTS. The barrel `export *`s every sibling, so importing one DTO
 * pulls in all of them — including modules that `import … from "node:crypto"`.
 * Vite externalizes `node:*` and its shim throws on property ACCESS, so an
 * un-stubbed server module takes down the entire SPA at load with an error that
 * names the Node builtin, not the import that dragged it in. That is exactly
 * how `worker-token-crypto.ts` broke `VITE_FIXTURE_MODE=1` after `crypto.ts`
 * had already been stubbed: the pattern existed, but nothing enforced it.
 *
 * These assertions are static (no DOM, no bundler), so they run in the default
 * `bun test` lane and fail the moment the barrel grows a new server-only module
 * or a stub drifts from the module it stands in for.
 */
import { expect, test } from "bun:test";

import { SERVER_ONLY_SHARED_MODULES } from "../lib/server-only-shared-modules";

const SHARED_SRC = new URL("../../../../packages/shared/src/", import.meta.url);
const WEB_LIB = new URL("../lib/", import.meta.url);

async function read(url: URL): Promise<string> {
  return await Bun.file(url).text();
}

/** Strip comments so a `node:` mention in prose is not read as an import. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Module names the barrel re-exports: `export * from "./<name>"`. */
function barrelModules(indexSource: string): string[] {
  return [...stripComments(indexSource).matchAll(/export \* from "\.\/([\w-]+)"/g)].map(
    (match) => match[1]!,
  );
}

/** Runtime (value) exports — the names `export *` actually has to satisfy. */
function valueExports(source: string): string[] {
  const clean = stripComments(source);
  const names = new Set<string>();
  for (const re of [
    /^export\s+(?:async\s+)?function\s+(\w+)/gm,
    /^export\s+const\s+(\w+)/gm,
    /^export\s+class\s+(\w+)/gm,
  ]) {
    for (const match of clean.matchAll(re)) names.add(match[1]!);
  }
  return [...names];
}

test("every server-only module in the shared barrel is registered for stubbing", async () => {
  const modules = barrelModules(await read(new URL("index.ts", SHARED_SRC)));
  expect(modules.length).toBeGreaterThan(0);

  const registered = new Set(SERVER_ONLY_SHARED_MODULES.map((entry) => entry.module));
  const unstubbed: string[] = [];

  for (const name of modules) {
    const source = stripComments(await read(new URL(`${name}.ts`, SHARED_SRC)));
    const importsNode = /from\s+"node:[\w/]+"/.test(source);
    if (importsNode && !registered.has(name)) unstubbed.push(name);
  }

  expect(
    unstubbed,
    `packages/shared/src/{${unstubbed.join(", ")}}.ts import node: builtins and are ` +
      "re-exported from the barrel, but have no browser stub. Add an entry to " +
      "apps/web/src/lib/server-only-shared-modules.ts and a matching stub file, " +
      "or the SPA will crash at load.",
  ).toEqual([]);
});

test("every registered stub exists and mirrors its module's runtime exports", async () => {
  for (const { module, stub } of SERVER_ONLY_SHARED_MODULES) {
    const stubUrl = new URL(stub, WEB_LIB);
    expect(await Bun.file(stubUrl).exists(), `missing stub file ${stub}`).toBe(true);

    const real = valueExports(await read(new URL(`${module}.ts`, SHARED_SRC)));
    const stubbed = new Set(valueExports(await read(stubUrl)));
    const missing = real.filter((name) => !stubbed.has(name));

    // `export *` resolves against the STUB in the browser, so a value the real
    // module exports and the stub does not is an undefined import at runtime.
    expect(
      missing,
      `${stub} is missing ${missing.join(", ")} — exported by ` +
        `packages/shared/src/${module}.ts and therefore required by the barrel.`,
    ).toEqual([]);
  }
});

test("the registry only lists modules that are actually server-only", async () => {
  for (const { module } of SERVER_ONLY_SHARED_MODULES) {
    const source = stripComments(await read(new URL(`${module}.ts`, SHARED_SRC)));
    // A stub that no longer stands for anything is dead weight that silently
    // shadows a module the browser could have used directly.
    expect(
      /from\s+"node:[\w/]+"/.test(source),
      `packages/shared/src/${module}.ts no longer imports a node: builtin — ` +
        "drop it from server-only-shared-modules.ts and delete its stub.",
    ).toBe(true);
  }
});
