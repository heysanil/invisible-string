import { defineChannel, POST } from "eve/channels";
import { routeAuth } from "eve/channels/auth";

import { platformAuth } from "../lib/platform-auth.js";
import {
  buildTriggerMessage,
  parseTriggerEvent,
} from "../lib/trigger-event.js";

/** {{trigger.*}} markers used by this workflow's instructions (compile-time). */
const TRIGGER_REFS: readonly string[] = ["repo", "audience", "notes"];

/**
 * form trigger channel. The control-plane dispatcher POSTs a
 * normalized TriggerEvent here, authenticated with the platform JWT. Route
 * convention: /eve/v1/platform/form rides the worker proxy's
 * forwarded /eve/ prefix.
 */
export default defineChannel({
  routes: [
    POST("/eve/v1/platform/form", async (req, { send }) => {
      const auth = await routeAuth(req, platformAuth());
      if (auth instanceof Response) return auth;

      const body: unknown = await req.json().catch(() => null);
      const parsed = parseTriggerEvent(body);
      if (!parsed.ok) {
        return Response.json({ ok: false, error: parsed.error }, { status: 400 });
      }
      const event = parsed.event;
      if (event.triggerType !== "form") {
        return Response.json(
          {
            ok: false,
            error: `expected triggerType "form", got "${event.triggerType}"`,
          },
          { status: 400 },
        );
      }

      const continuationToken =
        event.continuationToken ?? `form-${crypto.randomUUID()}`;
      const session = await send(buildTriggerMessage(event, TRIGGER_REFS), {
        auth,
        continuationToken,
      });

      return Response.json({
        ok: true,
        sessionId: session.id,
        continuationToken,
      });
    }),
  ],
  events: {
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
        headers.authorization = `Bearer ${token}`;
      }
      try {
        const response = await fetch(callbackUrl, {
          method: "POST",
          headers,
          body: JSON.stringify({
            trigger: "form",
            sessionId: ctx.session.id,
            continuationToken: channel.continuationToken,
            message: data.message,
          }),
        });
        if (!response.ok) {
          console.error(
            `[form] callback delivery failed: HTTP ${response.status}`,
          );
        }
      } catch (error) {
        console.error("[form] callback delivery failed", error);
      }
    },
  },
});
