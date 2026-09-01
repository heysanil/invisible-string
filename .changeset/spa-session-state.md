---
"@invisible-string/web": patch
---

Fix signing in requiring two attempts and workspace content staying blank until a reload, by moving SPA identity off Better Auth's React hooks onto a viewer query gated in the router.
