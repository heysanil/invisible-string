import { describe, expect, test } from "bun:test";
import { Elysia } from "elysia";

import {
  hasRole,
  pathWorkspaceIdOf,
  requireRole,
  resolveWorkspace,
  workspacePlugin,
  type SessionInfo,
  type WorkspaceDeps,
} from "./workspace";

const alice: SessionInfo = {
  user: { id: "user-1", email: "alice@example.com", name: "Alice" },
  session: { activeOrganizationId: "org-1" },
};

function deps(overrides?: Partial<WorkspaceDeps>): WorkspaceDeps {
  return {
    getSession: async () => alice,
    getMembership: async (userId, organizationId) =>
      userId === "user-1" && organizationId === "org-1"
        ? { role: "member" }
        : null,
    ...overrides,
  };
}

const HEADERS = new Headers();

describe("hasRole / requireRole", () => {
  test("role hierarchy: owner ⊇ admin ⊇ member", () => {
    expect(hasRole("owner", "member")).toBe(true);
    expect(hasRole("owner", "admin")).toBe(true);
    expect(hasRole("owner", "owner")).toBe(true);
    expect(hasRole("admin", "member")).toBe(true);
    expect(hasRole("admin", "admin")).toBe(true);
    expect(hasRole("admin", "owner")).toBe(false);
    expect(hasRole("member", "member")).toBe(true);
    expect(hasRole("member", "admin")).toBe(false);
    expect(hasRole("member", "owner")).toBe(false);
  });

  test("handles comma-separated multi-roles and unknown roles", () => {
    expect(hasRole("member,admin", "admin")).toBe(true);
    expect(hasRole("member, admin", "admin")).toBe(true); // whitespace
    expect(hasRole("viewer", "member")).toBe(false); // unknown role only
    expect(hasRole("viewer,member", "member")).toBe(true);
    expect(hasRole("", "member")).toBe(false);
  });

  test("requireRole returns a reusable guard", () => {
    const adminOnly = requireRole("admin");
    expect(adminOnly("owner")).toBe(true);
    expect(adminOnly("admin")).toBe(true);
    expect(adminOnly("member")).toBe(false);
  });
});

describe("resolveWorkspace", () => {
  test("401 when unauthenticated", async () => {
    const result = await resolveWorkspace(
      deps({ getSession: async () => null }),
      HEADERS,
    );
    expect(result).toEqual({
      ok: false,
      status: 401,
      message: "authentication required",
    });
  });

  test("403 when the session has no active organization", async () => {
    const result = await resolveWorkspace(
      deps({
        getSession: async () => ({
          ...alice,
          session: { activeOrganizationId: null },
        }),
      }),
      HEADERS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.message).toContain("no active workspace");
    }
  });

  test("403 when the caller is not a member of the active organization", async () => {
    const result = await resolveWorkspace(
      deps({ getMembership: async () => null }),
      HEADERS,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.message).toContain("not a member");
    }
  });

  test("succeeds for a member and exposes the workspace context", async () => {
    const result = await resolveWorkspace(deps(), HEADERS);
    expect(result).toEqual({
      ok: true,
      workspace: {
        userId: "user-1",
        user: alice.user,
        organizationId: "org-1",
        role: "member",
      },
    });
  });

  test("enforces a required role", async () => {
    const asMember = await resolveWorkspace(deps(), HEADERS, "admin");
    expect(asMember.ok).toBe(false);
    if (!asMember.ok) {
      expect(asMember.status).toBe(403);
      expect(asMember.message).toContain("requires admin role");
    }

    const asOwner = await resolveWorkspace(
      deps({ getMembership: async () => ({ role: "owner" }) }),
      HEADERS,
      "admin",
    );
    expect(asOwner.ok).toBe(true);
  });

  test("IDOR guard: 403 when the path workspace id is not the active workspace", async () => {
    // Alice is a member of org-1 (her active workspace) but the request path
    // addresses org-2 — must be rejected even though she IS authenticated.
    const result = await resolveWorkspace(deps(), HEADERS, undefined, "org-2");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(403);
      expect(result.message).toContain("does not match your active workspace");
    }
  });

  test("IDOR guard: path id matching the active workspace passes", async () => {
    const result = await resolveWorkspace(deps(), HEADERS, undefined, "org-1");
    expect(result.ok).toBe(true);
  });

  test("pathWorkspaceIdOf extracts only a non-empty workspaceId param", () => {
    expect(pathWorkspaceIdOf({ workspaceId: "org-9" })).toBe("org-9");
    expect(pathWorkspaceIdOf({ workspaceId: "" })).toBeUndefined();
    expect(pathWorkspaceIdOf({ id: "org-9" })).toBeUndefined();
    expect(pathWorkspaceIdOf(undefined)).toBeUndefined();
    expect(pathWorkspaceIdOf(null)).toBeUndefined();
  });

  test("passes request headers through to the session lookup", async () => {
    let seen: Headers | undefined;
    const headers = new Headers({ cookie: "session=abc" });
    await resolveWorkspace(
      deps({
        getSession: async (h) => {
          seen = h;
          return null;
        },
      }),
      headers,
    );
    expect(seen?.get("cookie")).toBe("session=abc");
  });
});

