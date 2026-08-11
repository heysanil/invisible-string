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
 * message carries only `{type, ok, connectionId}`.
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

import { api, API_BASE_URL } from "../api-client";
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
        | { type?: unknown; ok?: unknown; connectionId?: unknown }
        | null
        | undefined;
      if (!data || data.type !== "mcp-oauth") return;
      if (data.connectionId != null && data.connectionId !== connectionId) return;
      finish({ ok: data.ok === true, dismissed: false });
    };
    window.addEventListener("message", onMessage);
    const closePoll = window.setInterval(() => {
      if (!popup.closed) return;
      window.clearInterval(closePoll);
      window.setTimeout(() => finish({ ok: false, dismissed: true }), 250);
    }, 400);
  });
}

/**
 * The full consent dance for an existing oauth connection: start → navigate
 * the caller-opened popup → await the callback's message → invalidate the
 * connection (grant state, health, probe results all changed server-side).
 * Throws on start/transport errors (the caller toasts); resolves the outcome
 * otherwise — `dismissed` deserves no error UI.
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
