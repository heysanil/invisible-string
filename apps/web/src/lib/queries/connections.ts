/**
 * Connection hooks (rebuilt connections domain, connectors redesign spec §3)
 * — BOTH scopes (workspace + user) behind one {@link ScopeRef}. One create
 * route covers all three sources (`catalog` | `registry` | `custom`);
 * credential writes travel in the request `auth` field and are encrypted
 * server-side — reads only ever carry `hasCredentials`.
 *
 * `useToggleConnection` is optimistic (a capsule switch must not lag): the
 * list cache flips immediately, rolls back on error, and reconciles on
 * settle.
 *
 * OAuth consent (spec §6): {@link useStartOauth} POSTs the broker's start
 * route for the authorization URL; {@link useConnectOauth} composes it with
 * the popup dance — the caller opens the popup synchronously in the click
 * handler ({@link openOauthPopup}, popup blockers), the hook navigates it and
 * waits for the callback page's `postMessage` (origin-checked against the API
 * origin that served the callback), then invalidates the connection so the
 * fresh grant state renders. No OAuth material ever reaches the SPA — the
 * message carries only `{type, ok, connectionId, reason}`, where `reason` is
 * a sanitized machine code, never an error string from an authorization
 * server.
 *
 * This module also owns the two halves of that flow the SPA is solely
 * responsible for (2026-08-31 fix plan):
 *  - {@link isSafeAuthorizeUrl} (F3) — the last check before a server-chosen
 *    string becomes a navigation in a window that inherits this origin;
 *  - {@link oauthFailureCopy} / {@link oauthErrorCopy} (F9) — the failure
 *    vocabulary, so every surface answers "why, and what now?" with the same
 *    words instead of inventing its own generic sentence.
 */
import {
  useMutation,
  useQuery,
  useQueryClient,
  type QueryClient,
} from "@tanstack/react-query";
import {
  createConnectionResponseSchema,
  deleteResourceResponseSchema,
  getConnectionResponseSchema,
  listConnectionsResponseSchema,
  startOauthResponseSchema,
  type CreateConnectionRequest,
  type GetConnectionResponse,
  type ListConnectionsResponse,
  type UpdateConnectionRequest,
} from "@invisible-string/shared";

import { ApiError, api, API_BASE_URL } from "../api-client";
import { errorMessage } from "../forms";
import { queryKeys, scopeBasePath, type ScopeRef } from "./keys";

const basePath = (ref: ScopeRef) => scopeBasePath(ref, "connections");

// ── fetchers ────────────────────────────────────────────────────────────────

export function fetchConnections(ref: ScopeRef, signal?: AbortSignal) {
  return api.get(basePath(ref), listConnectionsResponseSchema, { signal });
}

export function fetchConnection(
  ref: ScopeRef,
  connectionId: string,
  signal?: AbortSignal,
) {
  return api.get(
    `${basePath(ref)}/${connectionId}`,
    getConnectionResponseSchema,
    { signal },
  );
}

// ── invalidation ────────────────────────────────────────────────────────────

export function invalidateConnections(
  queryClient: QueryClient,
  ref: ScopeRef,
): Promise<void> {
  return queryClient.invalidateQueries({
    queryKey: queryKeys.connections.all(ref),
  });
}

// ── queries ─────────────────────────────────────────────────────────────────

export function useConnections(ref: ScopeRef) {
  return useQuery({
    queryKey: queryKeys.connections.list(ref),
    queryFn: ({ signal }) => fetchConnections(ref, signal),
    select: (data) => data.connections,
    staleTime: 60_000,
  });
}

export function useConnection(ref: ScopeRef, connectionId: string) {
  return useQuery({
    queryKey: queryKeys.connections.detail(ref, connectionId),
    queryFn: ({ signal }) => fetchConnection(ref, connectionId, signal),
    select: (data) => data.connection,
    staleTime: 60_000,
  });
}

// ── mutations ───────────────────────────────────────────────────────────────

function seedDetail(
  queryClient: QueryClient,
  ref: ScopeRef,
  data: GetConnectionResponse,
) {
  queryClient.setQueryData<GetConnectionResponse>(
    queryKeys.connections.detail(ref, data.connection.id),
    data,
  );
}

/**
 * Create a connection — catalog install, registry install, or custom URL.
 * OAuth creates additionally return `oauthStartPath` so the caller can chain
 * straight into the consent popup ({@link useConnectOauth}).
 */
