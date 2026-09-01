---
"@invisible-string/control-plane": minor
"@invisible-string/web": patch
---

Harden the MCP OAuth broker after review: provider `error` strings are narrowed to a closed RFC vocabulary before they can reach `last_error` or a DTO (an authorization server could otherwise echo back the refresh token, authorization code or client secret it had just received), the consent callback's promotion and failure bookkeeping are guarded by an optimistic-concurrency stamp so a flow that loses its race to a URL or auth-mode change discards its tokens instead of resurrecting a stale grant, `MCP_OAUTH_<PREFIX>_ISSUER` is now required and exact-matched with no fail-open, a stored dynamic-registration client whose issuer was never recorded is re-registered rather than replayed at a new authorization server, and permanently-dead refreshes (`invalid_client`, `unauthorized_client`, `invalid_scope`, `unsupported_grant_type`) retire the grant as `auth_required` instead of being retried forever as transient.
