/**
 * Test fixture "agent" — a tiny HTTP server packaged exactly like a real
 * built-eve artifact (`.output/server/index.mjs` inside a tar.gz, launched
 * with PORT from env). No real eve, no DB, no provider keys.
 *
 * The server source is pure `node:http` ESM so it runs under mise Node 24
 * (the real agent runtime) and under bun as a fallback on machines without
 * a node 24 install (fixture behavior is identical).
 *
 * Endpoints:
 *   GET  /eve/v1/health          → { ok: true }        (readiness)
 *   GET  /eve/v1/env             → process.env         (env-isolation checks)
 *   GET  /eve/v1/slow?ms=N       → responds after N ms (drain in-flight)
 *   GET  /eve/v1/ndjson?lines=N&gapMs=M → chunked NDJSON, one line per M ms
 *   *    anything else under the forwarded prefixes → JSON echo of
 *        {method, path, query, headers, body} (verbatim-forwarding checks)
 */
import { existsSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const FIXTURE_SERVER_SOURCE = String.raw`
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? "0");

function json(res, status, body) {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

const server = createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://fixture.local");
  if (url.pathname === "/eve/v1/health") return json(res, 200, { ok: true });
  if (url.pathname === "/eve/v1/env") return json(res, 200, process.env);
  if (url.pathname === "/eve/v1/slow") {
    const ms = Number(url.searchParams.get("ms") ?? "300");
    setTimeout(() => json(res, 200, { slow: true, ms }), ms);
    return;
  }
  if (url.pathname === "/eve/v1/ndjson") {
    const lines = Number(url.searchParams.get("lines") ?? "5");
    const gapMs = Number(url.searchParams.get("gapMs") ?? "120");
    res.writeHead(200, { "content-type": "application/x-ndjson" });
    let i = 0;
    const timer = setInterval(() => {
      res.write(JSON.stringify({ type: "tick", i }) + "\n");
      i += 1;
      if (i >= lines) {
        clearInterval(timer);
        res.end();
      }
    }, gapMs);
    return;
  }
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    json(res, 200, {
      method: req.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      headers: req.headers,
      body: Buffer.concat(chunks).toString("utf8"),
    });
  });
});

server.listen(port, "127.0.0.1");
`;

/** Exits immediately — exercises boot-failure handling + crash-log capture. */
export const CRASHING_SERVER_SOURCE = String.raw`
console.error("fixture boot failure: refusing to start (crash fixture)");
process.exit(1);
`;

/**
 * Build a fixture artifact tarball (layout: `.output/server/index.mjs` [+
 * `.output/padding.bin`]) under `scratchDir`. Returns the tar.gz path.
 * `paddingBytes` are random (incompressible) so on-disk size drives LRU math.
 */
export async function buildFixtureArtifact(options: {
  scratchDir: string;
  name: string;
  source?: string;
  paddingBytes?: number;
}): Promise<string> {
  const stage = join(options.scratchDir, `${options.name}-stage`);
  mkdirSync(join(stage, ".output", "server"), { recursive: true });
  writeFileSync(
    join(stage, ".output", "server", "index.mjs"),
    options.source ?? FIXTURE_SERVER_SOURCE,
  );
  if (options.paddingBytes !== undefined && options.paddingBytes > 0) {
    const padding = new Uint8Array(options.paddingBytes);
    crypto.getRandomValues(padding.subarray(0, Math.min(padding.length, 65536)));
    // Repeat the random block so the whole file stays incompressible enough.
    for (let offset = 65536; offset < padding.length; offset += 65536) {
      padding.set(
        padding.subarray(0, Math.min(65536, padding.length - offset)),
        offset,
      );
    }
    writeFileSync(join(stage, ".output", "padding.bin"), padding);
  }
  const tarPath = join(options.scratchDir, `${options.name}.tar.gz`);
  const tar = Bun.spawn(["tar", "-czf", tarPath, "-C", stage, ".output"], {
    stdout: "ignore",
    stderr: "pipe",
  });
  const [exitCode, stderr] = await Promise.all([
    tar.exited,
    new Response(tar.stderr).text(),
  ]);
  if (exitCode !== 0) {
    throw new Error(`fixture tar failed: ${stderr}`);
  }
  return tarPath;
}

/** Serve fixture tarballs over HTTP (models Garage presigned artifact URLs). */
export interface ArtifactServer {
  urlFor(tarPath: string): string;
  stop(): void;
}

export function startArtifactServer(): ArtifactServer {
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== "/artifact") {
        return new Response("not found", { status: 404 });
      }
      const file = url.searchParams.get("f");
      if (file === null || !existsSync(file)) {
        return new Response("missing artifact", { status: 404 });
      }
      return new Response(Bun.file(file));
    },
  });
  return {
    urlFor(tarPath: string): string {
      return `http://127.0.0.1:${server.port}/artifact?f=${encodeURIComponent(tarPath)}`;
    },
    stop(): void {
      server.stop(true);
    },
  };
}

/**
 * Node runtime for fixture agents: newest mise-installed node 24 (the real
 * agent runtime, same resolution as the spike harness) or bun itself as a
 * fallback — the fixture is pure node:http ESM and runs under either.
 */
export function resolveTestNodeBin(): string {
  const installs = join(
    process.env.HOME ?? "",
    ".local/share/mise/installs/node",
  );
  if (existsSync(installs)) {
    const newest24 = readdirSync(installs)
      .filter((name) => /^24\.\d+\.\d+$/.test(name))
      .sort((a, b) => {
        const pa = a.split(".").map(Number);
        const pb = b.split(".").map(Number);
        for (let i = 0; i < 3; i++) {
          const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
          if (diff !== 0) return diff;
        }
        return 0;
      })
      .at(-1);
    if (newest24 !== undefined) {
      const bin = join(installs, newest24, "bin", "node");
      if (existsSync(bin)) return bin;
    }
  }
  return process.execPath;
}
