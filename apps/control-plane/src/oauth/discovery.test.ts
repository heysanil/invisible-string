import { describe, expect, test } from "bun:test";

import { createGuardedFetch, EgressBlockedError } from "../net/guarded-fetch";
import { discoverOauth, OauthDiscoveryError } from "./discovery";

/**
 * In-process fixture host: stands in for a public MCP server (and, in most
 * tests, its authorization server on the same origin). Routes are matched on
 * pathname; unrouted paths 404. Every request's pathname is recorded so tests
 * can assert probe ordering and "never fetched" expectations.
 */
function serveFixture(
  handler: (
    path: string,
    ctx: { origin: string; req: Request },
  ) => Response | undefined,
) {
  const calls: string[] = [];
  let origin = ""; // assigned below, once the ephemeral port is known
  const srv = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      calls.push(url.pathname);
      return (
        handler(url.pathname, { origin, req }) ??
        new Response("not found", { status: 404 })
      );
    },
  });
  origin = `http://127.0.0.1:${srv.port}`;
  return {
    origin,
    calls,
    [Symbol.dispose]() {
      srv.stop(true);
    },
  };
}

/** Minimal valid RFC 8414 metadata for an AS living at `issuer`. */
function asMetadata(
  issuer: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    code_challenge_methods_supported: ["S256"],
    ...overrides,
  };
}

