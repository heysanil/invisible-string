/**
 * Shared harness for provider-wrapped component tests: a route-based fetch
 * mock plus a render helper that supplies a fresh QueryClient and the toast
 * provider (mutations toast on error, so components need it mounted).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, type RenderResult } from "@testing-library/react";
import type { ReactNode } from "react";

import { ToastProvider } from "../components/ui/Toast";

export interface RecordedRequest {
  method: string;
  url: string;
  path: string;
  body: unknown;
}

export type Responder = (request: RecordedRequest) => Response;

interface Route {
  method: string;
  match: (path: string) => boolean;
  responder: Responder;
}

export interface FetchMock {
  /** Register a handler; later registrations win (override defaults). */
  on(method: string, matcher: string | RegExp, responder: Responder): FetchMock;
  readonly calls: RecordedRequest[];
  restore(): void;
}

export function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

export function installFetchMock(): FetchMock {
  const routes: Route[] = [];
  const calls: RecordedRequest[] = [];
  const realFetch = globalThis.fetch;

  function toMatcher(matcher: string | RegExp): (path: string) => boolean {
    if (matcher instanceof RegExp) return (path) => matcher.test(path);
    return (path) => path.includes(matcher);
  }

  globalThis.fetch = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const method = (init?.method ?? "GET").toUpperCase();
    const path = new URL(url, "http://localhost").pathname;
    let body: unknown;
    if (typeof init?.body === "string") {
      try {
        body = JSON.parse(init.body);
      } catch {
        body = init.body;
      }
    } else if (init?.body !== undefined) {
      body = init.body; // FormData etc.
    }
    const request: RecordedRequest = { method, url, path, body };
    calls.push(request);

    // Last matching route wins.
    for (let i = routes.length - 1; i >= 0; i--) {
      const route = routes[i]!;
      if (route.method === method && route.match(path)) {
        return route.responder(request);
      }
    }
    return jsonResponse(
      { error: { code: "not_mocked", message: `No mock for ${method} ${path}` } },
      500,
    );
  }) as typeof fetch;

  const mock: FetchMock = {
    on(method, matcher, responder) {
      routes.push({ method: method.toUpperCase(), match: toMatcher(matcher), responder });
      return mock;
    },
    calls,
    restore() {
      globalThis.fetch = realFetch;
    },
  };
  return mock;
}

export function renderWithProviders(ui: ReactNode): RenderResult & {
  queryClient: QueryClient;
} {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0 },
      mutations: { retry: false },
    },
  });
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
  return Object.assign(view, { queryClient });
}
