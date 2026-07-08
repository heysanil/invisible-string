/**
 * api-client transport tests — mocked fetch via the fetchFn seam (no DOM,
 * no network). Covers zod-parsed success, error-envelope decoding, synthetic
 * error codes, and request assembly (credentials/query/body).
 */
import { describe, expect, test } from "bun:test";
import { z } from "zod";

import { api, ApiError, buildApiUrl, isApiErrorCode } from "../lib/api-client";

const okSchema = z.object({ hello: z.string() });

interface CapturedRequest {
  url: string;
  init: RequestInit | undefined;
}

function stubFetch(
  respond: (url: string, init?: RequestInit) => Response | Promise<Response>,
) {
  const calls: CapturedRequest[] = [];
  const fetchFn = (async (input: URL | RequestInfo, init?: RequestInit) => {
    const url =
      input instanceof Request ? input.url : String(input);
    calls.push({ url, init });
    return respond(url, init);
  }) as typeof fetch;
  return { fetchFn, calls };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("buildApiUrl", () => {
  test("joins base + path and skips undefined query params", () => {
    const url = buildApiUrl(
      "/workspaces/ws1/sessions",
      { workflowId: "wf1", status: undefined },
      "http://api.test",
    );
    expect(url.toString()).toBe(
      "http://api.test/workspaces/ws1/sessions?workflowId=wf1",
    );
  });
});

describe("api-client", () => {
  test("GET zod-parses the response and sends credentials", async () => {
    const { fetchFn, calls } = stubFetch(() => jsonResponse({ hello: "world" }));
    const result = await api.get("/greeting", okSchema, {
      fetchFn,
      baseUrl: "http://api.test",
    });
    expect(result.hello).toBe("world");
    expect(calls.length).toBe(1);
    expect(calls[0]!.url).toBe("http://api.test/greeting");
    expect(calls[0]!.init?.credentials).toBe("include");
    expect(calls[0]!.init?.method).toBe("GET");
  });

  test("POST serializes the JSON body with content-type", async () => {
    const { fetchFn, calls } = stubFetch(() => jsonResponse({ hello: "made" }));
    await api.post("/things", okSchema, {
      fetchFn,
      baseUrl: "http://api.test",
      body: { name: "thing" },
    });
    const init = calls[0]!.init!;
    expect(init.method).toBe("POST");
    expect(
      (init.headers as Record<string, string>)["content-type"],
    ).toBe("application/json");
    expect(init.body).toBe(JSON.stringify({ name: "thing" }));
  });

  test("control-plane error envelope surfaces code/message/details", async () => {
    const { fetchFn } = stubFetch(() =>
      jsonResponse(
        {
          error: {
            code: "session_busy",
            message: "session already has an active run",
          },
        },
        409,
      ),
    );
    const promise = api.post("/sessions/s1/messages", okSchema, {
      fetchFn,
      baseUrl: "http://api.test",
      body: { message: "hi" },
    });
    const error = await promise.catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    const apiError = error as ApiError;
    expect(apiError.status).toBe(409);
    expect(apiError.code).toBe("session_busy");
    expect(isApiErrorCode(error, "session_busy")).toBe(true);
    expect(isApiErrorCode(error, "other_code")).toBe(false);
  });

  test("non-envelope failure falls back to http_<status>", async () => {
    const { fetchFn } = stubFetch(
      () => new Response("upstream exploded", { status: 502 }),
    );
    const error = await api
      .get("/x", okSchema, { fetchFn, baseUrl: "http://api.test" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("http_502");
    expect((error as ApiError).status).toBe(502);
  });

  test("2xx with a shape mismatch is invalid_response, never a silent any", async () => {
    const { fetchFn } = stubFetch(() => jsonResponse({ nope: 1 }));
    const error = await api
      .get("/x", okSchema, { fetchFn, baseUrl: "http://api.test" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("invalid_response");
  });

  test("network failure maps to network_error with status 0", async () => {
    const fetchFn = (async () => {
      throw new TypeError("fetch failed");
    }) as unknown as typeof fetch;
    const error = await api
      .get("/x", okSchema, { fetchFn, baseUrl: "http://api.test" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ApiError);
    expect((error as ApiError).code).toBe("network_error");
    expect((error as ApiError).status).toBe(0);
  });

  test("aborts propagate untouched so query cancellation works", async () => {
    const fetchFn = (async () => {
      throw new DOMException("The operation was aborted.", "AbortError");
    }) as unknown as typeof fetch;
    const error = await api
      .get("/x", okSchema, { fetchFn, baseUrl: "http://api.test" })
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
  });
});

import { resolveApiBaseUrl } from "../lib/api-client";

describe("resolveApiBaseUrl", () => {
  test("unset keeps the dev default", () => {
    expect(resolveApiBaseUrl(undefined, "https://app.example.com")).toBe(
      "http://localhost:3000",
    );
  });

  test("empty string resolves to the page origin (same-origin prod builds)", () => {
    expect(resolveApiBaseUrl("", "https://app.example.com")).toBe(
      "https://app.example.com",
    );
  });

  test("an explicit URL wins", () => {
    expect(resolveApiBaseUrl("https://api.example.com", "https://app.example.com")).toBe(
      "https://api.example.com",
    );
  });
});
