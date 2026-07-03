/**
 * Request-scoped logging (docs/PLAN.md Phase 3 task 5).
 *
 * A global Elysia `derive` mints a `requestId` per inbound request (honoring an
 * inbound `x-request-id` so a correlation id set upstream — gateway, another
 * service — is preserved) and exposes a `reqLog` child logger bound to it, so
 * any handler can log with the request already correlated. A global
 * `onAfterHandle` closes each request with one `http.request` line carrying
 * method, path, status, and duration. The derived `requestId`/`reqLog` thread
 * the correlation id across the whole request lifecycle.
 */
import { randomUUID } from "node:crypto";

import { Elysia } from "elysia";
import type { Logger } from "@invisible-string/shared";

export function requestLoggerPlugin(logger: Logger) {
  return new Elysia({ name: "request-logger" })
    .derive({ as: "global" }, ({ request }) => {
      const requestId = request.headers.get("x-request-id")?.trim() || randomUUID();
      return {
        requestId,
        reqLog: logger.child({ fields: { requestId } }),
        reqStartedAt: performance.now(),
      };
    })
    .onAfterHandle(
      { as: "global" },
      ({ request, path, set, reqStartedAt, reqLog }) => {
        reqLog.info("http.request", {
          durationMs: Math.round(performance.now() - reqStartedAt),
          fields: {
            method: request.method,
            path,
            status: typeof set.status === "number" ? set.status : 200,
          },
        });
      },
    );
}
