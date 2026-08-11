/**
 * Guarded egress fetch — the ONLY module allowed to fetch caller-influenced
 * URLs from the control plane (connectors redesign spec §7 SSRF policy).
 * Consumers: the MCP probe and (Plan 3) the entire OAuth broker. Exempt, by
 * design: the registry proxy (single hardcoded host) and the Meilisearch
 * client (operator-configured host).
 *
 * Per request:
 *  1. Parse the URL; refuse non-https schemes unless `allowPrivate`.
 *  2. DNS-resolve the hostname (`dns.promises.lookup({ all: true })`) and
 *     validate EVERY resolved address against {@link isForbiddenIp} (unless
 *     `allowPrivate`).
 *  3. Issue the request over `node:http(s)` with the socket PINNED to a
 *     validated IP (`host: <ip>`) while TLS still verifies the real hostname
 *     (`servername` + a `host` header) — resolve-validate-then-refetch-by-
 *     hostname would be a DNS-rebinding TOCTOU.
 *  4. Follow redirects only same-origin, re-running the FULL guard per hop,
 *     capped at `maxRedirects`.
 *  5. Stream the response through a byte-counting TransformStream that aborts
 *     past `maxResponseBytes` — streaming is preserved (Plan 3's SSE
 *     consumers need it), so the cap surfaces as a body-read error, not a
 *     rejected fetch.
 *
 * The timeout covers connect + response headers only: long-lived streaming
 * bodies (SSE) must not be killed by a total-deadline timer. Callers own
 * body-read deadlines.
 */
import { lookup } from "node:dns/promises";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";

export interface GuardedFetchOptions {
  /**
   * MCP_PROBE_ALLOW_PRIVATE: skips the private/loopback IP rejection AND
   * permits plain `http:` targets (dev/e2e/self-hosted stubs on 127.0.0.1).
   */
  allowPrivate: boolean;
  /** Connect + response-headers deadline. Default 10_000. */
  timeoutMs?: number;
  /** Response body cap; the body stream errors past it. Default 5_000_000. */
  maxResponseBytes?: number;
  /** Redirect-hop cap (same-origin only, full guard re-run per hop). Default 3. */
  maxRedirects?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RESPONSE_BYTES = 5_000_000;
const DEFAULT_MAX_REDIRECTS = 3;

// The control-plane tsconfig has no DOM lib, so the WHATWG aliases
// (RequestInfo/RequestRedirect/BodyInit) are derived from what IS global.
type FetchInput = Parameters<typeof fetch>[0];
type RedirectMode = NonNullable<RequestInit["redirect"]>;
type FetchBody = NonNullable<RequestInit["body"]>;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Thrown when the guard refuses a request (never for ordinary network failures). */
export class EgressBlockedError extends Error {
  readonly reason: string;

