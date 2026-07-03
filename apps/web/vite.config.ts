import { fileURLToPath } from "node:url";

import { tanstackRouter } from "@tanstack/router-plugin/vite";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig, type Plugin } from "vite";

const cryptoStub = fileURLToPath(
  new URL("./src/lib/shared-crypto-browser-stub.ts", import.meta.url),
);

/**
 * `@invisible-string/shared`'s barrel re-exports server-only envelope crypto
 * (`crypto.ts` → `node:crypto` + Node `Buffer`), which crashes in the browser.
 * Redirect that one module to a browser stub so importing shared DTOs stays
 * client-safe. The web app never runs envelope crypto (the control plane does).
 */
function stubServerCrypto(): Plugin {
  return {
    name: "stub-shared-server-crypto",
    enforce: "pre",
    resolveId(source, importer) {
      if (
        source === "@invisible-string/shared/crypto" ||
        (source === "./crypto" &&
          importer !== undefined &&
          importer.replace(/\\/g, "/").includes("/packages/shared/src/"))
      ) {
        return cryptoStub;
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
    stubServerCrypto(),
    tanstackRouter({ target: "react", autoCodeSplitting: true }),
    react(),
    tailwindcss(),
  ],
  server: { headers: securityHeaders },
  preview: { headers: securityHeaders },
});