async function expectDiscoveryError(
  promise: Promise<unknown>,
  reason: string,
): Promise<OauthDiscoveryError> {
  const error = await promise.then(
    () => {
      throw new Error("expected discovery to fail");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(OauthDiscoveryError);
  const discoveryError = error as OauthDiscoveryError;
  expect(discoveryError.reason).toBe(reason);
  return discoveryError;
}

describe("discoverOauth", () => {
  test("path-aware PRM: a server under /mcp resolves via the path-inserted well-known", async () => {
    using fx = serveFixture((path, { origin }) => {
      if (path === "/mcp") {
        return new Response("method not allowed", { status: 405 });
      }
      if (path === "/.well-known/oauth-protected-resource/mcp") {
        return Response.json({
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          scopes_supported: ["notes:read", "notes:write"],
        });
      }
      if (path === "/.well-known/oauth-authorization-server") {
        return Response.json(
          asMetadata(origin, {
            registration_endpoint: `${origin}/register`,
            revocation_endpoint: `${origin}/revoke`,
            client_id_metadata_document_supported: true,
          }),
        );
      }
      return undefined;
    });

    const discovery = await discoverOauth(`${fx.origin}/mcp`, fetch);
    expect(discovery).toEqual({
      resource: `${fx.origin}/mcp`,
      authorizationServer: fx.origin,
      authorizationEndpoint: `${fx.origin}/authorize`,
      tokenEndpoint: `${fx.origin}/token`,
      registrationEndpoint: `${fx.origin}/register`,
      revocationEndpoint: `${fx.origin}/revoke`,
      scopesSupported: ["notes:read", "notes:write"],
      clientIdMetadataDocumentSupported: true,
    });
    // The path-inserted variant answered, so the root PRM is never probed.
    expect(fx.calls).not.toContain("/.well-known/oauth-protected-resource");
  });

  test("falls back to the root PRM well-known when the path-inserted variant is absent", async () => {
    using fx = serveFixture((path, { origin }) => {
      if (path === "/mcp") {
        return new Response("method not allowed", { status: 405 });
      }
      if (path === "/.well-known/oauth-protected-resource") {
        return Response.json({
          resource: origin,
          authorization_servers: [origin],
        });
      }
      if (path === "/.well-known/oauth-authorization-server") {
        return Response.json(asMetadata(origin));
      }
      return undefined;
    });

    const discovery = await discoverOauth(`${fx.origin}/mcp`, fetch);
    expect(discovery.resource).toBe(fx.origin);
    // Path-inserted was tried FIRST, then the root fallback.
    const inserted = fx.calls.indexOf(
      "/.well-known/oauth-protected-resource/mcp",
    );
    const root = fx.calls.indexOf("/.well-known/oauth-protected-resource");
    expect(inserted).toBeGreaterThanOrEqual(0);
    expect(root).toBeGreaterThan(inserted);
  });

  test("the WWW-Authenticate resource_metadata pointer wins over well-known probing", async () => {
    using fx = serveFixture((path, { origin }) => {
      if (path === "/mcp") {
        return new Response("unauthorized", {
          status: 401,
          headers: {
            "www-authenticate": `Bearer realm="mcp", resource_metadata="${origin}/custom/prm-location"`,
          },
        });
      }
      if (path === "/custom/prm-location") {
        return Response.json({
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          scopes_supported: ["from-pointer"],
        });
      }
      if (path === "/.well-known/oauth-protected-resource/mcp") {
        return Response.json({
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          scopes_supported: ["from-well-known"],
        });
      }
      if (path === "/.well-known/oauth-authorization-server") {
        return Response.json(asMetadata(origin));
      }
      return undefined;
    });

    const discovery = await discoverOauth(`${fx.origin}/mcp`, fetch);
    expect(discovery.scopesSupported).toEqual(["from-pointer"]);
    expect(fx.calls).not.toContain("/.well-known/oauth-protected-resource/mcp");
  });

  test("prefers RFC 8414 path insertion over OIDC path appending for a path issuer", async () => {
    using fx = serveFixture((path, { origin }) => {
      if (path === "/mcp") {
        return new Response("method not allowed", { status: 405 });
      }
      if (path === "/.well-known/oauth-protected-resource/mcp") {
        return Response.json({
          resource: `${origin}/mcp`,
          authorization_servers: [`${origin}/tenant`],
        });
      }
      if (path === "/.well-known/oauth-authorization-server/tenant") {
        return Response.json(
          asMetadata(`${origin}/tenant`, {
            token_endpoint: `${origin}/token-8414`,
          }),
        );
      }
      if (path === "/tenant/.well-known/openid-configuration") {
        return Response.json(
          asMetadata(`${origin}/tenant`, {
            token_endpoint: `${origin}/token-oidc`,
          }),
        );
      }
      return undefined;
    });

    const discovery = await discoverOauth(`${fx.origin}/mcp`, fetch);
    expect(discovery.tokenEndpoint).toBe(`${fx.origin}/token-8414`);
    expect(fx.calls).not.toContain("/tenant/.well-known/openid-configuration");
  });

  test("falls back to OIDC discovery under the issuer path when RFC 8414 is absent", async () => {
    using fx = serveFixture((path, { origin }) => {
      if (path === "/mcp") {
        return new Response("method not allowed", { status: 405 });
      }
      if (path === "/.well-known/oauth-protected-resource/mcp") {
        return Response.json({
          resource: `${origin}/mcp`,
          authorization_servers: [`${origin}/tenant`],
        });
      }
      if (path === "/tenant/.well-known/openid-configuration") {
        return Response.json(asMetadata(`${origin}/tenant`));
      }
      return undefined;
    });

    const discovery = await discoverOauth(`${fx.origin}/mcp`, fetch);
    expect(discovery.authorizationServer).toBe(`${fx.origin}/tenant`);
    // 8414 path-inserted was attempted before the OIDC path-appended variant.
    const rfc8414 = fx.calls.indexOf(
      "/.well-known/oauth-authorization-server/tenant",
    );
    const oidc = fx.calls.indexOf("/tenant/.well-known/openid-configuration");
    expect(rfc8414).toBeGreaterThanOrEqual(0);
    expect(oidc).toBeGreaterThan(rfc8414);
  });

  test("falls back to the root AS metadata variants when path variants are absent", async () => {
    using fx = serveFixture((path, { origin }) => {
      if (path === "/mcp") {
        return new Response("method not allowed", { status: 405 });
      }
      if (path === "/.well-known/oauth-protected-resource/mcp") {
        return Response.json({
          resource: `${origin}/mcp`,
          authorization_servers: [`${origin}/tenant`],
        });
      }
      if (path === "/.well-known/oauth-authorization-server") {
        return Response.json(asMetadata(origin));
      }
      return undefined;
    });

    const discovery = await discoverOauth(`${fx.origin}/mcp`, fetch);
    expect(discovery.tokenEndpoint).toBe(`${fx.origin}/token`);
    const pathInserted = fx.calls.indexOf(
      "/.well-known/oauth-authorization-server/tenant",
    );
    const root = fx.calls.indexOf("/.well-known/oauth-authorization-server");
    expect(pathInserted).toBeGreaterThanOrEqual(0);
    expect(root).toBeGreaterThan(pathInserted);
  });

  test("rejects an authorization server that does not advertise S256 PKCE", async () => {
    using fx = serveFixture((path, { origin }) => {
      if (path === "/mcp") {
        return new Response("method not allowed", { status: 405 });
      }
      if (path === "/.well-known/oauth-protected-resource/mcp") {
        return Response.json({
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
        });
      }
      if (path === "/.well-known/oauth-authorization-server") {
        return Response.json(
          asMetadata(origin, { code_challenge_methods_supported: ["plain"] }),
        );
      }
      return undefined;
    });

    await expectDiscoveryError(
      discoverOauth(`${fx.origin}/mcp`, fetch),
      "pkce_unsupported",
    );
  });

  test("rejects an authorization server whose metadata omits PKCE methods entirely", async () => {
    using fx = serveFixture((path, { origin }) => {
      if (path === "/mcp") {
        return new Response("method not allowed", { status: 405 });
      }
      if (path === "/.well-known/oauth-protected-resource/mcp") {
        return Response.json({
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
        });
      }
      if (path === "/.well-known/oauth-authorization-server") {
        return Response.json(
          asMetadata(origin, { code_challenge_methods_supported: undefined }),
        );
      }
      return undefined;
    });

    await expectDiscoveryError(
      discoverOauth(`${fx.origin}/mcp`, fetch),
      "pkce_unsupported",
    );
  });

  test("no metadata anywhere -> no_oauth_metadata", async () => {
    using fx = serveFixture((path) => {
      if (path === "/mcp") {
        return new Response("method not allowed", { status: 405 });
      }
      return undefined; // every well-known 404s
    });

    await expectDiscoveryError(
      discoverOauth(`${fx.origin}/mcp`, fetch),
      "no_oauth_metadata",
    );
  });

  test("an oversized metadata document is discarded and probing continues", async () => {
    using fx = serveFixture((path, { origin }) => {
      if (path === "/mcp") {
        return new Response("unauthorized", {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${origin}/huge-prm"`,
          },
        });
      }
      if (path === "/huge-prm") {
        // Valid JSON, but far past the metadata size cap.
        return Response.json({ pad: "x".repeat(400_000) });
      }
      if (path === "/.well-known/oauth-protected-resource/mcp") {
        return Response.json({
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
        });
      }
      if (path === "/.well-known/oauth-authorization-server") {
        return Response.json(asMetadata(origin));
      }
      return undefined;
    });

    const discovery = await discoverOauth(`${fx.origin}/mcp`, fetch);
    expect(discovery.resource).toBe(`${fx.origin}/mcp`);
  });

  test("a PRM advertising a private-address AS is rejected by the egress guard", async () => {
    using fx = serveFixture((path, { origin }) => {
      if (path === "/mcp") {
        return new Response("method not allowed", { status: 405 });
      }
      if (path === "/.well-known/oauth-protected-resource/mcp") {
        return Response.json({
          resource: `${origin}/mcp`,
          // Attacker-chosen AS on a private address: the guard must refuse it.
          authorization_servers: ["http://127.0.0.1:9"],
        });
      }
      return undefined;
    });

    // The fixture stands in for a public MCP host; everything the discovery
    // derives from server-supplied content rides the strict guard.
    const guarded = createGuardedFetch({ allowPrivate: false });
    const fixtureOrigin = fx.origin;
    const fetchImpl = ((
      input: Parameters<typeof fetch>[0],
      init?: RequestInit,
    ) => {
      const url = new URL(
        input instanceof Request
          ? input.url
          : input instanceof URL
            ? input.href
            : input,
      );
      return url.origin === fixtureOrigin
        ? fetch(input, init)
        : guarded(input, init);
    }) as typeof fetch;

    const error = await expectDiscoveryError(
      discoverOauth(`${fx.origin}/mcp`, fetchImpl),
      "egress_blocked",
    );
    expect(error.cause).toBeInstanceOf(EgressBlockedError);
  });
});
