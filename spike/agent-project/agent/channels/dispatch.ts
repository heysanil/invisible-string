import { defineChannel, GET, POST } from "eve/channels";
import { routeAuth } from "eve/channels/auth";

import { localDevUnlessDisabled, platformJwt } from "../lib/platform-auth.js";

interface DispatchBody {
  readonly address?: unknown;
  readonly message?: unknown;
}

/**
 * Custom channel exercising eve 0.31's route-handler operation surface.
 *
 * MIGRATED FROM 0.19: the handler used to destructure a bare `send` out of
 * the second argument and pass `{ auth, continuationToken }` to it. 0.31
 * removed `send` from `RouteHandlerArgs` entirely (`RouteHandlerArgs<TState>`
 * now carries `from`, `resolveSession`, `attachSession`, `to`, `params`,
 * `waitUntil`, `requestIp`) and split the old single call into two handle
 * kinds:
 *
 *   - `from(address)` — DYNAMIC. Targets whichever durable session currently
 *     owns this channel-local address, and is the only op that may CREATE one
 *     (`send`). `respond`/`cancel`/`compact`/`clear`/`reset` never create.
 *     Channel-local continuation ADDRESSES still exist in 0.31 — it is the
 *     eve channel's HTTP wire protocol that dropped continuation tokens in
 *     favour of session ids, not the channel authoring API. The channel owns
 *     its address format; eve prepends the channel name (the file stem,
 *     `dispatch`) before handing it to the runtime.
 *   - `attachSession(sessionId)` — FIXED, I/O-free. Pinned to one durable
 *     session id forever; never creates, follows, or resolves a replacement.
 *
 * `resolveSession(address)` snapshots the address's current owner as a fixed
 * handle, which is what lets a caller convert address-continuity into a
 * session id (the platform's own dispatcher stores that id instead).
 *
 * ROUTE-PREFIX CONVENTION (still true on 0.31): custom channel routes mount
 * at the RAW authored path (spike/REPORT.md friction 7), so these live under
 * `/eve/v1/platform/…`, a path the worker proxy already forwards via its
 * `/eve/` prefix. Exercised end-to-end through the proxy in
 * spike/tests/mocked.test.ts.
 *
 * NOTE: this channel is SPIKE-ONLY. Compiler v3 emits no custom trigger
 * channels — compiled agents expose only eve's default channel. It exists to
 * keep the authoring surface under test so an eve bump that changes it fails
 * here rather than in generated code.
 */
export default defineChannel({
  routes: [
    POST("/eve/v1/platform/dispatch", async (req, { from }) => {
      const auth = await routeAuth(req, [platformJwt(), localDevUnlessDisabled()]);
      if (auth instanceof Response) return auth;

      const body = (await req.json().catch(() => null)) as DispatchBody | null;
      if (body === null || typeof body.message !== "string" || body.message.length === 0) {
        return Response.json({ error: "message required", ok: false }, { status: 400 });
      }

      // The channel owns its address format. A caller that supplies one gets
      // address continuity (a second dispatch to the same address lands on
      // the same durable session); one that omits it gets a fresh session.
      const address =
        typeof body.address === "string" && body.address.length > 0
          ? body.address
          : `dispatch-${crypto.randomUUID()}`;

      const session = await from(address).send(body.message, { auth });

      return Response.json({ address, ok: true, sessionId: session.id });
    }),

    // resolveSession(address): snapshot the address's CURRENT owner. Returns
    // undefined when no session owns the address, so this doubles as the
    // proof that `send` — and only `send` — creates one.
    GET("/eve/v1/platform/dispatch/:address", async (req, { params, resolveSession }) => {
      const auth = await routeAuth(req, [platformJwt(), localDevUnlessDisabled()]);
      if (auth instanceof Response) return auth;

      const session = await resolveSession(params.address ?? "");
      return Response.json({ ok: true, sessionId: session?.id ?? null });
    }),

    // attachSession(sessionId): fixed handle, no lookup. The first operation
    // reports whether the id is still active — an unknown or retired id
    // answers with a benign no-active status rather than throwing.
    POST("/eve/v1/platform/session/:sessionId/cancel", async (req, { attachSession, params }) => {
      const auth = await routeAuth(req, [platformJwt(), localDevUnlessDisabled()]);
      if (auth instanceof Response) return auth;

      const result = await attachSession(params.sessionId ?? "").cancel();
      return Response.json({ ok: true, result });
    }),
  ],
});
