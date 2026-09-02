---
"@invisible-string/control-plane": patch
---

Close five read-then-act ordering windows in dispatch and recovery: a replayed `for_each` failure verdict is now authoritative over the fresh resolution's shape (a recorded `fan_out_exceeded` is never reported as `items_not_array`), every eve dispatch path persists the eve session id BEFORE its post-eve terminal recheck so a Stop racing the create always finds an id to remote-cancel (the fresh-chat and post-reset create routes gain the same recheck), the session-busy predicate counts a canceled run whose dispatch may still be in flight on an eveless session (transient `session_busy` instead of a second eve session), the post-eve abandon skips its unqualified session-level cancel when a newer run already owns the session, and boot reconciliation's eveless-session close is an atomic guarded UPDATE that leaves a session untouched if it gained its eve id between snapshot and close.
