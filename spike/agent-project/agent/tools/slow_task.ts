import { defineTool } from "eve/tools";
import { z } from "zod";

/**
 * Un-gated tool that simply takes a while.
 *
 * Exists so the spike can hold a turn in the ACTIVE state long enough to
 * exercise eve 0.31's cancel route against a real in-flight turn. Every other
 * flow here settles in ~200 ms under EVE_MOCK_AUTHORED_MODELS, which makes
 * "cancel a running turn" unraceable — and a flaky cancel test is worse than
 * none, because it teaches readers to re-run instead of to look.
 *
 * Deliberately NOT approval-gated: an approval park emits `turn.completed`
 * and ends the turn (see spike/tests/fixtures/mocked-parked-events.ndjson),
 * so a parked session has no active turn to cancel.
 *
 * Under EVE_MOCK_AUTHORED_MODELS the mock does NOT read the prompted value —
 * it emits a stock schema-satisfying one (observed: `seconds: 1`, regardless
 * of what the message asked for). Raising the schema's `min` above that stock
 * value makes the mock's tool call fail validation and the model silently
 * answers in prose instead, so the bounds stay wide and the floor is enforced
 * HERE, where it is deterministic either way.
 */
const MIN_SLEEP_SECONDS = 5;

export default defineTool({
  description:
    "Sleep for the given number of seconds, then return. Used to hold a turn open.",
  inputSchema: z.object({ seconds: z.number().min(1).max(120) }),
  async execute({ seconds }) {
    const slept = Math.max(seconds, MIN_SLEEP_SECONDS);
    await new Promise((resolve) => setTimeout(resolve, slept * 1000));
    return { ok: true, requested: seconds, slept };
  },
});
