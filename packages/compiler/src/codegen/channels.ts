/**
 * Generated `agent/channels/eve.ts` — the ONLY channel a compiled agent has.
 *
 * The artifact is trigger-agnostic: chat AND workflow dispatch both ride the
 * default eve channel (the control-plane dispatcher renders workflow
 * instructions + trigger data into the task message before
 * `createEveSession`/`continueEveSession`). Route auth is the platform JWT
 * (verifyJwtHmac AuthFn, `localDev()` only on dev builds); the `onMessage`
 * hook injects platform context blocks — PLAN correction 2:
 * `context: string[]` is an onMessage RETURN, not a send() option.
 */
import type { CompileDeps } from "../types";
import { tsString } from "./strings";

export function emitEveChannel(deps: CompileDeps): string {
  const identity = `Platform agent ${tsString(deps.agentSlug)} in workspace ${tsString(deps.workspaceSlug)} (invisible-string).`;
  return `import { defaultEveAuth, eveChannel } from "eve/channels/eve";

import { platformAuth } from "../lib/platform-auth.js";

/**
 * Default HTTP channel (chat AND workflow-dispatched sessions). Route auth
 * is the platform JWT; onMessage injects platform context blocks — context
 * is an onMessage return, never a send() option.
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