describe("workspacePlugin (Elysia macro)", () => {
  function appWith(d: WorkspaceDeps) {
    return new Elysia()
      .use(workspacePlugin(d))
      .get("/scoped", ({ workspace }) => workspace, {
        requireWorkspace: true,
      })
      .get("/admin-only", ({ workspace }) => ({ role: workspace.role }), {
        requireWorkspace: "admin",
      })
      .get(
        "/workspaces/:workspaceId/things",
        ({ workspace }) => ({ organizationId: workspace.organizationId }),
        { requireWorkspace: true },
      )
      .get("/open", () => ({ open: true }));
  }

  test("401 JSON error for unauthenticated requests", async () => {
    const app = appWith(deps({ getSession: async () => null }));
    const res = await app.handle(new Request("http://localhost/scoped"));
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "authentication required" });
  });

  test("403 for non-members", async () => {
    const app = appWith(deps({ getMembership: async () => null }));
    const res = await app.handle(new Request("http://localhost/scoped"));
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      error: "not a member of this workspace",
    });
  });

  test("injects workspace context for members", async () => {
    const app = appWith(deps());
    const res = await app.handle(new Request("http://localhost/scoped"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      userId: "user-1",
      user: alice.user,
      organizationId: "org-1",
      role: "member",
    });
  });

  test("role-gated routes reject members and admit admins", async () => {
    const memberApp = appWith(deps());
    const denied = await memberApp.handle(
      new Request("http://localhost/admin-only"),
    );
    expect(denied.status).toBe(403);

    const adminApp = appWith(
      deps({ getMembership: async () => ({ role: "admin" }) }),
    );
    const allowed = await adminApp.handle(
      new Request("http://localhost/admin-only"),
    );
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ role: "admin" });
  });

  test("IDOR regression: member of org-1 cannot address /workspaces/org-2/...", async () => {
    const app = appWith(deps());
    // Alice's active workspace is org-1; the path claims org-2.
    const denied = await app.handle(
      new Request("http://localhost/workspaces/org-2/things"),
    );
    expect(denied.status).toBe(403);
    expect(((await denied.json()) as { error: string }).error).toContain(
      "does not match your active workspace",
    );

    // The matching path passes and the handler sees the AUTHORIZED org id.
    const allowed = await app.handle(
      new Request("http://localhost/workspaces/org-1/things"),
    );
    expect(allowed.status).toBe(200);
    expect(await allowed.json()).toEqual({ organizationId: "org-1" });
  });

  test("routes without the macro stay open", async () => {
    const app = appWith(deps({ getSession: async () => null }));
    const res = await app.handle(new Request("http://localhost/open"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ open: true });
  });
});
