/**
 * Generated `agent/channels/*`:
 *
 * - `eve.ts`: the default HTTP channel with platform-JWT route auth
 *   (verifyJwtHmac AuthFn, `localDev()` only on dev builds) and an
 *   `onMessage` hook injecting platform context blocks — PLAN correction 2:
 *   `context: string[]` is an onMessage RETURN, not a send() option.
 * - `<trigger>.ts` (form/webhook/slack): a custom channel at the locked
 *   `/eve/v1/platform/<trigger>` route (spike/REPORT.md finding 7 — raw
 *   authored paths must ride the proxy's forwarded `/eve/` prefix). It
 *   verifies the platform JWT, parses the TriggerEvent envelope, resolves
 *   the instructions' `{{trigger.*}}` markers into a <trigger-context>
 *   block, calls send() with continuation-token passthrough, and owns
 *   outbound delivery in its `message.completed` handler (Slack Web API for
 *   slack; platform callback POST for form/webhook).
 */
import { triggerRoutePath } from "../platform";
import type { CompileDeps } from "../types";
import { tsString, tsStringArray } from "./strings";

export function emitEveChannel(deps: CompileDeps): string {
  const identity = `Platform workflow ${tsString(deps.workflowSlug)} in workspace ${tsString(deps.workspaceSlug)} (invisible-string).`;
  return `import { defaultEveAuth, eveChannel } from "eve/channels/eve";

import { platformAuth } from "../lib/platform-auth.js";

/**
 * Default HTTP channel (manual/chat sessions). Route auth is the platform
 * JWT; onMessage injects platform context blocks — context is an onMessage
 * return, never a send() option.
 */
export default eveChannel({
  auth: platformAuth(),
  onMessage(ctx) {
    const caller = ctx.eve.caller;
    const context = [${tsString(identity)}];
    if (caller !== null) {
      context.push(
        \`Caller principal: \${caller.principalId} (\${caller.principalType}).\`,
      );
    }
    return { auth: defaultEveAuth(ctx), context };
  },
});
`;
}

/** Shared route body: auth → parse → marker resolution → send(). */
function routeBody(triggerType: string, sendOptionsExtra: string): string {
  return `      const auth = await routeAuth(req, platformAuth());
      if (auth instanceof Response) return auth;

      const body: unknown = await req.json().catch(() => null);
      const parsed = parseTriggerEvent(body);
      if (!parsed.ok) {
        return Response.json({ ok: false, error: parsed.error }, { status: 400 });
      }
      const event = parsed.event;
      if (event.triggerType !== ${tsString(triggerType)}) {
        return Response.json(
          {
            ok: false,
            error: \`expected triggerType "${triggerType}", got "\${event.triggerType}"\`,
          },
          { status: 400 },
        );
      }

      const continuationToken =
        event.continuationToken ?? \`${triggerType}-\${crypto.randomUUID()}\`;
      const session = await send(buildTriggerMessage(event, TRIGGER_REFS), {
        auth,
        continuationToken,${sendOptionsExtra}
      });

      return Response.json({
        ok: true,
        sessionId: session.id,
        continuationToken,
      });`;
}

/** Outbound-delivery stub for form/webhook: POST the platform callback. */
function callbackEventsBlock(triggerType: string): string {
  return `  events: {
    /**
     * Outbound delivery: POST the terminal reply to the platform callback
     * when one is configured (the supervisor injects PLATFORM_CALLBACK_URL,
     * plus optional PLATFORM_CALLBACK_TOKEN as a bearer credential).
     * Interim narration (finishReason "tool-calls" etc.) is not delivered.
     */
    async "message.completed"(data, channel, ctx) {
      if (data.finishReason !== "stop" || data.message === null) return;
      const callbackUrl = process.env.PLATFORM_CALLBACK_URL;
      if (callbackUrl === undefined || callbackUrl.length === 0) return;
      const headers: Record<string, string> = {
        "content-type": "application/json",
      };
      const token = process.env.PLATFORM_CALLBACK_TOKEN;
      if (token !== undefined && token.length > 0) {
        headers.authorization = \`Bearer \${token}\`;
      }
      try {
        const response = await fetch(callbackUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({
            trigger: ${tsString(triggerType)},
            sessionId: ctx.session.id,
            continuationToken: channel.continuationToken,
            message: data.message,
          }),
        });
        if (!response.ok) {
          console.error(
            \`[${triggerType}] callback delivery failed: HTTP \${response.status}\`,
          );
        }
      } catch (error) {
        console.error("[${triggerType}] callback delivery failed", error);
      }
    },
  },`;
}

function emitCallbackTriggerChannel(
  triggerType: "form" | "webhook",
  triggerRefPaths: readonly string[],
): string {
  return `import { defineChannel, POST } from "eve/channels";
import { routeAuth } from "eve/channels/auth";

import { platformAuth } from "../lib/platform-auth.js";
import {
  buildTriggerMessage,
  parseTriggerEvent,
} from "../lib/trigger-event.js";

/** {{trigger.*}} markers used by this workflow's instructions (compile-time). */
const TRIGGER_REFS: readonly string[] = ${tsStringArray(triggerRefPaths)};

/**
 * ${triggerType} trigger channel. The control-plane dispatcher POSTs a
 * normalized TriggerEvent here, authenticated with the platform JWT. Route
 * convention: ${triggerRoutePath(triggerType)} rides the worker proxy's
 * forwarded /eve/ prefix.
 */
export default defineChannel({
  routes: [
    POST(${tsString(triggerRoutePath(triggerType))}, async (req, { send }) => {
${routeBody(triggerType, "")}
    }),
  ],
${callbackEventsBlock(triggerType)}
});
`;
}

function emitSlackTriggerChannel(triggerRefPaths: readonly string[]): string {
  return `import { defineChannel, POST } from "eve/channels";
import { routeAuth } from "eve/channels/auth";

import { platformAuth } from "../lib/platform-auth.js";
import {
  buildTriggerMessage,
  parseTriggerEvent,
} from "../lib/trigger-event.js";

/** {{trigger.*}} markers used by this workflow's instructions (compile-time). */
const TRIGGER_REFS: readonly string[] = ${tsStringArray(triggerRefPaths)};

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
        authorization: \`Bearer \${token}\`,
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
        \`[slack] chat.postMessage failed: \${result?.error ?? \`HTTP \${response.status}\`}\`,
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
    POST<SlackReplyTarget>(${tsString(triggerRoutePath("slack"))}, async (req, { send }) => {
${routeBody("slack", "\n        state: replyTargetFrom(event.data),")}
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
`;
}

export function emitTriggerChannel(
  triggerType: "form" | "webhook" | "slack",
  triggerRefPaths: readonly string[],
): string {
  return triggerType === "slack"
    ? emitSlackTriggerChannel(triggerRefPaths)
    : emitCallbackTriggerChannel(triggerType, triggerRefPaths);
}
