import { defineChannel, POST } from "eve/channels";
import { routeAuth } from "eve/channels/auth";

import { platformAuth } from "../lib/platform-auth.js";
import {
  postSlackReply,
  replyTargetFrom,
  type SlackReplyTarget,
} from "../lib/slack.js";
import {
  buildTriggerMessage,
  parseTriggerEvent,
} from "../lib/trigger-event.js";

/** {{trigger.*}} markers used by this workflow's instructions (compile-time). */
const TRIGGER_REFS: readonly string[] = ["text"];

/**
 * slack trigger channel. eve's built-in Slack channel is Vercel-coupled
 * (PLAN correction 3), so the platform dispatches normalized TriggerEvents
 * here and outbound replies use the Slack Web API directly (agent/lib/slack.ts)
 * with the team bot token the dispatcher injects as SLACK_BOT_TOKEN. Threaded
 * replies continue the same session via the dispatcher's continuationToken
 * passthrough (thread_ts ↔ session mapping lives in the control plane).
 */
export default defineChannel({
  state: { channel: null, threadTs: null } as SlackReplyTarget,
  context(state) {
    return { state };
  },
  routes: [
    POST<SlackReplyTarget>("/eve/v1/platform/slack", async (req, { send }) => {
      const auth = await routeAuth(req, platformAuth());
      if (auth instanceof Response) return auth;

      const body: unknown = await req.json().catch(() => null);
      const parsed = parseTriggerEvent(body);
      if (!parsed.ok) {
        return Response.json({ ok: false, error: parsed.error }, { status: 400 });
      }
      const event = parsed.event;
      if (event.triggerType !== "slack") {
        return Response.json(
          {
            ok: false,
            error: `expected triggerType "slack", got "${event.triggerType}"`,
          },
          { status: 400 },
        );
      }

      const continuationToken =
        event.continuationToken ?? `slack-${crypto.randomUUID()}`;
      const session = await send(buildTriggerMessage(event, TRIGGER_REFS), {
        auth,
        continuationToken,
        state: replyTargetFrom(event.data),
      });

      return Response.json({
        ok: true,
        sessionId: session.id,
        continuationToken,
      });
    }),
  ],
  events: {
    /** Deliver the terminal reply (interim narration is not delivered). */
    async "message.completed"(data, channel) {
      if (data.finishReason !== "stop" || data.message === null) return;
      await postSlackReply(channel.state, data.message);
    },
  },
});
