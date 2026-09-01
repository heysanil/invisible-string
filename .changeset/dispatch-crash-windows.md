---
"@invisible-string/control-plane": patch
---

Close three dispatch/recovery crash windows: a crashed `for_each` now replays its RECORDED resolution verdict (a doomed over-`maxItems`/non-array loop fails `fan_out_exceeded`/`items_not_array` on recovery instead of re-resolving against moved state and executing), the dispatch-attempt marker (`runs.started_at`) alone is now the recovery authority (boot reconciliation never tails a marker-null run, every chat/agent dispatch arms it pre-send, and a stillborn `session:"thread"` continuation is safely re-sent into its established session), and a Stop racing an in-flight eve create is handled at the source (the dispatch re-reads the child run after the create returns and remote-cancels with the fresh session id, the Slack thread-claim eviction spares marker-armed possibly-mid-dispatch holders, and boot reconciliation closes abandoned eveless marker-set sessions to free their thread claims).
