---
"@invisible-string/control-plane": patch
---

Await the reply-delivery ledger's failure settle instead of returning its promise, so a settle write that rejects during shutdown surfaces as a logged delivery failure rather than an unhandled rejection in the control-plane process.
