import { fileURLToPath } from "node:url";

import { tanstackRouter } from "@tanstack/router-plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

import { SERVER_ONLY_SHARED_MODULES } from "./src/lib/server-only-shared-modules";

const stubsByModule = new Map(
  SERVER_ONLY_SHARED_MODULES.map(({ module, stub }) => [
    module,
    fileURLToPath(new URL(`./src/lib/${stub}`, import.meta.url)),
  ]),
);

/**
 * `@invisible-string/shared`'s barrel re-exports server-only modules that
 * import `node:crypto` (envelope encryption, worker token minting). Vite
 * externalizes `node:*` and its shim throws on access, so importing ANY shared
 * DTO would crash the SPA at load. Redirect each to a browser stub so importing
 * shared contracts stays client-safe. The web app runs none of this code — the
 * control plane and worker do.
 *
 * The module list lives in ./src/lib/server-only-shared-modules.ts so the guard
 * test can assert it stays complete as the barrel grows.
 */
function stubServerOnlySharedModules(): Plugin {
  return {
    name: "stub-server-only-shared-modules",
    enforce: "pre",
    resolveId(source, importer) {
      for (const [module, stub] of stubsByModule) {
        if (
          source === `@invisible-string/shared/${module}` ||
          (source === `./${module}` &&
            importer !== undefined &&
            importer.replace(/\\/g, "/").includes("/packages/shared/src/"))
        ) {
          return stub;
        }
      }
      return null;
    },
  };
}

/**
 * Anti-clickjacking + sniffing headers for the SPA. Emitted by the dev server
 * and `vite preview`; a production static host must front the built assets with
 * the same headers (documented in docs/). We deliberately do NOT set a
 * restrictive `default-src` CSP here — dev HMR needs inline scripts and a
 * websocket — but `frame-ancestors 'none'` (via X-Frame-Options) is the header
 * that actually stops the authenticated builder/chat from being framed, and
 * meta-tag CSP cannot express frame-ancestors.
 */
const securityHeaders: Record<string, string> = {
  "X-Frame-Options": "DENY",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};

export default defineConfig({
  plugins: [
    stubServerOnlySharedModules(),
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  server: { headers: securityHeaders },
  preview: { headers: securityHeaders },
});
