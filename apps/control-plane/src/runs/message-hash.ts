/**
 * The turn CORRELATOR (`runs.message_hash`): sha256 (hex) of the exact
 * `message` string a dispatch hands to eve. eve echoes that text verbatim in
 * the `message.received` event that immediately follows every content turn's
 * `turn.started` (LIVE-OBSERVED — `EveMessageReceivedEvent`, spike fixture
 * `task-output-schema-events.ndjson`), so hashing both sides lets the tail
 * attribute a turn to the run that SENT it, never to whichever run happened
 * to be waiting in line (runs/tailer.ts). Only the digest is ever persisted or
 * logged — never the message text.
 */
import { createHash } from "node:crypto";

export function hashTurnMessage(message: string): string {
  return createHash("sha256").update(message, "utf8").digest("hex");
}
