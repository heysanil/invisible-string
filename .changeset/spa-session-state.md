---
"@invisible-string/web": patch
---

Fix signing in requiring two attempts and workspace content staying blank until a reload, by moving SPA identity off Better Auth's React hooks onto a viewer query gated in the router; the cached query data of a previous account is now dropped whenever the signed-in principal changes, including from another tab, a session revoked elsewhere is noticed on refocus or reconnect, every auth request behind the gate is bounded so a hung server cannot wedge navigation, and accepting a workspace invitation can no longer strand you on a retry that re-reads the invitation it already consumed.
