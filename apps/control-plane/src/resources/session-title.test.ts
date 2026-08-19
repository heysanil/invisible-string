/**
 * Session titler (2026-08-11 spec D9). Two halves:
 *
 * - `sanitizeSessionTitle` is pure and runs UNGATED — it is the guard that
 *   raw model output never reaches the column, so it carries the bulk of the
 *   cases (quotes/markdown/preamble/trailing punctuation, the NONE sentinel,
 *   the length clamp against shared SESSION_TITLE_MAX_CHARS).
 * - `generateAndPersistSessionTitle` needs a real `agent_sessions` row, so it
 *   is DB-gated (skips cleanly when TEST_DATABASE_URL is unset). The model
 *   round-trip is injected, so no test ever calls a provider: the happy path,
 *   the model-fails path (title stays NULL, nothing throws), the missing
 *   `quick` preset, the never-clobber guard, the operator kill switch, and the
 *   preset's reasoning effort reaching the call.
 *
 * The config-precedence cases run BOTH sides of the gate on purpose: the
 * ungated one proves an injected env record's kill switch beats the ambient
 * process environment without touching a db or a provider at all.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";

import { eq } from "drizzle-orm";
import { schema } from "@invisible-string/db";
import { SESSION_TITLE_MAX_CHARS } from "@invisible-string/shared";

import { createDb, type Db, type DbHandle } from "../db";
import { createLogger } from "../log";
import { runMigrations } from "../migrate";
import {
  generateAndPersistSessionTitle,
  kickSessionTitle,
  loadSessionTitleConfig,
  resolveQuickPresetModel,
  sanitizeSessionTitle,
  type SessionTitleConfig,
  type SessionTitlerDeps,
  type TitleGenerator,
} from "./session-title";

// ── pure: sanitization + clamping (ungated) ──────────────────────────────────

describe("sanitizeSessionTitle", () => {
  test("passes a clean title through untouched", () => {
    expect(sanitizeSessionTitle("Refund policy for EU orders")).toBe(
      "Refund policy for EU orders",
    );
  });

  test("unwraps the quotes, bold, and backticks models add", () => {
    expect(sanitizeSessionTitle('"Refund policy"')).toBe("Refund policy");
    expect(sanitizeSessionTitle("**Refund policy**")).toBe("Refund policy");
    expect(sanitizeSessionTitle('**"Refund policy"**')).toBe("Refund policy");
    expect(sanitizeSessionTitle("`Refund policy`")).toBe("Refund policy");
    expect(sanitizeSessionTitle("“Refund policy”")).toBe("Refund policy");
  });

  test("strips heading markers, list bullets, and a Title: preamble", () => {
    expect(sanitizeSessionTitle("## Refund policy")).toBe("Refund policy");
    expect(sanitizeSessionTitle("- Refund policy")).toBe("Refund policy");
    expect(sanitizeSessionTitle("Title: Refund policy")).toBe("Refund policy");
    expect(sanitizeSessionTitle("Suggested title — Refund policy")).toBe(
      "Refund policy",
    );
  });

  test("drops trailing sentence punctuation but keeps a question mark", () => {
    expect(sanitizeSessionTitle("Refund policy.")).toBe("Refund policy");
    expect(sanitizeSessionTitle("Refund policy...")).toBe("Refund policy");
    expect(sanitizeSessionTitle("Why is the build slow?")).toBe(
      "Why is the build slow?",
    );
  });

  test("takes the title line past a chatty preamble line", () => {
    expect(
      sanitizeSessionTitle("Sure, here's a title:\n\n**Refund policy**"),
    ).toBe("Refund policy");
  });

  test("collapses whitespace and control characters", () => {
    expect(sanitizeSessionTitle("Refund\t\t policy  for\u0000 EU")).toBe(
      "Refund policy for EU",
    );
  });

  test("returns null for the NONE sentinel, empties, and punctuation-only replies", () => {
    expect(sanitizeSessionTitle("NONE")).toBeNull();
    expect(sanitizeSessionTitle("none")).toBeNull();
    expect(sanitizeSessionTitle("")).toBeNull();
    expect(sanitizeSessionTitle("   \n\n  ")).toBeNull();
    expect(sanitizeSessionTitle("---")).toBeNull();
    expect(sanitizeSessionTitle("…")).toBeNull();
  });

  test("clamps to SESSION_TITLE_MAX_CHARS on a word boundary, marking the cut", () => {
    const long =
      "Migrating the invoicing service off the legacy scheduler and onto the new durable queue runtime";
    const title = sanitizeSessionTitle(long)!;
    expect(title.length).toBeLessThanOrEqual(SESSION_TITLE_MAX_CHARS);
    expect(title.endsWith("…")).toBe(true);
    // Word boundary: no half-word before the ellipsis.
    expect(long.startsWith(title.slice(0, -1))).toBe(true);
    expect(title.slice(0, -1).endsWith(" ")).toBe(false);
  });

  test("clamps a single unbroken word rather than truncating it away", () => {
    const title = sanitizeSessionTitle("a".repeat(200))!;
    expect(title.length).toBe(SESSION_TITLE_MAX_CHARS);
    expect(title.endsWith("…")).toBe(true);
  });
});

describe("loadSessionTitleConfig", () => {
  test("defaults to enabled with a positive timeout", () => {
    const config = loadSessionTitleConfig({});
    expect(config.enabled).toBe(true);
    expect(config.timeoutMs).toBeGreaterThan(0);
  });

  test("SESSION_TITLE_ENABLED=0 is the operator kill switch", () => {
    expect(loadSessionTitleConfig({ SESSION_TITLE_ENABLED: "0" }).enabled).toBe(
      false,
    );
    expect(loadSessionTitleConfig({ SESSION_TITLE_ENABLED: "1" }).enabled).toBe(
      true,
    );
  });

  test("a test process is off by default, and only an explicit 1 overrides it", () => {
    // Guards the reason it exists: an in-process integration stack built with
    // a dummy provider key must not make a real background provider call.
    expect(loadSessionTitleConfig({ NODE_ENV: "test" }).enabled).toBe(false);
    expect(
      loadSessionTitleConfig({ NODE_ENV: "test", SESSION_TITLE_ENABLED: "1" })
        .enabled,
    ).toBe(true);
    expect(loadSessionTitleConfig({ NODE_ENV: "production" }).enabled).toBe(
      true,
    );
  });

  test("a junk timeout falls back to the default instead of disabling the timer", () => {
    expect(loadSessionTitleConfig({ SESSION_TITLE_TIMEOUT_MS: "0" }).timeoutMs)
      .toBe(loadSessionTitleConfig({}).timeoutMs);
    expect(
      loadSessionTitleConfig({ SESSION_TITLE_TIMEOUT_MS: "soon" }).timeoutMs,
    ).toBe(loadSessionTitleConfig({}).timeoutMs);
    expect(
      loadSessionTitleConfig({ SESSION_TITLE_TIMEOUT_MS: "2500" }).timeoutMs,
    ).toBe(2500);
  });
});

// The effort→provider mapping this module used to own now lives in
// src/model/reasoning.ts, because the copilot needs the same two branches.
// Its unit cover is reasoning.test.ts (both providers, every effort in the
// vocabulary) and its WIRE behaviour is reasoning-wire.test.ts — which is the
// test that would have caught the pin drift this all came from. `low` remains
// the seeded quick preset's effort, the only thing separating it from
// `balanced` (same model id; packages/db/src/seed.ts).

describe("session title config resolution", () => {
  /**
   * The kill switch must come from the env record the STACK was built with,
   * not the ambient process environment: `createAppStack(env)` is how every
   * in-process harness boots, and one that injects a runtime provider key
   * while setting SESSION_TITLE_ENABLED=0 in the same record would otherwise
   * make a real, billable provider call it explicitly opted out of.
   */
  test("a stack env record's kill switch beats the ambient environment", async () => {
    const ambient = process.env.SESSION_TITLE_ENABLED;
    process.env.SESSION_TITLE_ENABLED = "1"; // ambient says ON
    try {
      let called = false;
      const title = await generateAndPersistSessionTitle(
        {
          // Never reached: `enabled: false` short-circuits before the preset
          // lookup, which is what a null db here asserts.
          db: null as unknown as Db,
          logger: createLogger({ sink: () => {}, minLevel: "error" }),
          runtime: {
            openrouterApiKey: "injected-runtime-key",
            sessionTitle: loadSessionTitleConfig({
              OPENROUTER_API_KEY: "injected-runtime-key",
              SESSION_TITLE_ENABLED: "0",
            }),
          },
          generateTitle: async () => {
            called = true;
            return "Billed a real call";
          },
        },
        {
          organizationId: "org-never",
          sessionId: "session-never",
          message: "Plan the offsite",
        },
      );

      expect(called).toBe(false);
      expect(title).toBeNull();
    } finally {
      if (ambient === undefined) delete process.env.SESSION_TITLE_ENABLED;
      else process.env.SESSION_TITLE_ENABLED = ambient;
    }
  });
});

