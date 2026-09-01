---
"@invisible-string/control-plane": minor
"@invisible-string/db": minor
---

Stage an MCP OAuth consent flow's discovered endpoints and client identity on the new `connection_oauth.pending_flow` column and promote them onto the grant only when a token exchange succeeds, so a re-consent that is declined, abandoned, or rejected can no longer repoint a live grant's token and revocation endpoints at an authorization server the MCP server nominated mid-life.
