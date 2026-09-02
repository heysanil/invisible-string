---
"@invisible-string/control-plane": patch
"@invisible-string/db": patch
---

Confirm a Stop's remote cancel from eve's own stream: `runs.turn_id` is the only acceptance proof (written when the tail attributes the run's own `turn.started`, in send order), the live tail sends a turn-qualified cancel or nothing and stays on the stream in observation mode until the run's own turn boundary, a session-terminal answer, or a newer run's `turn_id` clears `remote_cancel_pending_at` (never eve's 202 to a pre-turn cancel, never a synthesized `running` successor or leftover events), the no-tail settlement, the periodic sweep and boot reconciliation re-open observation instead of chasing eve unqualified, and an obligation unconfirmed past `REMOTE_CANCEL_OBSERVE_MS` (default 10 min) is declared unresolved on the row (`remote_cancel_unresolved_at`, migration 0017) rather than silently cleared.