// ── generate + persist (DB-gated) ────────────────────────────────────────────

const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL;

if (!TEST_DATABASE_URL) {
  console.warn(
    "[session-title] TEST_DATABASE_URL not set — skipping titler persistence tests",
  );
}

const CONFIG: SessionTitleConfig = { enabled: true, timeoutMs: 5_000 };

describe.skipIf(!TEST_DATABASE_URL)("generateAndPersistSessionTitle", () => {
  let handle: DbHandle;
  let orgId: string;
  let userId: string;
  let agentId: string;
  let versionId: string;

  const logger = createLogger({ sink: () => {}, minLevel: "error" });

  function deps(
    generateTitle: TitleGenerator,
    config: SessionTitleConfig = CONFIG,
  ): SessionTitlerDeps {
    return {
      db: handle.db,
      logger,
      // Keys ride the RUNTIME config the stack was built with, never a fresh
      // process.env read — asserted in the happy path below.
      runtime: { openrouterApiKey: "platform-key" },
      generateTitle,
      sessionTitleConfig: config,
    };
  }

  /** A fresh chat session row; returns its id. */
  async function createSession(): Promise<string> {
    const rows = await handle.db
      .insert(schema.agentSessions)
      .values({
        organizationId: orgId,
        agentId,
        agentVersionId: versionId,
        origin: "chat",
        principal: { workspaceId: orgId, userId, source: "chat" },
        status: "active",
      })
      .returning({ id: schema.agentSessions.id });
    return rows[0]!.id;
  }

  async function titleOf(sessionId: string): Promise<string | null> {
    const rows = await handle.db
      .select({ title: schema.agentSessions.title })
      .from(schema.agentSessions)
      .where(eq(schema.agentSessions.id, sessionId));
    return rows[0]!.title;
  }

  beforeAll(async () => {
    await runMigrations(TEST_DATABASE_URL!);
    handle = createDb(TEST_DATABASE_URL!, { max: 2 });
    orgId = `org-title-${randomUUID()}`;
    userId = `user-title-${randomUUID()}`;
    await handle.db.insert(schema.user).values({
      id: userId,
      name: "Titler Tester",
      email: `titler-${randomUUID()}@example.com`,
    });
    await handle.db.insert(schema.organization).values({
      id: orgId,
      name: "Titler Org",
      slug: orgId,
      createdAt: new Date(),
    });
    // The titler resolves the workspace's `quick` preset for its model.
    await handle.db.insert(schema.modelPresets).values({
      organizationId: orgId,
      slug: "quick",
      provider: "openrouter",
      modelId: "~deepseek/deepseek-v4-flash-latest",
      reasoning: "low",
    });
    const agentRows = await handle.db
      .insert(schema.agents)
      .values({
        organizationId: orgId,
        name: "Titler Agent",
        runAsUserId: userId,
        draft: {},
      })
      .returning({ id: schema.agents.id });
    agentId = agentRows[0]!.id;
    const versionRows = await handle.db
      .insert(schema.agentVersions)
      .values({
        agentId,
        definition: {},
        contentHash: randomUUID().replace(/-/g, ""),
        compilerVersion: "test",
        eveVersion: "0.31.3",
        modelProvider: "openrouter",
        modelId: "~deepseek/deepseek-v4-flash-latest",
        buildStatus: "succeeded",
      })
      .returning({ id: schema.agentVersions.id });
    versionId = versionRows[0]!.id;
  }, 30_000);

  afterAll(async () => {
    // Org delete cascades agents → versions → sessions and the preset row.
    await handle?.db
      .delete(schema.organization)
      .where(eq(schema.organization.id, orgId));
    await handle?.db.delete(schema.user).where(eq(schema.user.id, userId));
    await handle?.close();
  }, 15_000);

  test("persists the sanitized title and calls the quick preset's model", async () => {
    const sessionId = await createSession();
    const seen: string[] = [];
    const title = await generateAndPersistSessionTitle(
      deps(async ({ model, message, keys }) => {
        seen.push(`${model.provider}:${model.modelId}`);
        seen.push(message);
        seen.push(keys.openrouterApiKey ?? "(no key)");
        return '  "Refund policy for EU orders."  ';
      }),
      {
        organizationId: orgId,
        sessionId,
        message: "How do refunds work for orders placed in the EU?",
      },
    );

    expect(title).toBe("Refund policy for EU orders");
    expect(await titleOf(sessionId)).toBe("Refund policy for EU orders");
    expect(seen[0]).toBe("openrouter:~deepseek/deepseek-v4-flash-latest");
    expect(seen[1]).toBe("How do refunds work for orders placed in the EU?");
    expect(seen[2]).toBe("platform-key");
  });

  test("a model failure leaves the title NULL and never throws", async () => {
    const sessionId = await createSession();
    const title = await generateAndPersistSessionTitle(
      deps(async () => {
        throw new Error("openrouter exploded");
      }),
      { organizationId: orgId, sessionId, message: "Plan the offsite" },
    );

    expect(title).toBeNull();
    expect(await titleOf(sessionId)).toBeNull();
  });

  test("an unusable completion (the NONE sentinel) leaves the title NULL", async () => {
    const sessionId = await createSession();
    const title = await generateAndPersistSessionTitle(
      deps(async () => "NONE"),
      { organizationId: orgId, sessionId, message: "hi" },
    );

    expect(title).toBeNull();
    expect(await titleOf(sessionId)).toBeNull();
  });

  test("an aborted round-trip (timeout) leaves the title NULL", async () => {
    const sessionId = await createSession();
    const title = await generateAndPersistSessionTitle(
      deps(
        ({ signal }) =>
          new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () =>
              reject(new Error("aborted")),
            );
          }),
        { ...CONFIG, timeoutMs: 20 },
      ),
      { organizationId: orgId, sessionId, message: "Slow model" },
    );

    expect(title).toBeNull();
    expect(await titleOf(sessionId)).toBeNull();
  });

  test("never clobbers a title the row already has", async () => {
    const sessionId = await createSession();
    await handle.db
      .update(schema.agentSessions)
      .set({ title: "Already named" })
      .where(eq(schema.agentSessions.id, sessionId));

    const title = await generateAndPersistSessionTitle(
      deps(async () => "Second opinion"),
      { organizationId: orgId, sessionId, message: "again" },
    );

    expect(title).toBeNull();
    expect(await titleOf(sessionId)).toBe("Already named");
  });

  test("a workspace without a quick preset is skipped, not failed", async () => {
    const otherOrg = `org-title-none-${randomUUID()}`;
    await handle.db.insert(schema.organization).values({
      id: otherOrg,
      name: "Presetless Org",
      slug: otherOrg,
      createdAt: new Date(),
    });
    try {
      let called = false;
      const title = await generateAndPersistSessionTitle(
        deps(async () => {
          called = true;
          return "Should never run";
        }),
        // The session id belongs to the OTHER workspace; resolution stops at
        // the missing preset before any row is touched.
        {
          organizationId: otherOrg,
          sessionId: await createSession(),
          message: "anything",
        },
      );
      expect(title).toBeNull();
      expect(called).toBe(false);
    } finally {
      await handle.db
        .delete(schema.organization)
        .where(eq(schema.organization.id, otherOrg));
    }
  });

  test("the write is workspace-scoped: another workspace's id cannot be titled", async () => {
    const sessionId = await createSession();
    const otherOrg = `org-title-x-${randomUUID()}`;
    await handle.db.insert(schema.organization).values({
      id: otherOrg,
      name: "Outsider Org",
      slug: otherOrg,
      createdAt: new Date(),
    });
    await handle.db.insert(schema.modelPresets).values({
      organizationId: otherOrg,
      slug: "quick",
      provider: "openrouter",
      modelId: "~deepseek/deepseek-v4-flash-latest",
      reasoning: "low",
    });
    try {
      const title = await generateAndPersistSessionTitle(
        deps(async () => "Cross tenant"),
        { organizationId: otherOrg, sessionId, message: "not mine" },
      );
      expect(title).toBeNull();
      expect(await titleOf(sessionId)).toBeNull();
    } finally {
      await handle.db
        .delete(schema.organization)
        .where(eq(schema.organization.id, otherOrg));
    }
  });

  test("SESSION_TITLE_ENABLED=0 skips the model entirely", async () => {
    const sessionId = await createSession();
    let called = false;
    const title = await generateAndPersistSessionTitle(
      deps(
        async () => {
          called = true;
          return "Nope";
        },
        { ...CONFIG, enabled: false },
      ),
      { organizationId: orgId, sessionId, message: "Plan the offsite" },
    );

    expect(title).toBeNull();
    expect(called).toBe(false);
    expect(await titleOf(sessionId)).toBeNull();
  });

  test("the stack's runtime config turns titling ON even when the ambient env is off", async () => {
    // The mirror of the ungated precedence case: with NO `sessionTitleConfig`
    // seam wired, the config still has to come from the record the stack was
    // built with. Ambient off + record on ⇒ a title lands.
    const ambient = process.env.SESSION_TITLE_ENABLED;
    process.env.SESSION_TITLE_ENABLED = "0";
    try {
      const sessionId = await createSession();
      const title = await generateAndPersistSessionTitle(
        {
          db: handle.db,
          logger,
          runtime: {
            openrouterApiKey: "platform-key",
            sessionTitle: loadSessionTitleConfig({
              SESSION_TITLE_ENABLED: "1",
              SESSION_TITLE_TIMEOUT_MS: "5000",
            }),
          },
          generateTitle: async () => "Offsite planning",
        },
        { organizationId: orgId, sessionId, message: "Plan the offsite" },
      );

      expect(title).toBe("Offsite planning");
      expect(await titleOf(sessionId)).toBe("Offsite planning");
    } finally {
      if (ambient === undefined) delete process.env.SESSION_TITLE_ENABLED;
      else process.env.SESSION_TITLE_ENABLED = ambient;
    }
  });

  test("carries the quick preset's reasoning effort into the model call", async () => {
    // `quick` and `balanced` seed to the SAME model id and differ only by
    // effort, so a resolver that drops `reasoning` silently runs titling at
    // balanced's cost/latency profile.
    const resolved = await resolveQuickPresetModel(handle.db, orgId);
    expect(resolved).toEqual({
      provider: "openrouter",
      modelId: "~deepseek/deepseek-v4-flash-latest",
      reasoning: "low",
    });

    const sessionId = await createSession();
    let seenEffort: string | undefined;
    const title = await generateAndPersistSessionTitle(
      deps(async ({ model }) => {
        seenEffort = model.reasoning;
        return "Refund policy";
      }),
      { organizationId: orgId, sessionId, message: "How do refunds work?" },
    );

    expect(seenEffort).toBe("low");
    expect(title).toBe("Refund policy");
  });

  test("kickSessionTitle is fire-and-forget: it returns void and swallows a rejecting titler", async () => {
    const sessionId = await createSession();
    let settled: (() => void) | undefined;
    const done = new Promise<void>((resolve) => {
      settled = resolve;
    });
    const result: void = kickSessionTitle(
      deps(async () => {
        try {
          // Reject from INSIDE the generator, i.e. the model path, and also
          // make the DB write unreachable — the kick must still not reject.
          throw new Error("boom");
        } finally {
          settled?.();
        }
      }),
      { organizationId: orgId, sessionId, message: "Fire and forget" },
    );

    expect(result).toBeUndefined();
    await done;
    // Give the swallowed rejection a turn to land before asserting the row.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await titleOf(sessionId)).toBeNull();
  });
});
