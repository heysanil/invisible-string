---
"@invisible-string/control-plane": patch
---

Close two run-tail liveness defects: every exit path out of a tail (its natural terminal and reconnect exhaustion included, not only an explicit abort) now takes one synchronous `close` transition that frees the session's reader slot and refuses obligation handoffs from then on, and a tail chained behind a draining predecessor arms its observation deadline at creation and bounds the wait — a drain that never releases the stream is seized and fenced after `streamTakeoverMs` and its cursor taken over — so a hung reconnect or store call can no longer wedge a session's tail slot until restart.
