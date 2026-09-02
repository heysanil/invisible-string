---
"@invisible-string/control-plane": patch
"@invisible-string/db": patch
---

Close six defects in the per-session dispatch lock: the lock now rides a dedicated Postgres pool (`DB_LOCK_POOL_SIZE`) with a bounded reserve so concurrent dispatches can no longer deadlock the root pool, a fresh session's id is pre-minted so its lock is taken before the claim transaction (a timeout creates nothing) and continuations re-read their session under the lock with CAS-only status writes (no stale-snapshot resurrection of a closed row), a lock-holding dispatch heals an abandoned eveless session inline instead of answering `session_busy` until a restart, a Stop on a live tail awaits its remote cancel under the lock before finalizing the row (a follow-up can no longer be admitted under an airborne unqualified cancel), every no-tail Stop records a durable `runs.remote_cancel_pending_at` obligation (additive migration) that the guarded chase clears and boot reconciliation finishes after a crash, and the HITL resume flips waiting→queued by CAS and re-checks terminality before the continue so a Stop is never erased.
