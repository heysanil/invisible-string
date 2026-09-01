/**
 * Catalog contract + the OAuth PREFLIGHT (2026-08-31 OAuth fix plan P2.1).
 *
 * The oauth case here used to claim "every oauth entry was verified live" in a
 * comment and then assert only that the recipe equalled `{type:"oauth"}`. A
 * shape assertion cannot verify a provider, which is exactly how the Vercel
 * preset shipped promising a flow this broker can never complete (fix plan F2:
 * Vercel's AS omits `client_id_metadata_document_supported`, so the broker
 * falls through to DCR, and its registration endpoint answers `400
 * invalid_redirect_uri` to every client it has not approved — surfacing as a
 * 502 `oauth_registration_failed` behind an already-open consent popup).
 *
 * The claim is therefore split in two:
 *
 * - OFFLINE (default lane): every oauth preset must DECLARE a client-identity
 *   strategy the broker can execute, and a `preregistered` one must name the
 *   operator config it needs. Plus a named-host regression — a provider proven
 *   to gate client registration may not re-enter the catalog as `dynamic`.
 * - GATED (`CATALOG_PREFLIGHT=1`, network): every `dynamic` preset is walked
 *   live — PRM → AS metadata → CIMD or a registration endpoint that actually
 *   accepts this deployment's redirect URI, the DCR POST going out shaped like
 *   the broker's own. That is the assertion that would have caught Vercel.
 *
 * The gated half re-implements a compact discovery walk instead of importing
 * `apps/control-plane/src/oauth/discovery.ts`, because `packages/shared` may
 * not depend on an app. It mirrors that module's candidate order (challenge
 * pointer → path-aware PRM → root PRM; RFC 8414 path-inserted → OIDC →
 * root variants) and the DCR body in `oauth/client-identity.ts` — keep the two
 * in step, and prefer widening this walk over weakening an assertion.
 *
 * Secrets discipline: a registration response may carry a `client_secret`.
 * Nothing here ever prints a response body — only statuses, RFC 7591 `error`
 * codes, and URLs reach an assertion message.
 */
import { describe, expect, test } from "bun:test";
import raw from "./connector-catalog.json";
import {
  connectorAuthRecipeSchema,
  connectorOauthClientIdentity,
  parseConnectorCatalog,
  preregisteredClientEnvVars,
  type ConnectorCatalogEntry,
} from "./connector-catalog";

const CATALOG = parseConnectorCatalog(raw);
const OAUTH_ENTRIES = CATALOG.filter((e) => e.auth.type === "oauth");

/**
 * Providers proven to gate OAuth client registration. A preset on one of these
 * hosts is shippable ONLY as `preregistered` with real operator credentials
 * (fix plan §3 / P2 option (b)); as `dynamic` it is a guaranteed 502 after the
 * consent popup opens. Add a host here the moment a live preflight rejects one.
 */
const REGISTRATION_GATED_HOSTS: Record<string, string> = {
  "mcp.vercel.com":
    "Vercel's AS omits client_id_metadata_document_supported and its registration endpoint answers 400 invalid_redirect_uri to unapproved clients (fix plan F2, reproduced live twice)",
};

describe("connector catalog", () => {
  test("the checked-in catalog parses", () => {
    const entries = parseConnectorCatalog(raw);
    expect(entries.length).toBeGreaterThanOrEqual(4);
  });
  test("slugs are unique, urls https, transports streamable-http", () => {
    const entries = parseConnectorCatalog(raw);
    const slugs = new Set(entries.map((e) => e.slug));
    expect(slugs.size).toBe(entries.length);
    for (const e of entries) {
      expect(e.url.startsWith("https://")).toBe(true);
      expect(e.transport).toBe("streamable-http");
    }
  });
  test("duplicate slugs are rejected", () => {
    const entries = parseConnectorCatalog(raw);
    expect(() => parseConnectorCatalog([...entries, entries[0]])).toThrow(
      /duplicate/i,
    );
  });
});

