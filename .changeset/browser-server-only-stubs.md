---
"@invisible-string/web": patch
---

Stub every server-only `packages/shared` module for the browser, fixing the `node:crypto` crash that made the SPA fail to load, and add a guard test so a new server-only module in the shared barrel can no longer break the client bundle silently.
