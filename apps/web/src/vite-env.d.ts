/// <reference types="vite/client" />

interface ImportMetaEnv {
  /** Control-plane base URL; defaults to http://localhost:3000. */
  readonly VITE_API_URL?: string;
  /** "1"/"true" renders /chat from a canned event log (no backend). */
  readonly VITE_FIXTURE_MODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