export function useCreateConnection(ref: ScopeRef) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateConnectionRequest) =>
      api.post(basePath(ref), createConnectionResponseSchema, { body: input }),
    onSuccess: async (data) => {
      seedDetail(queryClient, ref, { connection: data.connection });
      await invalidateConnections(queryClient, ref);
    },
  });
}

export function useUpdateConnection(ref: ScopeRef) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      connectionId: string;
      patch: UpdateConnectionRequest;
    }) =>
      api.patch(
        `${basePath(ref)}/${input.connectionId}`,
        getConnectionResponseSchema,
        { body: input.patch },
      ),
    onSuccess: async (data) => {
      seedDetail(queryClient, ref, data);
      await invalidateConnections(queryClient, ref);
    },
  });
}

export function useDeleteConnection(ref: ScopeRef) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (connectionId: string) =>
      api.delete(
        `${basePath(ref)}/${connectionId}`,
        deleteResourceResponseSchema,
      ),
    onSuccess: async (data) => {
      queryClient.removeQueries({
        queryKey: queryKeys.connections.detail(ref, data.id),
      });
      await invalidateConnections(queryClient, ref);
    },
  });
}

/**
 * Manual "Test connection" (and the detail's stale auto re-probe): POST the
 * probe route, which dials the server NOW, persists the health columns and
 * returns the fresh DTO — seeded into the detail cache so the health panel
 * re-renders without a refetch race.
 */
export function useProbeConnection(ref: ScopeRef) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (connectionId: string) =>
      api.post(
        `${basePath(ref)}/${connectionId}/probe`,
        getConnectionResponseSchema,
      ),
    onSuccess: async (data) => {
      seedDetail(queryClient, ref, data);
      await invalidateConnections(queryClient, ref);
    },
  });
}

// ── OAuth consent flow ──────────────────────────────────────────────────────

/**
 * The slice of `Window` the popup flow drives — structural so tests can pass
 * a plain object and callers can pass `window.open`'s result unchanged.
 */
export interface OauthPopupHandle {
  closed: boolean;
  location: { replace(url: string): void };
  close(): void;
}

export interface OauthConnectOutcome {
  /** The callback page reported a completed, successful grant. */
  ok: boolean;
  /** The user closed the popup without finishing consent — not an error. */
  dismissed: boolean;
  /**
   * Sanitized failure code from the callback page (F9), or null on success or
   * a dismissal. Render it through {@link oauthFailureCopy} — never print the
   * code itself; it is a routing key, not a sentence.
   */
  reason: string | null;
}

// ── consent failures ────────────────────────────────────────────────────────

/**
 * The SPA's own refusal code (F3). It is not a server contract — it never
 * crosses the wire in either direction — but it travels the same path as one
 * so that every consent failure, wherever it originates, reaches the UI as a
 * code the copy table can answer.
 */
export const OAUTH_UNSAFE_URL_CODE = "oauth_unsafe_authorize_url";

const UNSAFE_AUTHORIZE_URL_COPY =
  "That server asked the browser to open an unsafe sign-in address, so nothing was opened. Check the server URL — a trustworthy server always signs in over https.";

/**
 * Why a consent attempt failed, in words a reader can act on (F9). Two
 * unrelated transports feed the SAME table, deliberately:
 *
 *  - the callback page's `postMessage` carries a sanitized `reason` minted by
 *    the broker (`oauth_state_invalid`, `oauth_exchange_failed`,
 *    `not_initiator`, `forbidden`, `unauthenticated`, `oauth_internal_error`);
 *  - a `POST …/oauth/start` failure never reaches the popup at all — it is an
 *    {@link ApiError} whose `code` names discovery or client-registration
 *    trouble (`oauth_discovery_failed`, `oauth_registration_failed`).
 *
 * They are two answers to one question — "why did my sign-in fail, and what
 * do I do now?" — so one table answers both, and every surface says the same
 * thing. Before this, both collapsed into a single "Authorization failed",
 * which is the same sentence for "you declined", "this deployment can never
 * register with that provider" and "someone else started this flow" — three
 * different next actions.
 *
 * Codes are stable server contract; an unmapped one degrades to prose rather
 * than leaking a slug at a user (the broker sanitizes `reason` so it is SAFE
 * to render, not so it is meaningful to read).
 */