  constructor(reason: string, message?: string) {
    super(message ?? reason);
    this.name = "EgressBlockedError";
    this.reason = reason;
  }
}

/**
 * True when the IP must never be dialed from the control plane on behalf of a
 * caller: v4 10/8, 172.16/12, 192.168/16, 127/8, 0/8, 169.254/16, 100.64/10;
 * v6 loopback/unspecified, fc00::/7, fe80::/10; `::ffff:` v4-mapped forms
 * re-checked as v4. Unparseable input is forbidden (fail closed).
 */
export function isForbiddenIp(ip: string): boolean {
  const normalized = ip.trim().toLowerCase();
  const v4 = isForbiddenIpv4(normalized);
  if (v4 !== null) return v4;

  const hextets = parseIpv6(normalized);
  if (!hextets) return true; // not an IP at all — fail closed

  // ::ffff:a.b.c.d (or hex form) — re-check the embedded v4.
  if (hextets.slice(0, 5).every((h) => h === 0) && hextets[5] === 0xffff) {
    const hi = hextets[6]!;
    const lo = hextets[7]!;
    const mapped = `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
    return isForbiddenIpv4(mapped) ?? true;
  }

  const allZeroPrefix = hextets.slice(0, 7).every((h) => h === 0);
  if (allZeroPrefix && (hextets[7] === 0 || hextets[7] === 1)) {
    return true; // :: (unspecified) and ::1 (loopback)
  }

  const first = hextets[0]!;
  if ((first & 0xfe00) === 0xfc00) return true; // fc00::/7 unique-local
  if ((first & 0xffc0) === 0xfe80) return true; // fe80::/10 link-local
  return false;
}

/** null = not a v4 literal; otherwise the verdict. */
function isForbiddenIpv4(ip: string): boolean | null {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(ip);
  if (!match) return null;
  const octets = match.slice(1).map(Number);
  if (octets.some((o) => o > 255)) return null;
  const [a, b] = octets as [number, number, number, number];
  if (a === 0 || a === 10 || a === 127) return true; // 0/8, 10/8, 127/8
  if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12
  if (a === 192 && b === 168) return true; // 192.168/16
  if (a === 169 && b === 254) return true; // 169.254/16 link-local
  if (a === 100 && b >= 64 && b <= 127) return true; // 100.64/10 CGNAT
  return false;
}

/** Expand an IPv6 literal into its 8 hextets; null when malformed. */
function parseIpv6(raw: string): number[] | null {
  let ip = raw;
  const zone = ip.indexOf("%");
  if (zone !== -1) ip = ip.slice(0, zone); // fe80::1%eth0

  // Rewrite an embedded dotted-quad tail (::ffff:10.0.0.1) into hextets.
  const lastColon = ip.lastIndexOf(":");
  if (lastColon !== -1 && ip.slice(lastColon + 1).includes(".")) {
    const quad = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(
      ip.slice(lastColon + 1),
    );
    if (!quad) return null;
    const octets = quad.slice(1).map(Number);
    if (octets.some((o) => o > 255)) return null;
    const hi = ((octets[0]! << 8) | octets[1]!).toString(16);
    const lo = ((octets[2]! << 8) | octets[3]!).toString(16);
    ip = `${ip.slice(0, lastColon + 1)}${hi}:${lo}`;
  }

  const halves = ip.split("::");
  if (halves.length > 2) return null;
  const head = halves[0] === "" ? [] : halves[0]!.split(":");
  const tail =
    halves.length === 2 && halves[1] !== "" ? halves[1]!.split(":") : [];
  if (halves.length === 1) {
    if (head.length !== 8) return null;
  } else if (head.length + tail.length > 7) {
    return null; // "::" must stand for at least one zero group
  }

  const groups: number[] = [];
  for (const part of head) {
    const value = parseHextet(part);
    if (value === null) return null;
    groups.push(value);
  }
  for (let i = head.length + tail.length; i < 8; i++) groups.push(0);
  for (const part of tail) {
    const value = parseHextet(part);
    if (value === null) return null;
    groups.push(value);
  }
  return groups.length === 8 ? groups : null;
}

function parseHextet(part: string): number | null {
  return /^[0-9a-f]{1,4}$/.test(part) ? parseInt(part, 16) : null;
}

/**
 * Build a WHATWG-fetch-compatible function enforcing the egress guard.
 * Request bodies are buffered (guard consumers send small JSON-RPC frames);
 * response bodies stream.
 */
export function createGuardedFetch(opts: GuardedFetchOptions): typeof fetch {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxResponseBytes = opts.maxResponseBytes ?? DEFAULT_MAX_RESPONSE_BYTES;
  const maxRedirects = opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS;

  const guardedFetch = async (
    input: FetchInput,
    init?: RequestInit,
  ): Promise<Response> => {
    const normalized = await normalizeRequest(input, init);
    let { method, body } = normalized;
    const { headers, redirect, signal } = normalized;
    let url = normalized.url;
    let redirects = 0;

    for (;;) {
      const nodeRes = await issueGuardedHop({
        url,
        method,
        headers,
        body,
        allowPrivate: opts.allowPrivate,
        timeoutMs,
        signal,
      });
      const status = nodeRes.statusCode ?? 0;

      if (REDIRECT_STATUSES.has(status) && redirect === "follow") {
        const location = nodeRes.headers.location;
        if (location !== undefined) {
          nodeRes.resume(); // drain the redirect body; we never surface it
          if (redirects >= maxRedirects) {
            throw new EgressBlockedError(
              "too_many_redirects",
              `refused to follow more than ${maxRedirects} redirects`,
            );
          }
          redirects += 1;
          const next = new URL(location, url);
          if (next.origin !== url.origin) {
            throw new EgressBlockedError(
              "cross_origin_redirect",
              `cross-origin redirect refused: ${url.origin} -> ${next.origin}`,
            );
          }
          if (
            status === 303 ||
            ((status === 301 || status === 302) &&
              method !== "GET" &&
              method !== "HEAD")
          ) {
            method = "GET";
            body = null;
            headers.delete("content-type");
          }
          url = next;
          continue; // full guard re-runs on the next hop
        }
      }
      if (REDIRECT_STATUSES.has(status) && redirect === "error") {
        nodeRes.resume();
        throw new EgressBlockedError(
          "redirect_not_allowed",
          `redirect received with redirect mode "error"`,
        );
      }

      return buildResponse(nodeRes, method, maxResponseBytes);
    }
  };

  return guardedFetch as typeof fetch;
}

interface NormalizedRequest {
  url: URL;
  method: string;
  headers: Headers;
  body: Uint8Array | null;
  redirect: RedirectMode;
  signal: AbortSignal | undefined;
}

async function normalizeRequest(
  input: FetchInput,
  init: RequestInit | undefined,
): Promise<NormalizedRequest> {
  if (typeof input === "object" && input instanceof Request) {
    const headers = new Headers(init?.headers ?? input.headers);
    const rawBody = init?.body !== undefined ? init.body : null;
    let body: Uint8Array | null;
    if (rawBody !== null) {
      body = await bodyToBytes(rawBody, headers);
    } else if (input.body !== null) {
      body = new Uint8Array(await input.clone().arrayBuffer());
    } else {
      body = null;
    }
    return {
      url: new URL(input.url),
      method: (init?.method ?? input.method).toUpperCase(),
      headers,
      body,
      redirect: init?.redirect ?? input.redirect ?? "follow",
      signal: init?.signal ?? input.signal ?? undefined,
    };
  }

  const headers = new Headers(init?.headers);
  return {
    url: input instanceof URL ? new URL(input.href) : new URL(input),
    method: (init?.method ?? "GET").toUpperCase(),
    headers,
    body:
      init?.body !== undefined && init.body !== null
        ? await bodyToBytes(init.body, headers)
        : null,
    redirect: init?.redirect ?? "follow",
    signal: init?.signal ?? undefined,
  };
}

/**
 * Buffer any BodyInit via a carrier Response (which also derives the
 * content-type for FormData/URLSearchParams bodies when the caller set none).
 */
async function bodyToBytes(
  body: FetchBody,
  headers: Headers,
): Promise<Uint8Array> {
  const carrier = new Response(body);
  const bytes = new Uint8Array(await carrier.arrayBuffer());
  const contentType = carrier.headers.get("content-type");
  if (contentType && !headers.has("content-type")) {
    headers.set("content-type", contentType);
  }
  return bytes;
}

interface HopInput {
  url: URL;
  method: string;
  headers: Headers;
  body: Uint8Array | null;
  allowPrivate: boolean;
  timeoutMs: number;
  signal: AbortSignal | undefined;
}

/** One origin-hop: scheme guard, DNS resolve + IP validation, pinned request. */
async function issueGuardedHop(hop: HopInput): Promise<http.IncomingMessage> {
  const { url, allowPrivate } = hop;

  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new EgressBlockedError(
      "unsupported_protocol",
      `refusing non-http(s) scheme "${url.protocol}"`,
    );
  }
  if (url.protocol === "http:" && !allowPrivate) {
    throw new EgressBlockedError(
      "insecure_protocol",
      "plain http egress requires MCP_PROBE_ALLOW_PRIVATE",
    );
  }

  // URL.hostname keeps IPv6 brackets; dns.lookup wants them stripped. IP
  // literals pass through lookup unchanged, so there is exactly one path.
  const hostname = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = await lookup(hostname, { all: true, verbatim: true });
  if (addresses.length === 0) {
    throw new EgressBlockedError(
      "dns_no_addresses",
      `hostname "${hostname}" resolved to no addresses`,
    );
  }
  if (!allowPrivate) {
    for (const { address } of addresses) {
      if (isForbiddenIp(address)) {
        throw new EgressBlockedError(
          "forbidden_ip",
          `hostname "${hostname}" resolves to a forbidden address`,
        );
      }
    }
  }
  const pinned = addresses[0]!;

  const port = url.port
    ? Number(url.port)
    : url.protocol === "https:"
      ? 443
      : 80;

  const outHeaders: Record<string, string> = {};
  hop.headers.forEach((value, name) => {
    // host is pinned below; accept-encoding is dropped because nothing here
    // decompresses — identity keeps the streamed bytes true to the wire.
    if (name === "host" || name === "accept-encoding") return;
    outHeaders[name] = value;
  });
  outHeaders["host"] = url.host;
  if (hop.body) outHeaders["content-length"] = String(hop.body.byteLength);

  const hostnameIsIpLiteral =
    isForbiddenIpv4(hostname) !== null || parseIpv6(hostname) !== null;

  return await new Promise<http.IncomingMessage>((resolve, reject) => {
    const requestFn = url.protocol === "https:" ? https.request : http.request;
    const req = requestFn({
      // Socket pinned to the validated IP; TLS still verifies the real
      // hostname via servername (SNI + cert identity check).
      host: pinned.address,
      port,
      path: `${url.pathname}${url.search}`,
      method: hop.method,
      headers: outHeaders,
      ...(url.protocol === "https:" && !hostnameIsIpLiteral
        ? { servername: hostname }
        : {}),
    });

    const timer = setTimeout(() => {
      req.destroy(
        new Error(`guarded egress timeout after ${hop.timeoutMs}ms`),
      );
    }, hop.timeoutMs);

    const onAbort = () => {
      req.destroy(
        hop.signal?.reason instanceof Error
          ? hop.signal.reason
          : new DOMException("The operation was aborted.", "AbortError"),
      );
    };
    if (hop.signal) {
      if (hop.signal.aborted) {
        clearTimeout(timer);
        onAbort();
      } else {
        hop.signal.addEventListener("abort", onAbort, { once: true });
      }
    }

    req.on("response", (res) => {
      clearTimeout(timer);
      hop.signal?.removeEventListener("abort", onAbort);
      resolve(res);
    });
    req.on("error", (error) => {
      clearTimeout(timer);
      hop.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });

    if (hop.body) req.write(hop.body);
    req.end();
  });
}

/** Wrap the node response in a standard Response with a byte-capped stream. */
function buildResponse(
  nodeRes: http.IncomingMessage,
  method: string,
  maxResponseBytes: number,
): Response {
  const status = nodeRes.statusCode ?? 200;
  const headers = new Headers();
  for (const [name, value] of Object.entries(nodeRes.headers)) {
    if (value === undefined) continue;
    if (Array.isArray(value)) {
      for (const item of value) headers.append(name, item);
    } else {
      headers.set(name, value);
    }
  }

  const bodyless =
    method === "HEAD" || status === 204 || status === 205 || status === 304;
  if (bodyless) {
    nodeRes.resume();
    return new Response(null, {
      status,
      statusText: nodeRes.statusMessage ?? "",
      headers,
    });
  }

  let seen = 0;
  const capped = (
    Readable.toWeb(nodeRes) as unknown as ReadableStream<Uint8Array>
  ).pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxResponseBytes) {
          nodeRes.destroy();
          controller.error(
            new Error(
              `guarded egress response too large (over ${maxResponseBytes} bytes)`,
            ),
          );
          return;
        }
        controller.enqueue(chunk);
      },
    }),
  );

  return new Response(capped, {
    status,
    statusText: nodeRes.statusMessage ?? "",
    headers,
  });
}
