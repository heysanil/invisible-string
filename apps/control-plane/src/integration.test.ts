/**
 * DB-backed integration tests — gated on TEST_DATABASE_URL (spec: skip
 * cleanly when unset; the compose integration stage provides it).
 *
 * Run locally with isolated services:
 *   POSTGRES_PORT=5441 DEX_PORT=5557 docker compose -p p0auth up -d postgres dex
 *   TEST_DATABASE_URL=postgres://dev:dev@localhost:5441/product \
 *     DEX_ISSUER=http://localhost:5557/dex bun test src/integration.test.ts
 *   docker compose -p p0auth down
 *
 * Covered here (server-side, no browser):
 * - email/password sign-up → create organization → set active → the login
 *   session carries `activeOrganizationId`, creator role is `owner`
 * - the workspace-scoping macro end-to-end against real session storage
 * - SSO: register Dex as a generic OIDC provider via the sso plugin API and
 *   assert the sign-in redirect URL shape (authorization endpoint, client_id,
 *   redirect_uri = /api/auth/sso/callback/dex, response_type=code, state).
 *
 * NOT covered here — Phase 2 Playwright E2E will drive the full browser
 * dance against the compose stack: follow the sign-in redirect to Dex, log
 * in with the static test user (test@example.com / password), Dex redirects
 * to /api/auth/sso/callback/dex, Better Auth exchanges the code, provisions
 * the user, sets the session cookie, and lands on callbackURL with an
 * authenticated session (+ SSO-provisioned org membership when the provider
 * is linked to an organization).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { Elysia } from "elysia";

import { member, ssoProvider } from "./auth-schema";
import { runMigrations } from "./migrate";
import { createAppStack, type AppStack } from "./index";
import { createWorkspaceDeps, workspacePlugin } from "./workspace";

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;
const DEX_ISSUER = process.env.DEX_ISSUER ?? "http://localhost:5556/dex";
const BASE_URL = "http://localhost:3000";

/** Probe Dex's OIDC discovery document (short timeout, absent in unit CI). */
async function probeDexDiscovery(): Promise<Record<string, string> | null> {
  try {
    const res = await fetch(`${DEX_ISSUER}/.well-known/openid-configuration`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    return (await res.json()) as Record<string, string>;
  } catch {
    return null;
  }
}

describe.skipIf(!TEST_DATABASE_URL)(
  "auth integration (set TEST_DATABASE_URL to run)",
  () => {
    let stack: AppStack;

    beforeAll(async () => {
      await runMigrations(TEST_DATABASE_URL!);
      stack = createAppStack({
        DATABASE_URL: TEST_DATABASE_URL!,
        BETTER_AUTH_SECRET: "integration-test-secret",
        BETTER_AUTH_URL: BASE_URL,
        // Dex runs on localhost (not publicly routable) — its origin must be
        // trusted for OIDC discovery / endpoint validation.
        TRUSTED_ORIGINS: new URL(DEX_ISSUER).origin,
      });
    });

    afterAll(async () => {
      await stack?.close();
    });

    /** Sign up a fresh user over the mounted HTTP handler; return cookies. */
    async function signUp(): Promise<{ headers: Headers; email: string }> {
      const email = `it-${randomUUID()}@example.com`;
      const res = await stack.app.handle(
        new Request(`${BASE_URL}/api/auth/sign-up/email`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            email,
            password: "correct-horse-battery",
            name: "Integration Test",
          }),
        }),
      );
      expect(res.status).toBe(200);
      const setCookie = res.headers.getSetCookie();
      expect(setCookie.length).toBeGreaterThan(0);
      const cookie = setCookie
        .map((c) => c.split(";")[0]!)
        .join("; ");
      return { headers: new Headers({ cookie }), email };
    }

    test("sign-up → create org → session has activeOrganizationId, creator is owner", async () => {
      const { headers } = await signUp();

      const slug = `ws-${randomUUID().slice(0, 8)}`;
      const org = await stack.auth.api.createOrganization({
        body: { name: "Test Workspace", slug },
        headers,
      });
      expect(org?.id).toBeTruthy();
      expect(org?.slug).toBe(slug);

      await stack.auth.api.setActiveOrganization({
        body: { organizationId: org!.id },
        headers,
      });

      const session = await stack.auth.api.getSession({ headers });
      expect(session).not.toBeNull();
      expect(
        (session!.session as { activeOrganizationId?: string | null })
          .activeOrganizationId,
      ).toBe(org!.id);

      // organization({ creatorRole: "owner" }): creator's member row is owner.
      const rows = await stack.dbHandle.db
        .select({ role: member.role })
        .from(member)
        .where(
          and(
            eq(member.organizationId, org!.id),
            eq(member.userId, session!.user.id),
          ),
        );
      expect(rows).toEqual([{ role: "owner" }]);
    });

    test("workspace macro grants access with a real session and denies without", async () => {
      const { headers } = await signUp();
      const org = await stack.auth.api.createOrganization({
        body: { name: "Scoped Workspace", slug: `ws-${randomUUID().slice(0, 8)}` },
        headers,
      });
      await stack.auth.api.setActiveOrganization({
        body: { organizationId: org!.id },
        headers,
      });

      const app = new Elysia()
        .use(
          workspacePlugin(
            createWorkspaceDeps(stack.auth, stack.dbHandle.db),
          ),
        )
        .get("/scoped", ({ workspace }) => workspace, {
          requireWorkspace: true,
        })
        .get("/owner-only", () => ({ allowed: true }), {
          requireWorkspace: "owner",
        });

      // Authenticated member (creator = owner) passes both.
      const ok = await app.handle(
        new Request("http://localhost/scoped", {
          headers: { cookie: headers.get("cookie")! },
        }),
      );
      expect(ok.status).toBe(200);
      const ws = (await ok.json()) as { organizationId: string; role: string };
      expect(ws.organizationId).toBe(org!.id);
      expect(ws.role).toBe("owner");

      const ownerOk = await app.handle(
        new Request("http://localhost/owner-only", {
          headers: { cookie: headers.get("cookie")! },
        }),
      );
      expect(ownerOk.status).toBe(200);

      // No cookie → 401.
      const anon = await app.handle(new Request("http://localhost/scoped"));
      expect(anon.status).toBe(401);
    });

    test("SSO: register Dex (OIDC) and assert the sign-in redirect shape", async () => {
      const { headers } = await signUp();
      const discovery = await probeDexDiscovery();

      // providerId must be "dex" (it is baked into Dex's registered redirect
      // URI) — remove any row left by a previous run so the test is idempotent.
      await stack.dbHandle.db
        .delete(ssoProvider)
        .where(eq(ssoProvider.providerId, "dex"));

      // Prefer live discovery against Dex; fall back to explicit endpoints
      // (skipDiscovery) so this test still runs DB-only environments.
      const oidcConfig = discovery
        ? { clientId: "invisible-string", clientSecret: "dev-secret" }
        : {
            clientId: "invisible-string",
            clientSecret: "dev-secret",
            skipDiscovery: true,
            authorizationEndpoint: `${DEX_ISSUER}/auth`,
            tokenEndpoint: `${DEX_ISSUER}/token`,
            jwksEndpoint: `${DEX_ISSUER}/keys`,
          };

      const provider = await stack.auth.api.registerSSOProvider({
        body: {
          providerId: "dex",
          issuer: DEX_ISSUER,
          domain: "example.com",
          oidcConfig,
        },
        headers,
      });
      expect(provider).toBeTruthy();

      const signIn = await stack.auth.api.signInSSO({
        body: {
          providerId: "dex",
          callbackURL: `${BASE_URL}/`,
        },
      });
      expect(signIn.redirect).toBe(true);
      expect(signIn.url).toBeTruthy();

      const url = new URL(signIn.url!);
      const expectedAuthEndpoint =
        discovery?.authorization_endpoint ?? `${DEX_ISSUER}/auth`;
      expect(`${url.origin}${url.pathname}`).toBe(expectedAuthEndpoint);
      expect(url.searchParams.get("client_id")).toBe("invisible-string");
      expect(url.searchParams.get("response_type")).toBe("code");
      expect(url.searchParams.get("redirect_uri")).toBe(
        `${BASE_URL}/api/auth/sso/callback/dex`,
      );
      expect(url.searchParams.get("state")).toBeTruthy();
      expect(url.searchParams.get("scope")).toContain("openid");
    });
  },
);
