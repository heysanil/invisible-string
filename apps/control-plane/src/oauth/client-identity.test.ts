import { describe, expect, test } from "bun:test";

import {
  decryptSecret,
  generateMasterKeyBase64,
  parseMasterKey,
  type EncryptedEnvelope,
} from "@invisible-string/shared";

import { mcpOauthClientMetadataRoute } from "../integrations/routes";
import { createGuardedFetch } from "../net/guarded-fetch";
import {
  loadOauthClientRegistrations,
  type OauthClientRegistrations,
} from "../runtime/config";
import { RuntimeApiError } from "../runtime/errors";
import type { OauthDiscovery } from "./discovery";
import {
  buildClientMetadataDocument,
  clientMetadataUrl,
  connectionOauthAad,
  isPublicHttpsUrl,
  mcpOauthRedirectUri,
  resolveClientIdentity,
  type ClientIdentityDeps,
  type ClientRegistrationRow,
} from "./client-identity";

const MASTER_KEY = parseMasterKey(generateMasterKeyBase64());
const PUBLIC_BASE = "https://app.example.com";
const LOCAL_BASE = "http://localhost:3000";

function discoveryFixture(
  overrides: Partial<OauthDiscovery> = {},
): OauthDiscovery {
  const merged = {
    resource: "https://mcp.example.com/mcp",
    authorizationServer: "https://as.example.com",
    issuer: "https://as.example.com",
    authorizationEndpoint: "https://as.example.com/authorize",
    tokenEndpoint: "https://as.example.com/token",
    ...overrides,
  };
  // Discovery guarantees the AS metadata's own issuer equals the advertised
  // authorization server (up to a trailing slash), so overriding one implies
  // the other unless a test states both.
  return { ...merged, issuer: overrides.issuer ?? merged.authorizationServer };
}

function rowFixture(
  overrides: Partial<ClientRegistrationRow> = {},
): ClientRegistrationRow {
  return {
    id: "co_aaaaaaaaaaaaaaaa",
    connectionId: "cn_bbbbbbbbbbbbbbbb",
    clientId: null,
    clientSecretEncrypted: null,
    clientRegistrationIssuer: null,
    ...overrides,
  };
}

interface RecordedRegistration {
  rowId: string;
  clientId: string;
  clientSecretEncrypted: string | null;
  clientIdentityMode: "dcr" | "preregistered";
  clientRegistrationIssuer: string;
}

function makeDeps(
  publicAppUrl: string,
  fetchImpl: typeof fetch,
  preregisteredClients?: OauthClientRegistrations,
): ClientIdentityDeps & { persisted: RecordedRegistration[] } {
  const persisted: RecordedRegistration[] = [];
  return {
    publicAppUrl,
    fetchImpl,
    masterKey: MASTER_KEY,
    ...(preregisteredClients !== undefined ? { preregisteredClients } : {}),
    persistRegistration: async (rowId, values) => {
      persisted.push({ rowId, ...values });
    },
    persisted,
  };
}

/** The operator-config lane's loader, so the env contract is exercised end to
 * end rather than a hand-built map that could drift from it. */
function preregistered(env: Record<string, string>): OauthClientRegistrations {
  return loadOauthClientRegistrations(env);
}

/** A fetch that fails the test if the code path ever goes to the network. */
const neverFetch = (() => {
  throw new Error("unexpected outbound fetch");
}) as unknown as typeof fetch;

/**
 * In-process registration-endpoint fixture. Records every POST body so tests
 * can assert the RFC 7591 request shape and hit counts.
 */
function serveRegistration(respond: (body: unknown) => Response) {
  const bodies: unknown[] = [];
  const srv = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url);
      if (url.pathname !== "/register" || req.method !== "POST") {
        return new Response("not found", { status: 404 });
      }
      const body: unknown = await req.json().catch(() => null);
      bodies.push(body);
      return respond(body);
    },
  });
  return {
    endpoint: `http://127.0.0.1:${srv.port}/register`,
    bodies,
    [Symbol.dispose]() {
      srv.stop(true);
    },
  };
}

