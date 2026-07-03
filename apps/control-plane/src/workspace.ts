/**
 * Workspace scoping (spec §11 authorization): every product route runs in the
 * context of the caller's **active organization** (= workspace). This module
 * provides:
 *
 * - `resolveWorkspace` — pure guard logic (unit-testable with mocked lookups):
 *   401 when unauthenticated, 403 when no active workspace or not a member,
 *   403 when the member's role is below a required role.
 * - `requireRole('owner'|'admin'|'member')` — role guard helper (owner ⊃
 *   admin ⊃ member; Better Auth stores multi-roles comma-separated).
 * - `workspacePlugin` — an Elysia macro `requireWorkspace` that resolves the
 *   Better Auth session from request headers and injects `workspace` into the
 *   handler context.
 */
import { and, eq } from "drizzle-orm";
import { Elysia } from "elysia";

import { member } from "./auth-schema";
import type { Auth } from "./auth";
import type { Db } from "./db";

export type Role = "owner" | "admin" | "member";

const ROLE_RANK: Record<Role, number> = { member: 0, admin: 1, owner: 2 };

function isRole(value: string): value is Role {
  return value in ROLE_RANK;
}

/**
 * Does `memberRole` (possibly comma-separated, e.g. "admin,member") satisfy
 * `required`? Higher roles imply lower ones: owner ⊇ admin ⊇ member.
 */
export function hasRole(memberRole: string, required: Role): boolean {
  const ranks = memberRole
    .split(",")
    .map((r) => r.trim())
    .filter(isRole)
    .map((r) => ROLE_RANK[r]);
  if (ranks.length === 0) return false;
  return Math.max(...ranks) >= ROLE_RANK[required];
}

/** Role guard helper: `requireRole("admin")(ctx.workspace.role)`. */
export function requireRole(required: Role): (memberRole: string) => boolean {
  return (memberRole) => hasRole(memberRole, required);
}

/** Minimal session shape consumed by the guard (subset of Better Auth's). */
export interface SessionInfo {
  user: { id: string; email: string; name: string };
  session: { activeOrganizationId?: string | null | undefined };
}

/** Injectable lookups — mocked in unit tests, real (auth + db) in prod. */
export interface WorkspaceDeps {
  getSession(headers: Headers): Promise<SessionInfo | null>;
  getMembership(
    userId: string,
    organizationId: string,
  ): Promise<{ role: string } | null>;
}

export interface WorkspaceContext {
  userId: string;
  user: SessionInfo["user"];
  organizationId: string;
  /** Raw role string from the member row (may be comma-separated). */
  role: string;
}

export type WorkspaceResolution =
  | { ok: true; workspace: WorkspaceContext }
  | { ok: false; status: 401 | 403; message: string };

/**
 * Core guard logic. Resolution order:
 * 1. no session                          → 401
 * 2. no active organization on session   → 403
 * 3. caller not a member of that org     → 403
 * 4. `requiredRole` set and role too low → 403
 */
export async function resolveWorkspace(
  deps: WorkspaceDeps,
  headers: Headers,
  requiredRole?: Role,
): Promise<WorkspaceResolution> {
  const session = await deps.getSession(headers);
  if (!session) {
    return { ok: false, status: 401, message: "authentication required" };
  }

  const organizationId = session.session.activeOrganizationId;
  if (!organizationId) {
    return {
      ok: false,
      status: 403,
      message:
        "no active workspace — create or select an organization first",
    };
  }

  const membership = await deps.getMembership(session.user.id, organizationId);
  if (!membership) {
    return {
      ok: false,
      status: 403,
      message: "not a member of this workspace",
    };
  }

  if (requiredRole && !hasRole(membership.role, requiredRole)) {
    return {
      ok: false,
      status: 403,
      message: `requires ${requiredRole} role in this workspace`,
    };
  }

  return {
    ok: true,
    workspace: {
      userId: session.user.id,
      user: session.user,
      organizationId,
      role: membership.role,
    },
  };
}

/** Production lookups: Better Auth session + drizzle membership query. */
export function createWorkspaceDeps(auth: Auth, db: Db): WorkspaceDeps {
  return {
    async getSession(headers) {
      const result = await auth.api.getSession({ headers });
      if (!result) return null;
      return {
        user: {
          id: result.user.id,
          email: result.user.email,
          name: result.user.name,
        },
        session: {
          activeOrganizationId: (
            result.session as { activeOrganizationId?: string | null }
          ).activeOrganizationId,
        },
      };
    },
    async getMembership(userId, organizationId) {
      const rows = await db
        .select({ role: member.role })
        .from(member)
        .where(
          and(
            eq(member.userId, userId),
            eq(member.organizationId, organizationId),
          ),
        )
        .limit(1);
      return rows[0] ?? null;
    },
  };
}

/**
 * Elysia plugin exposing the `requireWorkspace` macro.
 *
 * Usage:
 *   .get("/thing", ({ workspace }) => ..., { requireWorkspace: true })
 *   .post("/admin", ..., { requireWorkspace: "admin" })   // role guard
 */
export function workspacePlugin(deps: WorkspaceDeps) {
  return new Elysia({ name: "workspace" }).macro({
    requireWorkspace: (requirement: true | Role) => ({
      resolve: async ({ status, request }) => {
        const requiredRole =
          requirement === true ? undefined : requirement;
        const result = await resolveWorkspace(
          deps,
          request.headers,
          requiredRole,
        );
        if (!result.ok) {
          return status(result.status, { error: result.message });
        }
        return { workspace: result.workspace };
      },
    }),
  });
}
