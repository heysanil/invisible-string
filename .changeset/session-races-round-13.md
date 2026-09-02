---
"@invisible-string/control-plane": patch
---

Close two ordering races in remote-cancel confirmation: turn attribution now reads a session's claimants (open obligations and live unattributed successors) in ONE store statement so a no-tail Stop committing mid-attribution can no longer leave its already-open turn classified foreign, adoption of an obligation with no turn id looks back over the session's persisted unowned content turns and attributes (and cancels, or meets on a persisted boundary) retroactively, and the tailer manager checks reader liveness at the obligation handoff — an aborted tail leaves the reader slot synchronously, a refused signal makes the settlement open its own observer chained behind the draining cursor, and the context controls' quiet check counts a draining tail as holding the stream.