describe("oauth client-identity recipes", () => {
  test("a bare oauth recipe still parses, and means `dynamic`", () => {
    const parsed = connectorAuthRecipeSchema.parse({ type: "oauth" });
    expect(connectorOauthClientIdentity(parsed)).toBe("dynamic");
  });

  test("preregistered requires an env prefix; dynamic forbids one", () => {
    expect(
      connectorAuthRecipeSchema.safeParse({
        type: "oauth",
        clientIdentity: "preregistered",
        clientEnvPrefix: "VERCEL",
      }).success,
    ).toBe(true);
    // A preregistered recipe with nowhere to read credentials from is the
    // failure this whole field exists to prevent.
    expect(
      connectorAuthRecipeSchema.safeParse({
        type: "oauth",
        clientIdentity: "preregistered",
      }).success,
    ).toBe(false);
    // …and a prefix on a dynamic recipe promises operator config nothing reads.
    expect(
      connectorAuthRecipeSchema.safeParse({
        type: "oauth",
        clientEnvPrefix: "VERCEL",
      }).success,
    ).toBe(false);
    expect(
      connectorAuthRecipeSchema.safeParse({
        type: "oauth",
        clientIdentity: "preregistered",
        clientEnvPrefix: "not-upper-snake",
      }).success,
    ).toBe(false);
  });

  test("the env-var contract is derived, never hand-spelled", () => {
    expect(preregisteredClientEnvVars("VERCEL")).toEqual({
      clientId: "MCP_OAUTH_VERCEL_CLIENT_ID",
      clientSecret: "MCP_OAUTH_VERCEL_CLIENT_SECRET",
    });
  });

  test("a bad entry fails the catalog parse with slug context", () => {
    expect(() =>
      parseConnectorCatalog([
        {
          ...CATALOG[0]!,
          slug: "broken",
          auth: { type: "oauth", clientIdentity: "preregistered" },
        },
      ]),
    ).toThrow(/broken/);
  });
});

// ── Preflight: offline half ──────────────────────────────────────────────────

describe("oauth catalog preflight (offline)", () => {
  test("every oauth preset declares a strategy the broker can execute", () => {
    expect(OAUTH_ENTRIES.length).toBeGreaterThanOrEqual(4);
    for (const entry of OAUTH_ENTRIES) {
      const identity = connectorOauthClientIdentity(entry.auth);
      // Widening the enum without teaching the broker the new strategy must
      // fail here, not at a user's consent popup.
      expect([entry.slug, identity]).toEqual([
        entry.slug,
        expect.stringMatching(/^(dynamic|preregistered)$/),
      ]);
    }
  });

  test("preregistered presets name the operator credentials they need", () => {
    for (const entry of OAUTH_ENTRIES) {
      if (entry.auth.type !== "oauth") continue;
      if (entry.auth.clientIdentity !== "preregistered") continue;
      const prefix = entry.auth.clientEnvPrefix!;
      const vars = preregisteredClientEnvVars(prefix);
      expect([entry.slug, vars.clientId]).toEqual([
        entry.slug,
        `MCP_OAUTH_${prefix}_CLIENT_ID`,
      ]);
      expect(vars.clientSecret).not.toBe(vars.clientId);
    }
  });

  test("no preset sits on a registration-gated host as `dynamic`", () => {
    for (const entry of CATALOG) {
      const host = new URL(entry.url).hostname.toLowerCase();
      const reason = REGISTRATION_GATED_HOSTS[host];
      if (reason === undefined) continue;
      const identity =
        entry.auth.type === "oauth"
          ? connectorOauthClientIdentity(entry.auth)
          : null;
      expect([entry.slug, host, identity]).toEqual([
        entry.slug,
        host,
        "preregistered",
      ]);
    }
  });

  test("the featured oauth trio is still featured", () => {
    for (const slug of ["linear", "notion", "sentry"]) {
      const entry = CATALOG.find((e) => e.slug === slug);
      expect(entry?.auth.type).toBe("oauth");
      expect(entry?.featured).toBe(true);
    }
  });
});