export const OAUTH_FAILURE_COPY: Record<string, string> = {
  oauth_state_invalid:
    "That sign-in window expired or was already used. Start the connection again to get a fresh one.",
  oauth_exchange_failed:
    "The authorization server did not issue a token — access may have been declined, or the server may be having trouble. Try connecting again.",
  not_initiator:
    "This sign-in was started by someone else. Start it yourself, then finish it in the window that opens.",
  forbidden:
    "You do not have permission to authorize this connection. Ask a workspace admin or owner to connect it.",
  unauthenticated:
    "Your session ended before the sign-in finished. Sign in again, then reconnect.",
  oauth_discovery_failed:
    "This server did not advertise an OAuth configuration we can use. Check the server URL, or ask whoever runs it whether it supports OAuth sign-in.",
  oauth_registration_failed:
    "The authorization server refused to register this app — it only accepts pre-approved clients, so this connector cannot finish sign-in from here.",
  encryption_key_missing:
    "This deployment cannot store credentials yet — its encryption key is not configured. Ask an administrator to set one.",
  oauth_internal_error:
    "Something went wrong while authorizing. Try connecting again.",
  [OAUTH_UNSAFE_URL_CODE]: UNSAFE_AUTHORIZE_URL_COPY,
};

const OAUTH_FAILURE_FALLBACK =
  "Authorization did not finish. Try connecting again.";

/** Copy for a callback `reason` code (null/unknown → the neutral fallback). */
export function oauthFailureCopy(reason: string | null | undefined): string {
  if (reason == null) return OAUTH_FAILURE_FALLBACK;
  return OAUTH_FAILURE_COPY[reason] ?? OAUTH_FAILURE_FALLBACK;
}

/**
 * Copy for a THROWN consent error — the start route's typed failures plus the
 * SPA's own refusal. An {@link ApiError} whose code we have no entry for keeps
 * its server message (`invalid_body`'s "connection does not use OAuth", say):
 * the server said something specific and true, and replacing it with the
 * fallback would be a downgrade.
 */
export function oauthErrorCopy(error: unknown): string {
  const mapped =
    error instanceof ApiError ? OAUTH_FAILURE_COPY[error.code] : undefined;
  return mapped ?? errorMessage(error, OAUTH_FAILURE_FALLBACK);
}

/**
 * F3 — the SPA is the LAST hop before a server-chosen string becomes a
 * navigation. `authorizeUrl` is assembled from the authorization server's own
 * metadata, which for a CUSTOM connector is controlled end to end by whoever
 * supplied the URL; the popup about to be driven was opened by this document,
 * so a `javascript:` URL would execute in a window inheriting this origin —
 * session cookie, API, everything. The control plane validates the scheme at
 * discovery (fix plan P0.1) and this is the second, independent lock: neither
 * is a substitute for the other, and `startOauthResponseSchema`'s `z.url()`
 * is no lock at all (it accepts `javascript:` and `data:` happily).
 *
 * `https:` anywhere, plus `http:` on loopback ONLY — the line browsers
 * themselves draw for secure contexts, and the analogue of the control
 * plane's `MCP_PROBE_ALLOW_PRIVATE` relaxation for local stacks (an env
 * switch a browser bundle cannot see, which is why the rule is expressed as
 * loopback rather than a flag). Everything else refuses: other schemes, plain
 * http to a public host, and anything the URL parser rejects outright.
 */
export function isSafeAuthorizeUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol === "https:") return true;
  return (
    url.protocol === "http:" &&
    (url.hostname === "localhost" ||
      url.hostname === "127.0.0.1" ||
      url.hostname === "[::1]")
  );
}

/**
 * Open the consent popup NOW, in the click handler's task — popup blockers
 * refuse windows opened after an await. The caller hands the (still-blank)
 * window to {@link useConnectOauth}, which navigates it once the start route
 * answers.
 */
export function openOauthPopup(): OauthPopupHandle | null {
  return window.open("about:blank", "mcp-oauth-consent", "popup,width=600,height=720");
}

/** `POST …/connections/:id/oauth/start` → the authorization URL (spec §6). */
export function useStartOauth(ref: ScopeRef) {
  return useMutation({
    mutationFn: (connectionId: string) =>
      api.post(
        `${basePath(ref)}/${connectionId}/oauth/start`,
        startOauthResponseSchema,
      ),
  });
}

/**
 * Wait for the callback page's `postMessage`. Origin-checked against the API
 * origin — the callback document is served by the control plane (same origin
 * as the SPA in production's single-origin gateway). Messages for other
 * connections are ignored; a failure message may carry `connectionId: null`
 * (state lookup failed before the row was known), which still settles THIS
 * flow as failed. Closing the popup without completing resolves `dismissed`
 * after a grace beat (the callback posts before `window.close()`, so a
 * queued success message wins over the close poll).
 *
 * `reason` is read defensively as an unknown: it arrives from a document this
 * code did not render (an older control plane predating F9 sends none at
 * all), so anything that is not a string settles as no reason and falls back
 * to neutral copy.
 */
