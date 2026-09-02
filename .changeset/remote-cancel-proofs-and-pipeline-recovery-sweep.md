---
"@invisible-string/control-plane": patch
---

Close four run-lifecycle defects: a live-tail Stop whose remote cancel was skipped or failed in transport now writes its durable `remote_cancel_pending_at` obligation inside the same CAS that finalizes the row canceled (never a second statement after it), "superseded" now requires a successor that provably reached eve (running/waiting, or terminal with observed events — a merely queued successor retains the marker and the chase retries, in both the guarded cancel and the post-eve recheck), a periodic pipeline-recovery sweep (`PIPELINE_RECOVERY_SWEEP_MS`, default 60 s, replica-elected and lock-gated) re-adopts interrupted pipeline runs left `locked` at boot instead of leaving them active until a restart, and the manual "Run now" route answers the transient 503 `pipeline_lock_pool_exhausted` for a pinned lock pool instead of collapsing it into 409 `run_overlap_skipped`.
