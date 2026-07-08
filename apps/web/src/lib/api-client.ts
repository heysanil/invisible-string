/**
 * Typed fetch wrapper over the control-plane API (packages/shared/src/api.ts
 * is the contract; this module owns transport only).
 *
 * - Base URL from `VITE_API_URL` via {@link resolveApiBaseUrl} (same source
 *   as lib/auth-client.ts); an empty string resolves to the page origin.
 * - `credentials: "include"` — the API authenticates via the Better Auth
 *   session cookie.
 * - Every response is zod-parsed against the shared schema for its endpoint;
 *   a shape mismatch is a bug surfaced as ApiError("invalid_response"),
 *   never a silent `any`.
 * - Non-2xx responses are decoded from the uniform control-plane error
 *   envelope (`{error: {code, message, details?}}`) into {@link ApiError}
 *   with the machine-readable `code` preserved (e.g. "session_busy",
 *   "model_not_allowlisted") so UI states can branch on it.
 */
import { apiErrorBodySchema } from "@invisible-string/shared";
import type { z } from "zod";

/** Empty VITE_API_URL (prod same-origin builds) resolves to the page origin
 *  so absolute-URL derivations (SSE, copilot WebSocket, Slack install links)
 *  keep working; unset keeps the localhost dev default. */
export function resolveApiBaseUrl(
  raw: string | undefined,
  pageOrigin: string,
): string {
  const base = raw ?? "http://localhost:3000";
  return base === "" ? pageOrigin : base;
}

export const API_BASE_URL: string = resolveApiBaseUrl(
  import.meta.env.VITE_API_URL,
  typeof window === "undefined" ? "http://localhost:3000" : window.location.origin,
);

/** Synthetic (non-HTTP) error codes the client itself produces. */
export const CLIENT_ERROR_CODES = {
  network: "network_error",
  invalidResponse: "invalid_response",
} as const;

export class ApiError extends Error {
  override readonly name = "ApiError";
  constructor(
    /** HTTP status; 0 for network-level failures. */
    readonly status: number,
    /** Stable machine-readable slug from the error envelope (or synthetic). */
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
  }
}

/** Narrow an unknown error to an ApiError with a specific code. */
export function isApiErrorCode(error: unknown, code: string): error is ApiError {
  return error instanceof ApiError && error.code === code;
}

export type QueryParams = Record<string, string | number | boolean | undefined>;

export interface RequestOptions {
  query?: QueryParams;
  signal?: AbortSignal;
  /** Test seam; defaults to the ambient fetch at call time. */
  fetchFn?: typeof fetch;
  /** Override base URL (tests, embedded tools). */
  baseUrl?: string;
}

export function buildApiUrl(
  path: string,
  query?: QueryParams,
  baseUrl: string = API_BASE_URL,
): URL {
  const url = new URL(path, baseUrl);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined) url.searchParams.set(key, String(value));
    }
  }
  return url;
}

interface InternalOptions extends RequestOptions {
  method: string;
  body?: unknown;
  form?: FormData;
}

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  options: InternalOptions,
): Promise<T> {
  const fetchFn = options.fetchFn ?? fetch;
  const url = buildApiUrl(path, options.query, options.baseUrl);

  const headers: Record<string, string> = { accept: "application/json" };
  let body: BodyInit | undefined;
  if (options.form !== undefined) {
    body = options.form; // fetch sets the multipart boundary itself
  } else if (options.body !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.body);
  }

  let response: Response;
  try {
    response = await fetchFn(url, {
      method: options.method,
      headers,
      body,
      credentials: "include",
      signal: options.signal,
    });
  } catch (error) {
    // Aborts propagate as-is so callers/TanStack can distinguish cancellation.
    if (error instanceof DOMException && error.name === "AbortError") throw error;
    throw new ApiError(
      0,
      CLIENT_ERROR_CODES.network,
      "Could not reach the server. Check your connection and try again.",
    );
  }

  if (!response.ok) {
    let payload: unknown;
    try {
      payload = await response.json();
    } catch {
      payload = undefined;
    }
    const envelope = apiErrorBodySchema.safeParse(payload);
    if (envelope.success) {
      const { code, message, details } = envelope.data.error;
      throw new ApiError(response.status, code, message, details);
    }
    throw new ApiError(
      response.status,
      `http_${response.status}`,
      `Request failed (${response.status}).`,
    );
  }

  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new ApiError(
      response.status,
      CLIENT_ERROR_CODES.invalidResponse,
      "The server returned a non-JSON response.",
    );
  }
  const parsed = schema.safeParse(payload);
  if (!parsed.success) {
    throw new ApiError(
      response.status,
      CLIENT_ERROR_CODES.invalidResponse,
      "The server response did not match the expected shape.",
      parsed.error.issues,
    );
  }
  return parsed.data;
}

/** Verb helpers. Every call names the shared response schema explicitly. */
export const api = {
  get<T>(path: string, schema: z.ZodType<T>, options: RequestOptions = {}) {
    return request(path, schema, { ...options, method: "GET" });
  },
  post<T>(
    path: string,
    schema: z.ZodType<T>,
    options: RequestOptions & { body?: unknown } = {},
  ) {
    return request(path, schema, { ...options, method: "POST" });
  },
  put<T>(
    path: string,
    schema: z.ZodType<T>,
    options: RequestOptions & { body?: unknown } = {},
  ) {
    return request(path, schema, { ...options, method: "PUT" });
  },
  patch<T>(
    path: string,
    schema: z.ZodType<T>,
    options: RequestOptions & { body?: unknown } = {},
  ) {
    return request(path, schema, { ...options, method: "PATCH" });
  },
  delete<T>(path: string, schema: z.ZodType<T>, options: RequestOptions = {}) {
    return request(path, schema, { ...options, method: "DELETE" });
  },
  /** Multipart upload (skill attachments). */
  postForm<T>(
    path: string,
    schema: z.ZodType<T>,
    form: FormData,
    options: RequestOptions = {},
  ) {
    return request(path, schema, { ...options, method: "POST", form });
  },
} as const;
