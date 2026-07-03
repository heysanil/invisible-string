/**
 * Better Auth instance (spec §2 locked): email/password + organization
 * plugin (workspace = organization, creator becomes `owner`) + generic
 * OIDC SSO via @better-auth/sso (Dex in dev/CI, Entra ID first prod IdP).
 */
import { sso } from "@better-auth/sso";
import { betterAuth } from "better-auth";
import { drizzleAdapter } from "better-auth/adapters/drizzle";
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
    },
    // SPA origins (cookies flow cross-origin in dev) + extra origins such as
    // a non-public OIDC issuer (Dex) that SSO discovery must trust.
    trustedOrigins: [...config.corsOrigins, ...config.trustedOrigins],
    plugins: [
      organization({
        creatorRole: "owner",
      }),
      sso(),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
