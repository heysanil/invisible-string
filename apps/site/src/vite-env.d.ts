/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Canonical public site URL; used for SEO/OG tags and defaults to the
   *  dev origin. Set by CI to the GitHub Pages base URL. */
  readonly VITE_SITE_URL?: string;
  /** URL of the running app (the SPA). When set, the nav shows an
   *  "Open the app" CTA; when unset, the CTA is hidden. */
  readonly VITE_APP_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
