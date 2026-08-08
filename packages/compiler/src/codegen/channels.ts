/**
 * Generated `agent/channels/eve.ts` — the ONLY channel a compiled agent has.
 *
 * The artifact is trigger-agnostic: chat AND workflow dispatch both ride the
 * default eve channel (the control-plane dispatcher renders workflow
 * instructions + trigger data into the task message, then drives eve's
 * ID-addressed session API — create, follow-up send XOR respond, and the
 * cancel/clear/compact/reset controls). Route auth is the platform JWT
 * (verifyJwtHmac AuthFn, `localDev()` only on dev builds); the `onMessage`
 * hook injects platform context blocks — PLAN correction 2:
 * `context: string[]` is an onMessage RETURN, not a send() option.
 *
 * RE-VERIFIED against eve@0.31.3's shipped `.d.ts` (dist/src/public/channels/
 * eve.d.ts + dist/src/channel/types.d.ts) — the emitted channel needs NO
 * change on this bump:
 * - `eveChannel` and `defaultEveAuth` are both still exported from
 *   `eve/channels/eve`; `defaultEveAuth(ctx)` still takes the
 *   `EveMessageContext`.
 * - `onMessage` widened to `(ctx, message) => EveMessageResultOrPromise`.
 *   The emitted 1-arg form remains assignable (a shorter parameter list
 *   always satisfies a longer signature), so we do NOT take the `message`
 *   argument we have no use for.
 * - The return shape is unchanged: `{ auth: SessionAuthContext | null;
 *   context?: readonly string[] }`.
 * - `ctx.eve.caller` is unchanged: `SessionAuthContext | null`, still
 *   carrying `principalId` / `principalType` (the two fields the emitted
 *   context block reads). `EveHandle` gained a `sessionId?` field, which
 *   this template does not need.
 * `EveChannelInput` also gained optional `cors`, `uploadPolicy`,
 * `trustedForwarders` and `events`. All are omitted deliberately: the agent
 * is only ever reached through the worker proxy behind a platform JWT, and
 * `trustedForwarders` in particular must stay unset so every
 * `forwardedPrincipal` assertion is rejected with 403.
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