// ── Preflight: gated live half ───────────────────────────────────────────────

/** `CATALOG_PREFLIGHT=1` — the network lane. The default lane stays offline. */
const PREFLIGHT = process.env.CATALOG_PREFLIGHT === "1";
/**
 * The deployment whose redirect URI is being preflighted: the same
 * `PUBLIC_APP_URL` the broker derives its callback from, so an allowlisting AS
 * is asked about the URI it would really see. An open registration endpoint
 * accepts any public https redirect, so the fallback is only a stand-in.
 */
const PREFLIGHT_APP_URL = (() => {
  const configured = process.env.PUBLIC_APP_URL?.trim() ?? "";
  return configured.startsWith("https://")
    ? configured.replace(/\/+$/, "")
    : "https://app.invisiblestring.io";
})();
const PREFLIGHT_TIMEOUT_MS = 15_000;

describe.skipIf(!PREFLIGHT)("oauth catalog preflight (live)", () => {
  for (const entry of OAUTH_ENTRIES) {
    if (entry.auth.type !== "oauth") continue;
    const identity = connectorOauthClientIdentity(entry.auth);
    // A preregistered preset has nothing dynamic to verify: its credentials
    // come from operator config, and the AS gates registration by design.
    test.skipIf(identity !== "dynamic")(
      `${entry.slug} — the broker can obtain a client identity for ${entry.url}`,
      async () => {
        const outcome = await preflightDynamicOauth(entry);
        expect([entry.slug, outcome.strategy]).toEqual([
          entry.slug,
          expect.stringMatching(/^(cimd|dcr)$/),
        ]);
      },
      PREFLIGHT_TIMEOUT_MS * 3,
    );
  }
});

interface PreflightOutcome {
  strategy: "cimd" | "dcr";
}

/**
 * Walk a `dynamic` preset the way the broker would and prove one of the two
 * strategies is actually available: CIMD advertised, or a registration
 * endpoint that accepts this deployment's redirect URI. Throws with the hop
 * that failed — an unusable preset must not reach the catalog.
 */
async function preflightDynamicOauth(
  entry: ConnectorCatalogEntry,
): Promise<PreflightOutcome> {
  const resourceUrl = new URL(entry.url);
  const prm = await fetchPrm(resourceUrl);
  const issuer = prm.authorization_servers?.[0];
  if (issuer === undefined) {
    throw new Error(
      `${entry.slug}: PRM for ${resourceUrl.href} advertises no authorization_servers`,
    );
  }
  const meta = await fetchAsMetadata(issuer);
  if (!meta.code_challenge_methods_supported?.includes("S256")) {
    throw new Error(
      `${entry.slug}: ${issuer} does not advertise S256 — the broker requires PKCE`,
    );
  }
  if (meta.client_id_metadata_document_supported === true) {
    return { strategy: "cimd" };
  }
  if (typeof meta.registration_endpoint !== "string") {
    throw new Error(
      `${entry.slug}: ${issuer} offers neither CIMD nor a registration endpoint — this preset needs clientIdentity "preregistered"`,
    );
  }
  await probeRegistration(entry, meta.registration_endpoint);
  return { strategy: "dcr" };
}

/**
 * POST the broker's own DCR body. Registration is the ONLY way to learn that
 * an endpoint allowlists redirect URIs (Vercel's 400 `invalid_redirect_uri`),
 * so the preflight really registers, then best-effort deletes the client again
 * via RFC 7592 when the AS hands back management credentials.
 */
