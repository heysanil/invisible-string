import { defineChannel, POST } from "eve/channels";
import { routeAuth } from "eve/channels/auth";

import { platformAuth } from "../lib/platform-auth.js";
import {
  buildTriggerMessage,
  parseTriggerEvent,
} from "../lib/trigger-event.js";

/** {{trigger.*}} markers used by this workflow's instructions (compile-time). */
const TRIGGER_REFS: readonly string[] = ["text"];

/** Where the terminal reply goes: captured from the inbound event's data. */
interface SlackReplyTarget {
  channel: string | null;
  threadTs: string | null;
}

function replyTargetFrom(data: Record<string, unknown>): SlackReplyTarget {
  const channel = typeof data.channel === "string" ? data.channel : null;
  const threadTs =
    typeof data.thread_ts === "string"
      ? data.thread_ts
      : typeof data.ts === "string"
        ? data.ts
        : null;
  return { channel, threadTs };
}

/** Outbound delivery for real: Slack Web API chat.postMessage. */
async function postSlackReply(
  target: SlackReplyTarget,
  text: string,
): Promise<void> {
  const token = process.env.SLACK_BOT_TOKEN;
  if (token === undefined || token.length === 0) {
    console.error("[slack] SLACK_BOT_TOKEN is not set; dropping outbound reply");
    return;
  }
  if (target.channel === null) {
    console.error("[slack] no reply channel recorded; dropping outbound reply");
    return;
  }
  try {
    const response = await fetch("https://slack.com/api/chat.postMessage", {
      method: "POST",
      headers: {
        "content-type": "application/json; charset=utf-8",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({
        channel: target.channel,
        text,
        ...(target.threadTs !== null ? { thread_ts: target.threadTs } : {}),
      }),
    });
    const result = (await response.json().catch(() => null)) as {
      ok?: boolean;
      error?: string;
    } | null;
    if (result === null || result.ok !== true) {
      console.error(
        `[slack] chat.postMessage failed: ${result?.error ?? `HTTP ${response.status}`}`,
      );
    }
  } catch (error) {
    console.error("[slack] chat.postMessage failed", error);
  }
}

/**
 * slack trigger channel. eve's built-in Slack channel is Vercel-coupled
 * (PLAN correction 3), so the platform dispatches normalized TriggerEvents
 * here and outbound replies use the Slack Web API directly with platform
 * credentials from env. Threaded replies continue the same session via the
 * dispatcher's continuationToken passthrough (thread_ts mapping lives in the
 * control plane).
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
