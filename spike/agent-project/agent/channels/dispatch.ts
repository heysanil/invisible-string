import { defineChannel, POST } from "eve/channels";
import { routeAuth } from "eve/channels/auth";

import { localDevUnlessDisabled, platformJwt } from "../lib/platform-auth.js";

interface DispatchBody {
  readonly message?: unknown;
  readonly continuationToken?: unknown;
}

/**
 * Custom trigger channel: the control-plane dispatcher POSTs a normalized
 * envelope here; the channel starts/continues the session via send() and owns
 * outbound delivery.
 *
 * ROUTE-PREFIX CONVENTION (locked for Phase-1 compiler templates): custom
 * channel routes mount at the RAW authored path (spike/REPORT.md friction 7),
 * so trigger channels are authored under `/eve/v1/platform/<trigger>` — a
 * path the worker proxy already forwards (`/eve/` prefix). The proxy needs
 * no extra prefix and the dispatcher→proxy→channel path is exercised
 * end-to-end in spike/tests/mocked.test.ts.
 */
export default defineChannel({
  routes: [
    POST("/eve/v1/platform/dispatch", async (req, { send }) => {
      const auth = await routeAuth(req, [platformJwt(), localDevUnlessDisabled()]);
      if (auth instanceof Response) return auth;

      const body = (await req.json().catch(() => null)) as DispatchBody | null;
      if (body === null || typeof body.message !== "string" || body.message.length === 0) {
        return Response.json({ error: "message required", ok: false }, { status: 400 });
      }
      const continuationToken =
        typeof body.continuationToken === "string" && body.continuationToken.length > 0
          ? body.continuationToken
          : `dispatch-${crypto.randomUUID()}`;

      const session = await send(body.message, { auth, continuationToken });

      return Response.json({ continuationToken, ok: true, sessionId: session.id });
    }),
  ],
});