async function probeRegistration(
  entry: ConnectorCatalogEntry,
  endpoint: string,
): Promise<void> {
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "Invisible String",
      redirect_uris: [`${PREFLIGHT_APP_URL}/integrations/mcp-oauth/callback`],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
    signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
  });
  const body = (await readJson(res)) as Record<string, unknown> | null;
  if (res.status !== 200 && res.status !== 201) {
    const code = typeof body?.error === "string" ? `: ${body.error}` : "";
    throw new Error(
      `${entry.slug}: ${endpoint} rejected the broker's registration (HTTP ${res.status}${code}) — this preset needs clientIdentity "preregistered"`,
    );
  }
  if (typeof body?.client_id !== "string") {
    throw new Error(
      `${entry.slug}: ${endpoint} returned no client_id`,
    );
  }
  // Housekeeping only; a provider without RFC 7592 simply keeps the record.
  const manageUrl = body.registration_client_uri;
  const manageToken = body.registration_access_token;
  if (typeof manageUrl === "string" && typeof manageToken === "string") {
    await fetch(manageUrl, {
      method: "DELETE",
      headers: { authorization: `Bearer ${manageToken}` },
      signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
    }).catch(() => undefined);
  }
}

interface PrmDocument {
  resource?: string;
  authorization_servers?: string[];
}
interface AsMetadataDocument {
  registration_endpoint?: unknown;
  code_challenge_methods_supported?: string[];
  client_id_metadata_document_supported?: boolean;
}

/** Challenge pointer → path-aware well-known → root well-known (spec order). */
async function fetchPrm(resourceUrl: URL): Promise<PrmDocument> {
  const candidates: string[] = [];
  const pointer = await challengePointer(resourceUrl);
  if (pointer !== null) candidates.push(pointer);
  const path = resourceUrl.pathname.replace(/^\/+|\/+$/g, "");
  if (path !== "") {
    candidates.push(
      `${resourceUrl.origin}/.well-known/oauth-protected-resource/${path}`,
    );
  }
  candidates.push(`${resourceUrl.origin}/.well-known/oauth-protected-resource`);
  for (const candidate of new Set(candidates)) {
    const doc = (await getJson(candidate)) as PrmDocument | null;
    if (doc?.authorization_servers?.length) return doc;
  }
  throw new Error(
    `no usable protected-resource metadata for ${resourceUrl.href}`,
  );
}

async function fetchAsMetadata(issuer: string): Promise<AsMetadataDocument> {
  const issuerUrl = new URL(issuer);
  const path = issuerUrl.pathname.replace(/^\/+|\/+$/g, "");
  const variants =
    path !== ""
      ? [
          `${issuerUrl.origin}/.well-known/oauth-authorization-server/${path}`,
          `${issuerUrl.origin}/${path}/.well-known/openid-configuration`,
          `${issuerUrl.origin}/.well-known/oauth-authorization-server`,
          `${issuerUrl.origin}/.well-known/openid-configuration`,
        ]
      : [
          `${issuerUrl.origin}/.well-known/oauth-authorization-server`,
          `${issuerUrl.origin}/.well-known/openid-configuration`,
        ];
  for (const variant of new Set(variants)) {
    const doc = (await getJson(variant)) as AsMetadataDocument | null;
    if (doc !== null) return doc;
  }
  throw new Error(`no authorization server metadata for issuer ${issuer}`);
}

async function challengePointer(resourceUrl: URL): Promise<string | null> {
  let res: Response;
  try {
    res = await fetch(resourceUrl.href, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  // Never read the body: a GET on a streamable MCP endpoint may be an
  // unbounded SSE stream.
  void res.body?.cancel().catch(() => {});
  if (res.status !== 401) return null;
  const header = res.headers.get("www-authenticate");
  if (header === null) return null;
  const match = /resource_metadata\s*=\s*(?:"([^"]*)"|([^\s,;]+))/i.exec(header);
  const rawPointer = match?.[1] ?? match?.[2];
  if (rawPointer === undefined || rawPointer === "") return null;
  try {
    return new URL(rawPointer, resourceUrl).href;
  } catch {
    return null;
  }
}

async function getJson(url: string): Promise<unknown> {
  let res: Response;
  try {
    res = await fetch(url, {
      headers: { accept: "application/json" },
      signal: AbortSignal.timeout(PREFLIGHT_TIMEOUT_MS),
    });
  } catch {
    return null;
  }
  if (res.status !== 200) {
    void res.body?.cancel().catch(() => {});
    return null;
  }
  return readJson(res);
}

async function readJson(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}