async function expectRegistrationError(
  promise: Promise<unknown>,
): Promise<RuntimeApiError> {
  const error = await promise.then(
    () => {
      throw new Error("expected client-identity resolution to fail");
    },
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(RuntimeApiError);
  const apiError = error as RuntimeApiError;
  expect(apiError.code).toBe("oauth_registration_failed");
  expect(apiError.status).toBe(502);
  return apiError;
}

describe("isPublicHttpsUrl", () => {
  const publicUrls = [
    "https://app.example.com",
    "https://app.example.com:8443",
    "https://1.2.3.4",
  ];
  const nonPublicUrls = [
    "http://app.example.com", // https only
    "http://localhost:3000",
    "https://localhost",
    "https://app.localhost",
    "https://127.0.0.1",
    "https://10.0.0.5",
    "https://192.168.1.10",
    "https://[::1]",
    "not a url",
  ];
  for (const url of publicUrls) {
    test(`${url} is public https`, () => expect(isPublicHttpsUrl(url)).toBe(true));
  }
  for (const url of nonPublicUrls) {
    test(`${url} is not public https`, () =>
      expect(isPublicHttpsUrl(url)).toBe(false));
  }
});

describe("resolveClientIdentity — CIMD", () => {
  test("public https base + AS support → the metadata URL is the client id, nothing persisted", async () => {
    const deps = makeDeps(PUBLIC_BASE, neverFetch);
    const identity = await resolveClientIdentity(
      deps,
      discoveryFixture({ clientIdMetadataDocumentSupported: true }),
      rowFixture(),
    );
    expect(identity).toEqual({
      clientId: `${PUBLIC_BASE}/integrations/mcp-oauth/client-metadata.json`,
      clientSecret: null,
      persisted: false,
      mode: "cimd",
      tokenEndpointAuthMethod: "none",
    });
    expect(deps.persisted).toEqual([]);
  });

  test("AS without CIMD support falls back to DCR even on a public https base", async () => {
    using fx = serveRegistration(() =>
      Response.json({ client_id: "dcr-no-cimd" }, { status: 201 }),
    );
    const deps = makeDeps(PUBLIC_BASE, fetch);
    const identity = await resolveClientIdentity(
      deps,
      discoveryFixture({ registrationEndpoint: fx.endpoint }),
      rowFixture(),
    );
    expect(identity.clientId).toBe("dcr-no-cimd");
    expect(identity.persisted).toBe(true);
  });
});

describe("resolveClientIdentity — DCR fallback", () => {
  test("non-public base URL forces DCR despite CIMD support; the RFC 7591 request is well-formed", async () => {
    using fx = serveRegistration(() =>
      Response.json(
        { client_id: "dcr-client-1", client_secret: "dcr-secret-1" },
        { status: 201 },
      ),
    );
    const deps = makeDeps(LOCAL_BASE, fetch);
    const row = rowFixture();
    const identity = await resolveClientIdentity(
      deps,
      discoveryFixture({
        clientIdMetadataDocumentSupported: true,
        registrationEndpoint: fx.endpoint,
      }),
      row,
    );

    expect(identity).toEqual({
      clientId: "dcr-client-1",
      clientSecret: "dcr-secret-1",
      persisted: true,
      mode: "dcr",
      // No `token_endpoint_auth_method` came back, but a secret did: the AS
      // registered us as a confidential client whatever it said.
      tokenEndpointAuthMethod: "client_secret_post",
    });
    expect(fx.bodies).toEqual([
      {
        client_name: "Invisible String",
        redirect_uris: [`${LOCAL_BASE}/integrations/mcp-oauth/callback`],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
        application_type: "web",
      },
    ]);

    // The registration is persisted, secret as a row-bound envelope.
    expect(deps.persisted).toHaveLength(1);
    const stored = deps.persisted[0]!;
    expect(stored.rowId).toBe(row.id);
    expect(stored.clientId).toBe("dcr-client-1");
    expect(stored.clientIdentityMode).toBe("dcr");
    // F13: the registration is filed under the issuer that minted it.
    expect(stored.clientRegistrationIssuer).toBe("https://as.example.com");
    expect(stored.clientSecretEncrypted).not.toBeNull();
    expect(stored.clientSecretEncrypted).not.toContain("dcr-secret-1");
    const envelope = JSON.parse(
      stored.clientSecretEncrypted!,
    ) as EncryptedEnvelope;
    expect(
      decryptSecret(envelope, MASTER_KEY, connectionOauthAad("client_secret", row.id)),
    ).toBe("dcr-secret-1");
    // AAD binds to THIS row: another row id fails authentication.
    expect(() =>
      decryptSecret(
        envelope,
        MASTER_KEY,
        connectionOauthAad("client_secret", "co_cccccccccccccccc"),
      ),
    ).toThrow();
  });

  test("registers once, then reuses the stored registration without another POST", async () => {
    using fx = serveRegistration(() =>
      Response.json(
        { client_id: "dcr-client-2", client_secret: "dcr-secret-2" },
        { status: 201 },
      ),
    );
    const deps = makeDeps(LOCAL_BASE, fetch);
    const discovery = discoveryFixture({ registrationEndpoint: fx.endpoint });
    const row = rowFixture();

    const first = await resolveClientIdentity(deps, discovery, row);
    expect(first.clientId).toBe("dcr-client-2");
    expect(fx.bodies).toHaveLength(1);

    // A later start sees the persisted registration on its row.
    const stored = deps.persisted[0]!;
    const second = await resolveClientIdentity(
      deps,
      discovery,
      rowFixture({
        clientId: stored.clientId,
        clientSecretEncrypted: stored.clientSecretEncrypted,
        clientRegistrationIssuer: stored.clientRegistrationIssuer,
      }),
    );
    expect(second).toEqual({
      clientId: "dcr-client-2",
      clientSecret: "dcr-secret-2",
      persisted: true,
      mode: "dcr",
      tokenEndpointAuthMethod: "client_secret_post",
    });
    expect(fx.bodies).toHaveLength(1); // no second registration
    expect(deps.persisted).toHaveLength(1); // no re-persist
  });

  test("a public-client registration (no secret) persists a null secret", async () => {
    using fx = serveRegistration(() =>
      Response.json({ client_id: "dcr-public-client" }, { status: 200 }),
    );
    const deps = makeDeps(LOCAL_BASE, fetch);
    const identity = await resolveClientIdentity(
      deps,
      discoveryFixture({ registrationEndpoint: fx.endpoint }),
      rowFixture(),
    );
    expect(identity).toEqual({
      clientId: "dcr-public-client",
      clientSecret: null,
      persisted: true,
      mode: "dcr",
      tokenEndpointAuthMethod: "none",
    });
    expect(deps.persisted[0]!.clientSecretEncrypted).toBeNull();
  });

  test("a rejected registration is a typed error carrying status + RFC 7591 error code only", async () => {
    using fx = serveRegistration(() =>
      Response.json(
        {
          error: "invalid_redirect_uri",
          error_description: "http redirect uris are not allowed",
        },
        { status: 400 },
      ),
    );
    const deps = makeDeps(LOCAL_BASE, fetch);
    const error = await expectRegistrationError(
      resolveClientIdentity(
        deps,
        discoveryFixture({ registrationEndpoint: fx.endpoint }),
        rowFixture(),
      ),
    );
    expect(error.message).toContain("400");
    expect(error.message).toContain("invalid_redirect_uri");
    // The free-text description is server-controlled — never surfaced.
    expect(error.message).not.toContain("http redirect uris");
    expect(deps.persisted).toEqual([]);
  });

  test("no registration endpoint and no usable CIMD → typed error", async () => {
    const deps = makeDeps(LOCAL_BASE, neverFetch);
    const error = await expectRegistrationError(
      resolveClientIdentity(deps, discoveryFixture(), rowFixture()),
    );
    expect(error.message).toContain("registration endpoint");
  });

  test("the egress guard's refusal of a private registration endpoint surfaces as the typed error", async () => {
    const deps = makeDeps(
      LOCAL_BASE,
      createGuardedFetch({ allowPrivate: false }),
    );
    const error = await expectRegistrationError(
      resolveClientIdentity(
        deps,
        discoveryFixture({
          registrationEndpoint: "https://127.0.0.1/register",
        }),
        rowFixture(),
      ),
    );
    expect(error.message).toContain("egress");
  });

  test("a corrupt stored secret envelope is mcp_secret_unavailable, not a decrypted value", async () => {
    const deps = makeDeps(LOCAL_BASE, neverFetch);
    const row = rowFixture({
      clientId: "dcr-client-3",
      clientSecretEncrypted: '{"not":"an envelope"}',
      clientRegistrationIssuer: "https://as.example.com",
    });
    const error = await resolveClientIdentity(
      deps,
      discoveryFixture(),
      row,
    ).then(
      () => {
        throw new Error("expected decryption to fail");
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(RuntimeApiError);
    expect((error as RuntimeApiError).code).toBe("mcp_secret_unavailable");
  });
});

describe("resolveClientIdentity — pre-registered clients (fix plan P2b)", () => {
  const VERCEL_ENV = {
    MCP_OAUTH_VERCEL_CLIENT_ID: "vercel-approved-client",
    MCP_OAUTH_VERCEL_CLIENT_SECRET: "vercel-approved-secret",
  };

  test("an operator-configured client wins over CIMD and never registers", async () => {
    const deps = makeDeps(PUBLIC_BASE, neverFetch, preregistered(VERCEL_ENV));
    const row = rowFixture();
    const identity = await resolveClientIdentity(
      deps,
      // Both other strategies are on offer and both are skipped: an operator
      // who configured a client is stating the AS accepts nothing else.
      discoveryFixture({
        clientIdMetadataDocumentSupported: true,
        registrationEndpoint: "https://as.example.com/register",
      }),
      row,
      { providerKey: "vercel", declaredIdentity: "preregistered" },
    );
    expect(identity).toEqual({
      clientId: "vercel-approved-client",
      clientSecret: "vercel-approved-secret",
      persisted: true,
      mode: "preregistered",
      tokenEndpointAuthMethod: "client_secret_post",
    });

    // Persisted like a DCR registration, because refresh and revocation read
    // the identity back off the row long after config was consulted.
    expect(deps.persisted).toHaveLength(1);
    const stored = deps.persisted[0]!;
    expect(stored.clientId).toBe("vercel-approved-client");
    expect(stored.clientIdentityMode).toBe("preregistered");
    expect(stored.clientRegistrationIssuer).toBe("https://as.example.com");
    expect(stored.clientSecretEncrypted).not.toBeNull();
    expect(stored.clientSecretEncrypted).not.toContain("vercel-approved-secret");
    const envelope = JSON.parse(
      stored.clientSecretEncrypted!,
    ) as EncryptedEnvelope;
    expect(
      decryptSecret(
        envelope,
        MASTER_KEY,
        connectionOauthAad("client_secret", row.id),
      ),
    ).toBe("vercel-approved-secret");
  });

  test("it also supersedes a stored DCR registration on the row", async () => {
    const deps = makeDeps(LOCAL_BASE, neverFetch, preregistered(VERCEL_ENV));
    const identity = await resolveClientIdentity(
      deps,
      discoveryFixture(),
      rowFixture({
        clientId: "stale-dcr-client",
        clientRegistrationIssuer: "https://as.example.com",
      }),
      { providerKey: "vercel" },
    );
    expect(identity.clientId).toBe("vercel-approved-client");
    expect(identity.mode).toBe("preregistered");
  });

  test("a public pre-registered client (no secret) authenticates with none", async () => {
    const deps = makeDeps(
      LOCAL_BASE,
      neverFetch,
      preregistered({ MCP_OAUTH_VERCEL_CLIENT_ID: "public-approved-client" }),
    );
    const identity = await resolveClientIdentity(
      deps,
      discoveryFixture(),
      rowFixture(),
      { providerKey: "VERCEL", declaredIdentity: "preregistered" },
    );
    expect(identity).toEqual({
      clientId: "public-approved-client",
      clientSecret: null,
      persisted: true,
      mode: "preregistered",
      tokenEndpointAuthMethod: "none",
    });
    expect(deps.persisted[0]!.clientSecretEncrypted).toBeNull();
  });

  test("a connection with no provider key matches on the pinned issuer", async () => {
    // A custom/registry connection pointed at the same authorization server
    // picks up the same approved identity.
    const deps = makeDeps(
      LOCAL_BASE,
      neverFetch,
      preregistered({
        ...VERCEL_ENV,
        MCP_OAUTH_VERCEL_ISSUER: "https://as.example.com/",
      }),
    );
    const identity = await resolveClientIdentity(
      deps,
      discoveryFixture(),
      rowFixture(),
    );
    expect(identity.clientId).toBe("vercel-approved-client");
  });

  test("a registration pinned to another issuer is NOT replayed at this one", async () => {
    using fx = serveRegistration(() =>
      Response.json({ client_id: "dcr-elsewhere" }, { status: 201 }),
    );
    const deps = makeDeps(
      LOCAL_BASE,
      fetch,
      preregistered({
        ...VERCEL_ENV,
        MCP_OAUTH_VERCEL_ISSUER: "https://other-as.example.com",
      }),
    );
    const identity = await resolveClientIdentity(
      deps,
      discoveryFixture({ registrationEndpoint: fx.endpoint }),
      rowFixture(),
      { providerKey: "vercel" },
    );
    expect(identity.clientId).toBe("dcr-elsewhere");
    expect(identity.mode).toBe("dcr");
  });

  test("a preregistered preset with nothing configured names its env vars and never POSTs", async () => {
    const deps = makeDeps(LOCAL_BASE, neverFetch);
    const error = await expectRegistrationError(
      resolveClientIdentity(
        deps,
        // A registration endpoint IS advertised — we still must not use it:
        // this is exactly the AS whose DCR answers 400 invalid_redirect_uri.
        discoveryFixture({ registrationEndpoint: "https://as.example.com/register" }),
        rowFixture(),
        { providerKey: "vercel", declaredIdentity: "preregistered" },
      ),
    );
    expect(error.message).toContain("MCP_OAUTH_VERCEL_CLIENT_ID");
    expect(error.message).toContain("MCP_OAUTH_VERCEL_CLIENT_SECRET");
    expect(deps.persisted).toEqual([]);
  });

  test("a preregistered preset still reuses an identity already on the row", async () => {
    // Config was removed after a successful connect: the stored client is
    // still an approved one, so the flow keeps working rather than 502ing.
    const deps = makeDeps(LOCAL_BASE, neverFetch);
    const identity = await resolveClientIdentity(
      deps,
      discoveryFixture(),
      rowFixture({
        clientId: "vercel-approved-client",
        clientRegistrationIssuer: "https://as.example.com",
      }),
      { providerKey: "vercel", declaredIdentity: "preregistered" },
    );
    expect(identity.clientId).toBe("vercel-approved-client");
    expect(deps.persisted).toEqual([]);
  });

  test("no configured secret ever reaches the persisted row in plaintext", async () => {
    const deps = makeDeps(LOCAL_BASE, neverFetch, preregistered(VERCEL_ENV));
    await resolveClientIdentity(deps, discoveryFixture(), rowFixture(), {
      providerKey: "vercel",
    });
    expect(JSON.stringify(deps.persisted)).not.toContain(
      "vercel-approved-secret",
    );
  });
});

describe("resolveClientIdentity — DCR credentials are keyed by issuer (F13)", () => {
  test("a stored registration is reused when the issuer still matches", async () => {
    const deps = makeDeps(LOCAL_BASE, neverFetch);
    const identity = await resolveClientIdentity(
      deps,
      discoveryFixture({ authorizationServer: "https://as.example.com/" }),
      rowFixture({
        clientId: "dcr-client-matching",
        clientRegistrationIssuer: "https://as.example.com",
      }),
    );
    expect(identity.clientId).toBe("dcr-client-matching");
    expect(deps.persisted).toEqual([]); // nothing to re-record
  });

  test("a MIGRATED authorization server re-registers instead of replaying a stale client", async () => {
    using fx = serveRegistration(() =>
      Response.json(
        { client_id: "dcr-client-new-as", client_secret: "new-as-secret" },
        { status: 201 },
      ),
    );
    const deps = makeDeps(LOCAL_BASE, fetch);
    const identity = await resolveClientIdentity(
      deps,
      discoveryFixture({
        authorizationServer: "https://new-as.example.com",
        registrationEndpoint: fx.endpoint,
      }),
      rowFixture({
        clientId: "dcr-client-old-as",
        clientSecretEncrypted: "{}",
        clientRegistrationIssuer: "https://old-as.example.com",
      }),
    );
    expect(identity.clientId).toBe("dcr-client-new-as");
    expect(fx.bodies).toHaveLength(1);
    expect(deps.persisted).toHaveLength(1);
    expect(deps.persisted[0]!.clientRegistrationIssuer).toBe(
      "https://new-as.example.com",
    );
    // The old client id is gone from the row, not shadowed beside it.
    expect(deps.persisted[0]!.clientId).toBe("dcr-client-new-as");
  });

  test("a row predating the column is reused and BACKFILLED with the issuer", async () => {
    const deps = makeDeps(LOCAL_BASE, neverFetch);
    const identity = await resolveClientIdentity(
      deps,
      discoveryFixture(),
      rowFixture({ clientId: "legacy-dcr-client" }),
    );
    // Reused: an unrecorded issuer is not evidence of a CHANGED issuer, and
    // re-registering here would strand the row's live tokens on a client id
    // it no longer carries.
    expect(identity.clientId).toBe("legacy-dcr-client");
    expect(deps.persisted).toEqual([
      {
        rowId: "co_aaaaaaaaaaaaaaaa",
        clientId: "legacy-dcr-client",
        clientSecretEncrypted: null,
        clientIdentityMode: "dcr",
        clientRegistrationIssuer: "https://as.example.com",
      },
    ]);
  });

  test("the registration is filed under the AS metadata's own issuer", async () => {
    // Not the PRM's `authorization_servers` entry: that document is served by
    // the MCP SERVER, which is the party an AS mix-up is mounted from. The
    // metadata issuer is the AS's own claim and the string a callback echoes
    // as `iss`.
    using fx = serveRegistration(() =>
      Response.json({ client_id: "dcr-validated-issuer" }, { status: 201 }),
    );
    const deps = makeDeps(LOCAL_BASE, fetch);
    await resolveClientIdentity(
      deps,
      discoveryFixture({
        registrationEndpoint: fx.endpoint,
        issuer: "https://as.example.com/tenant-a",
      }),
      rowFixture(),
    );
    expect(deps.persisted[0]!.clientRegistrationIssuer).toBe(
      "https://as.example.com/tenant-a",
    );
  });

  test("issuers compare canonically — a trailing slash is not a migration", async () => {
    const deps = makeDeps(LOCAL_BASE, neverFetch);
    const identity = await resolveClientIdentity(
      deps,
      discoveryFixture({ authorizationServer: "https://as.example.com/" }),
      rowFixture({
        clientId: "dcr-client-slash",
        clientRegistrationIssuer: "https://as.example.com",
      }),
    );
    expect(identity.clientId).toBe("dcr-client-slash");
    expect(deps.persisted).toEqual([]);
  });
});

describe("resolveClientIdentity — token endpoint auth method", () => {
  test("the DCR request asks for a method the AS actually supports", async () => {
    using fx = serveRegistration(() =>
      Response.json(
        {
          client_id: "dcr-basic-client",
          client_secret: "basic-secret",
          token_endpoint_auth_method: "client_secret_basic",
        },
        { status: 201 },
      ),
    );
    const deps = makeDeps(LOCAL_BASE, fetch);
    const identity = await resolveClientIdentity(
      deps,
      {
        ...discoveryFixture({ registrationEndpoint: fx.endpoint }),
        // Not yet an `OauthDiscovery` field — see `DiscoveryWithAuthMethods`.
        tokenEndpointAuthMethodsSupported: ["client_secret_basic"],
      } as OauthDiscovery,
      rowFixture(),
    );
    expect(
      (fx.bodies[0] as { token_endpoint_auth_method: string })
        .token_endpoint_auth_method,
    ).toBe("client_secret_basic");
    // And what the AS REGISTERED wins over what we asked for.
    expect(identity.tokenEndpointAuthMethod).toBe("client_secret_basic");
  });

  test("an unexecutable registered method degrades to the secret's presence", async () => {
    using fx = serveRegistration(() =>
      Response.json(
        {
          client_id: "dcr-jwt-client",
          client_secret: "jwt-secret",
          token_endpoint_auth_method: "private_key_jwt",
        },
        { status: 201 },
      ),
    );
    const deps = makeDeps(LOCAL_BASE, fetch);
    const identity = await resolveClientIdentity(
      deps,
      discoveryFixture({ registrationEndpoint: fx.endpoint }),
      rowFixture(),
    );
    expect(identity.tokenEndpointAuthMethod).toBe("client_secret_post");
  });
});

describe("client metadata document + route", () => {
  test("the document is the same identity DCR registers, client_id = its own URL", () => {
    const doc = buildClientMetadataDocument(PUBLIC_BASE);
    expect(doc).toEqual({
      client_id: clientMetadataUrl(PUBLIC_BASE),
      client_name: "Invisible String",
      redirect_uris: [mcpOauthRedirectUri(PUBLIC_BASE)],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    });
    expect(doc.client_id).toBe(
      `${PUBLIC_BASE}/integrations/mcp-oauth/client-metadata.json`,
    );
  });

  test("GET /integrations/mcp-oauth/client-metadata.json serves the document", async () => {
    const app = mcpOauthClientMetadataRoute(PUBLIC_BASE);
    const res = await app.handle(
      new Request(
        `${PUBLIC_BASE}/integrations/mcp-oauth/client-metadata.json`,
      ),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    const doc = (await res.json()) as Record<string, unknown>;
    expect(doc).toEqual({ ...buildClientMetadataDocument(PUBLIC_BASE) });
    expect(doc.redirect_uris).toEqual([
      `${PUBLIC_BASE}/integrations/mcp-oauth/callback`,
    ]);
  });
});
