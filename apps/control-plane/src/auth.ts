/**
 * Better Auth instance (spec §2 locked): email/password + organization
 * plugin (workspace = organization, creator becomes `owner`) + generic
 * OIDC SSO via @better-auth/sso (Dex in dev/CI, Entra ID first prod IdP).
 *
 * SSO hardening (spec §11 threat model — do not relax):
 * - `domainVerification.enabled` — a provider cannot serve sign-ins until its
 *   domain is verified (DNS TXT token), so nobody can stand up an IdP that
 *   claims someone else's domain and mint accounts for it.
 * - `disableImplicitSignUp` — SSO sign-in never auto-creates platform
 *   accounts; sign-up must be explicit (`requestSignUp`).
 * - Provider registration is organization-scoped ONLY (before-hook rejects
 *   registrations without `organizationId`); the sso plugin then enforces
 *   that the caller is an owner/admin member of that organization. This
 *   closes the self-registration hole where any authenticated user could
 *   register a user-owned provider for an arbitrary issuer/domain.
 * - Never enable `organizationProvisioning`/`provisionUser` for providers
 *   whose domain is not verified (org auto-provisioning lands in Phase 2+).
 */
import { sso } from "@better-auth/sso";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { organization } from "better-auth/plugins";

import { authSchema } from "./auth-schema";
import type { Config } from "./config";
import type { Db } from "./db";

export function createAuth(config: Config, db: Db) {
  return betterAuth({
    baseURL: config.betterAuthUrl,
    basePath: "/api/auth",
    secret: config.betterAuthSecret,
    database: drizzleAdapter(db, {
      provider: "pg",
      schema: authSchema,
    }),
    emailAndPassword: {
      enabled: true,
      // Env-gated (AUTH_REQUIRE_EMAIL_VERIFICATION): local/CI stacks have no
      // mailer yet; production must enable this before any trust decision
      // (account linking, domain-based org membership) reads `emailVerified`.
      requireEmailVerification: config.requireEmailVerification,
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        // SSO providers must be organization-scoped: with an organizationId
        // the sso plugin itself enforces owner/admin membership; without one
        // it would create a user-owned provider gated only by a count limit.
        if (ctx.path === "/sso/register") {
          const organizationId = (
            ctx.body as { organizationId?: unknown } | undefined
          )?.organizationId;
          if (typeof organizationId !== "string" || organizationId === "") {
            throw new APIError("BAD_REQUEST", {
              message:
                "SSO providers must be registered to an organization (organizationId required)",
            });
          }
        }
      }),
    },
    // SPA origins (cookies flow cross-origin in dev) + extra origins such as
    // a non-public OIDC issuer (Dex) that SSO discovery must trust.
    trustedOrigins: [...config.corsOrigins, ...config.trustedOrigins],
    plugins: [
      organization({
        creatorRole: "owner",
      }),
      sso({
        domainVerification: { enabled: true },
        disableImplicitSignUp: true,
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
