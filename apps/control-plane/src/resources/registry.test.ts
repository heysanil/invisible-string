import { describe, expect, test } from "bun:test";

import { RuntimeApiError } from "../runtime/errors";
import {
  createRegistryClient,
  mapRegistryEntry,
  REGISTRY_HOST,
} from "./registry";

describe("mapRegistryEntry", () => {
  test("trims a nested {server,_meta} entry to the DTO", () => {
    const dto = mapRegistryEntry({
      server: {
        name: "io.example/linear",
        title: "Linear",
        description: "Issue tracker",
        version: "1.2.0",
        remotes: [
          {
            type: "streamable-http",
            url: "https://mcp.linear.app/mcp",
            headers: [
              { name: "Authorization", isRequired: true, isSecret: true },
            ],
          },
        ],
        packages: [
          {
            environmentVariables: [
              { name: "LINEAR_API_KEY", isRequired: true, isSecret: true, format: "string" },
            ],
          },
        ],
        icons: [{ src: "https://cdn.example/linear.png", mimeType: "image/png" }],
      },
      _meta: {
        "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true },
      },
    });
    expect(dto).not.toBeNull();
    expect(dto!.name).toBe("io.example/linear");
    expect(dto!.title).toBe("Linear");
    expect(dto!.remotes).toHaveLength(1);
    expect(dto!.remotes[0]!.url).toBe("https://mcp.linear.app/mcp");
    expect(dto!.remotes[0]!.headers?.[0]).toMatchObject({
      name: "Authorization",
      isSecret: true,
    });
    expect(dto!.envVarDeclarations[0]).toMatchObject({
      name: "LINEAR_API_KEY",
      isSecret: true,
    });
    expect(dto!.icons?.[0]!.src).toBe("https://cdn.example/linear.png");
  });

  test("drops deprecated / non-latest servers", () => {
    expect(
      mapRegistryEntry({
        server: { name: "x/y", version: "1.0.0" },
        _meta: {
          "io.modelcontextprotocol.registry/official": { status: "deleted", isLatest: true },
        },
      }),
    ).toBeNull();
    expect(
      mapRegistryEntry({
        server: { name: "x/y", version: "1.0.0" },
        _meta: {
          "io.modelcontextprotocol.registry/official": { status: "active", isLatest: false },
        },
      }),
    ).toBeNull();
  });

  test("drops remotes with malformed urls rather than failing the whole row", () => {
    const dto = mapRegistryEntry({
      name: "flat/server",
      version: "0.1.0",
      description: "flat entry (no _meta wrapper)",
      remotes: [
        { type: "streamable-http", url: "not-a-url" },
        { type: "sse", url: "https://ok.example/sse" },
      ],
    });
    expect(dto).not.toBeNull();
    expect(dto!.remotes.map((r) => r.url)).toEqual(["https://ok.example/sse"]);
  });
});

describe("createRegistryClient", () => {
  function stubFetch(handler: (url: string) => Response): typeof fetch {
    return (async (input: string | URL | Request) =>
      handler(String(input))) as unknown as typeof fetch;
  }

  const searchBody = {
    servers: [
      {
        server: {
          name: "io.example/one",
          version: "1.0.0",
          description: "one",
          remotes: [{ type: "streamable-http", url: "https://one.example/mcp" }],
        },
        _meta: {
          "io.modelcontextprotocol.registry/official": { status: "active", isLatest: true },
        },
      },
    ],
  };

  test("hits the FIXED host only and caches within the TTL", async () => {
    const urls: string[] = [];
    const client = createRegistryClient({
      fetchImpl: stubFetch((url) => {
        urls.push(url);
        return Response.json(searchBody);
      }),
      ttlMs: 10_000,
      now: () => 1000,
    });
    const a = await client.search("one");
    const b = await client.search("one");
    expect(a).toHaveLength(1);
    expect(b).toEqual(a);
    // Second call served from cache — only ONE upstream request.
    expect(urls).toHaveLength(1);
    expect(urls[0]!.startsWith(`${REGISTRY_HOST}/v0.1/servers?`)).toBeTrue();
    expect(urls[0]!).toContain("version=latest");
  });

  test("upstream failure surfaces as a typed 502", async () => {
    const client = createRegistryClient({
      fetchImpl: stubFetch(() => new Response("nope", { status: 503 })),
    });
    await expect(client.search("boom")).rejects.toMatchObject({
      status: 502,
      code: "registry_unavailable",
    });
  });

  test("network error surfaces as a typed 502", async () => {
    const client = createRegistryClient({
      fetchImpl: (async () => {
        throw new Error("ECONNREFUSED");
      }) as unknown as typeof fetch,
    });
    const err = await client.search("x").catch((e) => e);
    expect(err).toBeInstanceOf(RuntimeApiError);
    expect((err as RuntimeApiError).status).toBe(502);
  });

  test("getServer returns null on a 404", async () => {
    const client = createRegistryClient({
      fetchImpl: stubFetch(() => new Response("missing", { status: 404 })),
    });
    expect(await client.getServer("io.example/gone")).toBeNull();
  });

  test("getServer path-encodes the reverse-DNS name onto the fixed host", async () => {
    let seen = "";
    const client = createRegistryClient({
      fetchImpl: stubFetch((url) => {
        seen = url;
        return Response.json({
          server: {
            name: "io.example/one",
            version: "2.0.0",
            remotes: [{ type: "streamable-http", url: "https://one.example/mcp" }],
          },
        });
      }),
    });
    const server = await client.getServer("io.example/one", "2.0.0");
    expect(server?.version).toBe("2.0.0");
    expect(seen).toBe(
      `${REGISTRY_HOST}/v0.1/servers/io.example%2Fone/versions/2.0.0`,
    );
  });
});
