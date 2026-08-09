---
"@invisible-string/control-plane": patch
---

Pin the host toolchain (bun, node, wrangler) in `mise.toml` and install it in every CI job via `mise-action`, so all lanes run the same versions.
