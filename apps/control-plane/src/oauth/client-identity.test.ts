import { describe, expect, test } from "bun:test";

import {
  decryptSecret,
  generateMasterKeyBase64,
  parseMasterKey,
  type EncryptedEnvelope,
} from "@invisible-string/shared";

import { mcpOauthClientMetadataRoute } from "../integrations/routes";
import { createGuardedFetch } from "../net/guarded-fetch";
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
  return {
    resource: "https://mcp.example.com/mcp",
    authorizationServer: "https://as.example.com",
    authorizationEndpoint: "https://as.example.com/authorize",
    tokenEndpoint: "https://as.example.com/token",
    ...overrides,
  };
}

function rowFixture(
  overrides: Partial<ClientRegistrationRow> = {},
): ClientRegistrationRow {
  return {
    id: "co_aaaaaaaaaaaaaaaa",
    connectionId: "cn_bbbbbbbbbbbbbbbb",
    clientId: null,
    clientSecretEncrypted: null,
    ...overrides,
  };
}

interface RecordedRegistration {
  rowId: string;
  clientId: string;
  clientSecretEncrypted: string | null;
}

function makeDeps(
  publicAppUrl: string,
  fetchImpl: typeof fetch,
): ClientIdentityDeps & { persisted: RecordedRegistration[] } {
  const persisted: RecordedRegistration[] = [];
  return {
    publicAppUrl,
    fetchImpl,
    masterKey: MASTER_KEY,
    persistRegistration: async (rowId, values) => {
      persisted.push({ rowId, ...values });
    },
    persisted,
  };
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
    });
    expect(fx.bodies).toEqual([
      {
        client_name: "Invisible String",
        redirect_uris: [`${LOCAL_BASE}/integrations/mcp-oauth/callback`],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
    ]);

    // The registration is persisted, secret as a row-bound envelope.
    expect(deps.persisted).toHaveLength(1);
    const stored = deps.persisted[0]!;
    expect(stored.rowId).toBe(row.id);
    expect(stored.clientId).toBe("dcr-client-1");
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
      }),
    );
    expect(second).toEqual({
      clientId: "dcr-client-2",
      clientSecret: "dcr-secret-2",
      persisted: true,
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
