/**
 * The registry of `@invisible-string/shared` modules that are SERVER-ONLY and
 * must be swapped for a browser stub in the client bundle.
 *
 * The shared barrel (`packages/shared/src/index.ts`) `export *`s everything, so
 * importing any DTO or zod schema pulls in EVERY sibling module — including the
 * ones that `import … from "node:crypto"`. Vite externalizes `node:*` and its
 * shim throws on property access, so a single un-stubbed server module crashes
 * the whole SPA at load with a message that names the Node builtin rather than
 * the import that dragged it in.
 *
 * `vite.config.ts` reads this list to build its resolver, and
 * `__tests__/server-only-shared-stubs.test.ts` reads it to prove the list is
 * complete and each stub still mirrors its real module. Add an entry here when
 * a new server-only module joins the barrel.
 */
export interface ServerOnlySharedModule {
  /** Module name as it appears in the barrel's `export * from "./<name>"`. */
  readonly module: string;
  /** Stub filename, resolved relative to this directory. */
  readonly stub: string;
}

export const SERVER_ONLY_SHARED_MODULES: readonly ServerOnlySharedModule[] = [
  { module: "crypto", stub: "shared-crypto-browser-stub.ts" },
  {
    module: "worker-token-crypto",
    stub: "shared-worker-token-crypto-browser-stub.ts",
  },
];
