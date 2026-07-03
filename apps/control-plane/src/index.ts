import { Elysia } from "elysia";

/**
 * Control plane (Bun + Elysia) — placeholder skeleton.
 *
 * Phase 0 tasks 3-6 add: Better Auth (email/pw + OIDC SSO + orgs), Drizzle
 * product DB, workspace-scoping middleware, and the secrets envelope module.
 * Phase 1 adds the compiler invocation, `eve build` + artifact upload,
 * scheduler, dispatcher, and the runtime API.
 */
export const app = new Elysia().get("/health", () => ({ status: "ok" }));

if (import.meta.main) {
  const port = Number(process.env.PORT ?? 3000);
  app.listen(port);
  console.log(`control-plane listening on :${port}`);
}
