---
"@invisible-string/control-plane": patch
---

Bound every product-DB statement with a Postgres `statement_timeout` on all three control-plane pools (`DB_STATEMENT_TIMEOUT_MS`, default 30 s) and derive the run tailer's takeover bound from it: a seized tail is now fenced between statements and its successor waits the statement timeout plus a margin — not a second fixed pause — before reading the session's cursor, so a stalled event write that has reached the server is landed or dead before the successor reads (a write still queued client-side behind a root pool starved for longer than the bound is the one documented residual), and a hung drain is seized by the manager after `streamTakeoverMs` and evicted from the stream-holder list after the same derived bound whether or not it ever finishes (capped per session), so a session can no longer answer `session_busy` forever on a drain that never releases.