function waitForOauthOutcome(
  popup: OauthPopupHandle,
  connectionId: string,
): Promise<OauthConnectOutcome> {
  const expectedOrigin = new URL(API_BASE_URL).origin;
  return new Promise((resolve) => {
    let settled = false;
    const finish = (outcome: OauthConnectOutcome) => {
      if (settled) return;
      settled = true;
      window.clearInterval(closePoll);
      window.removeEventListener("message", onMessage);
      resolve(outcome);
    };
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== expectedOrigin) return;
      const data = event.data as
        | { type?: unknown; ok?: unknown; connectionId?: unknown; reason?: unknown }
        | null
        | undefined;
      if (!data || data.type !== "mcp-oauth") return;
      if (data.connectionId != null && data.connectionId !== connectionId) return;
      const ok = data.ok === true;
      finish({
        ok,
        dismissed: false,
        reason: !ok && typeof data.reason === "string" ? data.reason : null,
      });
    };
    window.addEventListener("message", onMessage);
    const closePoll = window.setInterval(() => {
      if (!popup.closed) return;
      window.clearInterval(closePoll);
      window.setTimeout(
        () => finish({ ok: false, dismissed: true, reason: null }),
        250,
      );
    }, 400);
  });
}

/**
 * The full consent dance for an existing oauth connection: start → CHECK the
 * authorization URL's scheme (F3) → navigate the caller-opened popup → await
 * the callback's message → invalidate the connection (grant state, health,
 * probe results all changed server-side).
 *
 * Throws on start/transport errors and on a refused URL — every one of them
 * carries a code {@link oauthErrorCopy} can turn into a sentence; resolves the
 * outcome otherwise, where `dismissed` deserves no error UI and a failed
 * outcome carries its `reason`.
 */
export function useConnectOauth(ref: ScopeRef) {
  const queryClient = useQueryClient();
  const start = useStartOauth(ref);
  return useMutation({
    mutationFn: async (input: {
      connectionId: string;
      popup: OauthPopupHandle | null;
    }): Promise<OauthConnectOutcome> => {
      const { connectionId, popup } = input;
      if (popup === null) {
        throw new Error(
          "The browser blocked the sign-in popup. Allow popups for this site and try again.",
        );
      }
      try {
        const { authorizeUrl } = await start.mutateAsync(connectionId);
        if (!isSafeAuthorizeUrl(authorizeUrl)) {
          // Status 0 marks a non-HTTP failure, as it does for the client's own
          // `network_error`/`invalid_response` codes: nothing was refused by a
          // server, this document refused to navigate.
          throw new ApiError(0, OAUTH_UNSAFE_URL_CODE, UNSAFE_AUTHORIZE_URL_COPY);
        }
        popup.location.replace(authorizeUrl);
      } catch (error) {
        popup.close();
        throw error;
      }
      return waitForOauthOutcome(popup, connectionId);
    },
    onSettled: () => invalidateConnections(queryClient, ref),
  });
}

/** Optimistic enable/disable toggle. */
export function useToggleConnection(ref: ScopeRef) {
  const queryClient = useQueryClient();
  const listKey = queryKeys.connections.list(ref);
  return useMutation({
    mutationFn: (input: { connectionId: string; enabled: boolean }) =>
      api.patch(
        `${basePath(ref)}/${input.connectionId}`,
        getConnectionResponseSchema,
        { body: { enabled: input.enabled } },
      ),
    onMutate: async (input) => {
      await queryClient.cancelQueries({ queryKey: listKey });
      const previous =
        queryClient.getQueryData<ListConnectionsResponse>(listKey);
      queryClient.setQueryData<ListConnectionsResponse>(listKey, (current) =>
        current === undefined
          ? current
          : {
              connections: current.connections.map((connection) =>
                connection.id === input.connectionId
                  ? { ...connection, enabled: input.enabled }
                  : connection,
              ),
            },
      );
      return { previous };
    },
    onError: (_error, _input, context) => {
      if (context?.previous !== undefined) {
        queryClient.setQueryData(listKey, context.previous);
      }
    },
    onSettled: () => invalidateConnections(queryClient, ref),
  });
}
