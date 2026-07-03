/**
 * Minimal Bun reverse proxy modeling the worker supervisor's routing rule:
 * forward ONLY the `/eve/` and `/.well-known/workflow/` path prefixes to the
 * agent process; reject everything else. The workflow world delivers run
 * callbacks to `/.well-known/workflow/v1/*` — forwarding only `/eve/` lets
 * sessions start but stalls runs forever.
 *
 * Run standalone: `bun spike/proxy.ts` (env: SPIKE_PROXY_PORT, SPIKE_UPSTREAM)
 * or import { startProxy } from tests.
 */

export const FORWARDED_PREFIXES = ["/eve/", "/.well-known/workflow/"] as const;

export interface ProxyHandle {
  readonly port: number;
  stop(): void;
}

export function startProxy(options?: {
  port?: number;
  upstream?: string;
}): ProxyHandle {
  const port = options?.port ?? Number(process.env.SPIKE_PROXY_PORT ?? "4100");
  const upstream =
    options?.upstream ?? process.env.SPIKE_UPSTREAM ?? "http://127.0.0.1:4101";
  const upstreamUrl = new URL(upstream);

  const server = Bun.serve({
    port,
    // NDJSON session streams stay open for minutes; never idle-close them.
    idleTimeout: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (!FORWARDED_PREFIXES.some((p) => url.pathname.startsWith(p))) {
        return new Response("proxy: path not forwarded\n", { status: 404 });
      }
      const target = new URL(url.pathname + url.search, upstreamUrl);
      const headers = new Headers(request.headers);
      headers.set("host", upstreamUrl.host);
      try {
        return await fetch(target, {
          method: request.method,
          headers,
          body: request.body,
          redirect: "manual",
          // @ts-expect-error: `duplex` is required for streaming request bodies.
          duplex: "half",
        });
      } catch {
        // Upstream down (e.g. agent process restarting). Return 502 like a
        // real proxy; workflow queue jobs retry until the agent is back.
        return new Response("proxy: upstream unavailable\n", { status: 502 });
      }
    },
  });

  return {
    port,
    stop() {
      server.stop(true);
    },
  };
}

if (import.meta.main) {
  const handle = startProxy();
  console.log(
    `spike proxy listening on :${handle.port} -> ${process.env.SPIKE_UPSTREAM ?? "http://127.0.0.1:4101"} (prefixes: ${FORWARDED_PREFIXES.join(", ")})`,
  );
}
