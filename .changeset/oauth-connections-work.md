---
"@invisible-string/control-plane": minor
"@invisible-string/db": minor
"@invisible-string/shared": minor
"@invisible-string/web": minor
---

Make MCP OAuth connections actually work: the health probe now presents the broker's access token through `getAccessToken` instead of dialling unauthenticated and reporting the server's correct 401 as a rejected credential (so OAuth connections finally populate their tool cache), an oauth row is no longer probed before consent, `hasCredentials` follows the grant rather than the auth type, discovery is scheme/issuer/resource-validated with challenge-first scopes and `offline_access`, only `invalid_grant` retires a grant while a declined or abandoned re-consent leaves a live one untouched, consent results post to the SPA origin (new optional `PUBLIC_WEB_URL`, defaulting to `PUBLIC_APP_URL`) carrying a sanitized failure reason each surface explains in the same words, pending flows are bound to the user who started them, and catalog OAuth presets now declare their client-identity strategy — adding an operator-configured pre-registered client mode (`MCP_OAUTH_<PREFIX>_CLIENT_ID`) and removing the Vercel preset, whose authorization server rejects dynamic registration outright.
