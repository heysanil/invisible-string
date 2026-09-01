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
      issuer: fx.origin,
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
        // Served at the ROOT well-known but still declaring the tenant issuer
        // it was asked about — the legitimate shape of this fallback.
        return Response.json(
          asMetadata(`${origin}/tenant`, {
            token_endpoint: `${origin}/tenant/token`,
          }),
        );
      }
      return undefined;
    });

    const discovery = await discoverOauth(`${fx.origin}/mcp`, fetch);
    expect(discovery.tokenEndpoint).toBe(`${fx.origin}/tenant/token`);
    expect(discovery.issuer).toBe(`${fx.origin}/tenant`);
    const pathInserted = fx.calls.indexOf(
      "/.well-known/oauth-authorization-server/tenant",
    );
    const root = fx.calls.indexOf("/.well-known/oauth-authorization-server");
    expect(pathInserted).toBeGreaterThanOrEqual(0);
    expect(root).toBeGreaterThan(pathInserted);
  });

  test("rejects AS metadata whose issuer is not the issuer that was asked about", async () => {
    // The pre-fix behaviour ACCEPTED this: the PRM advertised `${origin}/tenant`
    // as the authorization server, every path-shaped variant 404'd, and the
    // root document — describing a DIFFERENT issuer entirely — was taken at
    // face value. That is the AS mix-up exposure of F13, so the permissive
    // assertion this test used to make is now the failing case.
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

    await expectDiscoveryError(
      discoverOauth(`${fx.origin}/mcp`, fetch),
      "issuer_mismatch",
    );
  });

  test("tolerates a lone trailing slash between the advertised and claimed issuer", async () => {
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
        // RFC 8414 says identical; real deployments differ by exactly this
        // one character, and nothing about it changes which server we mean.
        return Response.json(asMetadata(`${origin}/`));
      }
      return undefined;
    });

    const discovery = await discoverOauth(`${fx.origin}/mcp`, fetch);
    expect(discovery.issuer).toBe(`${fx.origin}/`);
    expect(discovery.authorizationServer).toBe(fx.origin);
  });

  test("rejects AS metadata that declares no issuer at all", async () => {
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
        return Response.json(asMetadata(origin, { issuer: undefined }));
      }
      return undefined;
    });

    await expectDiscoveryError(
      discoverOauth(`${fx.origin}/mcp`, fetch),
      "as_metadata_invalid",
    );
  });

  test("surfaces the RFC 9207 iss-parameter capability", async () => {
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
          asMetadata(origin, {
            authorization_response_iss_parameter_supported: true,
          }),
        );
      }
      return undefined;
    });

    const discovery = await discoverOauth(`${fx.origin}/mcp`, fetch);
    expect(discovery.issParameterSupported).toBe(true);
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

  // ── P0.1 / F3: every server-supplied URL is scheme-checked ────────────────
  //
  // The SPA navigates an `about:blank` popup (its OWN origin) straight to
  // `authorizationEndpoint`, so a custom MCP server advertising `javascript:`
  // is script execution against the app origin — the guarded egress fetch
  // never sees that navigation and cannot defend it.

  test("rejects a javascript: authorization endpoint", async () => {
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
          asMetadata(origin, {
            authorization_endpoint: "javascript:fetch('https://evil.example')",
          }),
        );
      }
      return undefined;
    });

    const error = await expectDiscoveryError(
      discoverOauth(`${fx.origin}/mcp`, fetch),
      "insecure_endpoint",
    );
    // The rejected value is never quoted back — the message would otherwise
    // carry an attacker-authored payload into an error DTO.
    expect(error.message).not.toContain("evil.example");
    expect(error.message).toContain("authorization_endpoint");
  });

  test("rejects a data: registration endpoint and a file: revocation endpoint", async () => {
    for (const overrides of [
      { registration_endpoint: "data:text/html,<script>1</script>" },
      { revocation_endpoint: "file:///etc/passwd" },
    ]) {
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
          return Response.json(asMetadata(origin, overrides));
        }
        return undefined;
      });

      await expectDiscoveryError(
        discoverOauth(`${fx.origin}/mcp`, fetch),
        "insecure_endpoint",
      );
    }
  });

  test("rejects a token endpoint carrying embedded credentials", async () => {
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
          asMetadata(origin, {
            // Reads as accounts.google.com in a popup's URL bar; dials
            // attacker.example.
            token_endpoint: "https://accounts.google.com@attacker.example/t",
          }),
        );
      }
      return undefined;
    });

    await expectDiscoveryError(
      discoverOauth(`${fx.origin}/mcp`, fetch),
      "insecure_endpoint",
    );
  });

  test("with the insecure-http switch off, plain-http metadata is refused", async () => {
    // The production stance: every fixture in this file is loopback http and
    // passes only because the switch is INHERITED from the MCP URL's own
    // scheme (an http MCP URL is dialable only under MCP_PROBE_ALLOW_PRIVATE).
    // Pin it off and the very first server-supplied URL is refused.
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
        return Response.json(asMetadata(origin));
      }
      return undefined;
    });

    await expectDiscoveryError(
      discoverOauth(`${fx.origin}/mcp`, fetch, { allowInsecureHttp: false }),
      "insecure_endpoint",
    );
    // …and the same fixture succeeds on the inherited default.
    const discovery = await discoverOauth(`${fx.origin}/mcp`, fetch);
    expect(discovery.tokenEndpoint).toBe(`${fx.origin}/token`);
  });

  test("a resource_metadata pointer that is not a fetchable URL is skipped, not fatal", async () => {
    using fx = serveFixture((path, { origin }) => {
      if (path === "/mcp") {
        return new Response("unauthorized", {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${origin}/prm#frag"`,
          },
        });
      }
      if (path === "/prm") {
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
    expect(discovery.scopesSupported).toEqual(["from-well-known"]);
    expect(fx.calls).not.toContain("/prm");
  });

  // ── P4.1 / F6+F7: scope selection ─────────────────────────────────────────

  test("the challenge's scope beats the PRM's, which beats nothing at all", async () => {
    using fx = serveFixture((path, { origin }) => {
      if (path === "/mcp") {
        return new Response("unauthorized", {
          status: 401,
          headers: {
            "www-authenticate": `Bearer realm="mcp", error="invalid_token", scope="issues:read issues:write", resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
          },
        });
      }
      if (path === "/.well-known/oauth-protected-resource/mcp") {
        return Response.json({
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          scopes_supported: ["prm:scope"],
        });
      }
      if (path === "/.well-known/oauth-authorization-server") {
        return Response.json(
          asMetadata(origin, { scopes_supported: ["as:wide"] }),
        );
      }
      return undefined;
    });

    const discovery = await discoverOauth(`${fx.origin}/mcp`, fetch);
    expect(discovery.scopesSupported).toEqual(["issues:read", "issues:write"]);
  });

  test("parses the Bearer challenge past other schemes, order, and quoting", async () => {
    using fx = serveFixture((path, { origin }) => {
      if (path === "/mcp") {
        return new Response("unauthorized", {
          status: 401,
          headers: {
            // Two challenges; Bearer second, its params in an arbitrary order,
            // one unquoted, and a quoted value containing a comma and an
            // escaped quote (both of which naive splitting mangles).
            "www-authenticate": `Basic realm="legacy, old", Bearer scope="a:read a:write", realm="say \\"hi\\", ok", resource_metadata=${origin}/prm`,
          },
        });
      }
      if (path === "/prm") {
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
    expect(discovery.scopesSupported).toEqual(["a:read", "a:write"]);
    expect(fx.calls).toContain("/prm");
  });

  test("never falls back to AS-wide scopes when the resource names none", async () => {
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
          asMetadata(origin, {
            scopes_supported: ["admin:everything", "billing:write"],
          }),
        );
      }
      return undefined;
    });

    const discovery = await discoverOauth(`${fx.origin}/mcp`, fetch);
    // Omitted entirely: the AS applies its own default rather than being asked
    // for every scope it happens to know about.
    expect(discovery.scopesSupported).toBeUndefined();
  });

  test("adds offline_access to a resolved scope set when the AS advertises it", async () => {
    using fx = serveFixture((path, { origin }) => {
      if (path === "/mcp") {
        return new Response("method not allowed", { status: 405 });
      }
      if (path === "/.well-known/oauth-protected-resource/mcp") {
        return Response.json({
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          scopes_supported: ["notes:read"],
        });
      }
      if (path === "/.well-known/oauth-authorization-server") {
        return Response.json(
          asMetadata(origin, {
            scopes_supported: ["notes:read", "offline_access"],
          }),
        );
      }
      return undefined;
    });

    const discovery = await discoverOauth(`${fx.origin}/mcp`, fetch);
    expect(discovery.scopesSupported).toEqual(["notes:read", "offline_access"]);
  });

  test("does not repeat offline_access, nor request it as the only scope", async () => {
    using fx = serveFixture((path, { origin }) => {
      if (path === "/mcp") {
        return new Response("method not allowed", { status: 405 });
      }
      if (path === "/.well-known/oauth-protected-resource/mcp") {
        return Response.json({
          resource: `${origin}/mcp`,
          authorization_servers: [origin],
          scopes_supported: ["offline_access", "notes:read"],
        });
      }
      if (path === "/.well-known/oauth-protected-resource") {
        return Response.json({
          resource: origin,
          authorization_servers: [origin],
        });
      }
      if (path === "/.well-known/oauth-authorization-server") {
        return Response.json(
          asMetadata(origin, { scopes_supported: ["offline_access"] }),
        );
      }
      return undefined;
    });

    const withScopes = await discoverOauth(`${fx.origin}/mcp`, fetch);
    expect(withScopes.scopesSupported).toEqual([
      "offline_access",
      "notes:read",
    ]);
    // Nothing named a scope, so nothing is requested — `scope=offline_access`
    // alone would narrow an implicit default grant down to no access at all.
    const withoutScopes = await discoverOauth(fx.origin, fetch);
    expect(withoutScopes.scopesSupported).toBeUndefined();
  });

  // ── P4.3 / F14: the PRM's resource must identify what we asked about ──────

  test("accepts a resource that differs only by a trailing slash", async () => {
    // Vercel's root PRM answers `https://mcp.vercel.com/` for a catalog URL
    // written `https://mcp.vercel.com`; a string compare would break a server
    // doing nothing wrong.
    using fx = serveFixture((path, { origin }) => {
      if (path === "/") return new Response("no", { status: 405 });
      if (path === "/.well-known/oauth-protected-resource") {
        return Response.json({
          resource: `${origin}/`,
          authorization_servers: [origin],
        });
      }
      if (path === "/.well-known/oauth-authorization-server") {
        return Response.json(asMetadata(origin));
      }
      return undefined;
    });

    const discovery = await discoverOauth(fx.origin, fetch);
    // Returned VERBATIM: the AS matches the string its own resource published.
    expect(discovery.resource).toBe(`${fx.origin}/`);
  });

  test("accepts a resource that is an ancestor path of the requested endpoint", async () => {
    using fx = serveFixture((path, { origin }) => {
      if (path === "/mcp/v1") return new Response("no", { status: 405 });
      if (path === "/.well-known/oauth-protected-resource/mcp/v1") {
        return Response.json({
          resource: `${origin}/mcp/`,
          authorization_servers: [origin],
        });
      }
      if (path === "/.well-known/oauth-authorization-server") {
        return Response.json(asMetadata(origin));
      }
      return undefined;
    });

    const discovery = await discoverOauth(`${fx.origin}/mcp/v1`, fetch);
    expect(discovery.resource).toBe(`${fx.origin}/mcp/`);
  });

  test("rejects a resource naming another host, and keeps probing", async () => {
    using fx = serveFixture((path, { origin }) => {
      if (path === "/mcp") {
        return new Response("unauthorized", {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${origin}/hostile-prm"`,
          },
        });
      }
      if (path === "/hostile-prm") {
        // Audience injection: get us to ask this AS for a token bound to a
        // resource identifier we never requested.
        return Response.json({
          resource: "https://api.github.com",
          authorization_servers: [origin],
        });
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
    expect(fx.calls).toContain("/hostile-prm");
  });

  test("rejects a sibling-path resource and a fragment-bearing one", async () => {
    for (const resource of ["/other", "/mcp#frag"]) {
      using fx = serveFixture((path, { origin }) => {
        if (path === "/mcp") {
          return new Response("method not allowed", { status: 405 });
        }
        if (path === "/.well-known/oauth-protected-resource/mcp") {
          return Response.json({
            resource: `${origin}${resource}`,
            authorization_servers: [origin],
          });
        }
        return undefined;
      });

      await expectDiscoveryError(
        discoverOauth(`${fx.origin}/mcp`, fetch),
        resource === "/other" ? "resource_mismatch" : "insecure_endpoint",
      );
    }
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
