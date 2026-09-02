---
"@invisible-string/control-plane": patch
---

Carry the OAuth end-to-end lessons into pipeline `tool` steps: an oauth connection's grant status is read before any dial (a pending or absent grant fails `auth_required` without touching the server), a grant the authorization server retired fails `auth_error` and is never retried, an unreachable authorization server during refresh is a retryable `unreachable` that leaves the grant connected, and `hasCredentials` reflects the credential actually presented rather than the auth type.
