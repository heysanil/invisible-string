---
"@invisible-string/control-plane": patch
---

Move the pipeline runner's per-run driver lock onto a dedicated, bounded lock pool (`DB_PIPELINE_LOCK_POOL_SIZE`, default 32; exhaustion is the typed transient skip `lock_pool_exhausted` taken before any run row exists — 503 `pipeline_lock_pool_exhausted` on webhook/manual ingress — instead of pinning root-pool connections until ten long pipelines wedged the whole control plane), clear a Stop's durable remote-cancel obligation only on a confirmed outcome (eve acknowledged, eve `session_not_active`, superseded, or nothing to chase — a transport failure now retains `remote_cancel_pending_at`, and a live-tail cancel that fails in transport records it exactly like a skipped one), make the deferred cancel chase back off across a saturated lock pool for its whole bound, and add a periodic advisory-locked remote-cancel sweep (`REMOTE_CANCEL_SWEEP_MS`, default 60 s) so a healthy process finishes those obligations without a restart.
