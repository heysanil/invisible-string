import { defaultEveAuth, eveChannel } from "eve/channels/eve";

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
    const context = ["Platform workflow \"helpdesk\" in workspace \"acme\" (invisible-string)."];
    if (caller !== null) {
      context.push(
        `Caller principal: ${caller.principalId} (${caller.principalType}).`,
      );
    }
    return { auth: defaultEveAuth(ctx), context };
  },
});
