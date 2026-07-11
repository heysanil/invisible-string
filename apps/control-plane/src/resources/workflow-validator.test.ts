/**
 * Workflow validator — pure rule-set tests (no DB): shape guarding, the
 * agent gate (named + exists + published), non-empty instructions,
 * `@trigger` legality per trigger type (ported `validateTriggerPath`
 * semantics), `@connection`/`@skill` ⊆ the agent's published context, the
 * injected deep-cron check, and published-snapshot staleness warnings.
 */
import { describe, expect, test } from "bun:test";

import {
  stalenessDiagnostics,
  validateWorkflowConfig,
  workflowValidationFailedError,
  type AgentValidationSnapshot,
} from "./workflow-validator";

const AGENT_ID = "5e7a0cbb-3c33-4b64-9f61-2d2c8f4e1a10";

function agent(
  overrides: Partial<AgentValidationSnapshot> = {},
): AgentValidationSnapshot {
  return {
    id: AGENT_ID,
    name: "Software Engineer",
    published: true,
    connectionSlugs: new Set(["linear"]),
    skillSlugs: new Set(["release-notes"]),
    ...overrides,
  };
}

function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    trigger: { type: "manual" },
    agentId: AGENT_ID,
    instructions: { markdown: "Do the thing." },
    ...overrides,
  };
}

function messagesAt(diagnostics: { path: string; message: string }[], path: string) {
  return diagnostics.filter((d) => d.path === path).map((d) => d.message);
}

describe("validateWorkflowConfig — shape", () => {
  test("shape-invalid draft returns per-issue error diagnostics", () => {
    const diagnostics = validateWorkflowConfig({ config: {}, agent: null });
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.every((d) => d.severity === "error")).toBeTrue();
    expect(diagnostics.some((d) => d.path.startsWith("trigger"))).toBeTrue();
  });

  test("a valid config against a published agent has no diagnostics", () => {
    expect(validateWorkflowConfig({ config: config(), agent: agent() })).toEqual([]);
  });
});

describe("validateWorkflowConfig — agent gate", () => {
  test("agentId null is a blocking error", () => {
    const diagnostics = validateWorkflowConfig({
      config: config({ agentId: null }),
      agent: null,
    });
    expect(messagesAt(diagnostics, "agentId")).toHaveLength(1);
    expect(diagnostics[0]!.severity).toBe("error");
  });

  test("agent not found in the workspace is a blocking error", () => {
    const diagnostics = validateWorkflowConfig({ config: config(), agent: null });
    expect(messagesAt(diagnostics, "agentId")[0]).toContain("not found");
  });

  test("unpublished agent is a blocking error", () => {
    const diagnostics = validateWorkflowConfig({
      config: config(),
      agent: agent({ published: false }),
    });
    expect(messagesAt(diagnostics, "agentId")[0]).toContain("no published version");
  });
});

describe("validateWorkflowConfig — instructions", () => {
  test("empty instructions block publish", () => {
    const diagnostics = validateWorkflowConfig({
      config: config({ instructions: { markdown: "   \n" } }),
      agent: agent(),
    });
    expect(messagesAt(diagnostics, "instructions.markdown")[0]).toContain("empty");
  });
});

describe("validateWorkflowConfig — @trigger legality", () => {
  test("bare @trigger is an error on every trigger type", () => {
    const diagnostics = validateWorkflowConfig({
      config: config({
        trigger: { type: "webhook" },
        instructions: { markdown: "Use @trigger now." },
      }),
      agent: agent(),
    });
    expect(messagesAt(diagnostics, "instructions.markdown")[0]).toContain(
      'bare "@trigger"',
    );
  });

  test("@trigger.* is illegal on manual and schedule triggers (no dispatch data)", () => {
    for (const trigger of [
      { type: "manual" },
      { type: "schedule", cron: "*/5 * * * *" },
    ]) {
      const diagnostics = validateWorkflowConfig({
        config: config({
          trigger,
          instructions: { markdown: "Email @trigger.email please." },
        }),
        agent: agent(),
      });
      const messages = messagesAt(diagnostics, "instructions.markdown");
      expect(messages.some((m) => m.includes("carries no dispatch data"))).toBeTrue();
    }
  });

  test("@trigger.* is legal on webhook and slack triggers", () => {
    for (const trigger of [
      { type: "webhook" },
      { type: "slack", binding: { mentionOnly: true } },
    ]) {
      const diagnostics = validateWorkflowConfig({
        config: config({
          trigger,
          instructions: { markdown: "Email @trigger.customer.email please." },
        }),
        agent: agent(),
      });
      expect(diagnostics).toEqual([]);
    }
  });

  test("form @trigger paths must match a field key (head segment)", () => {
    const trigger = {
      type: "form",
      fields: [
        { key: "email", label: "Email", type: "text" },
        { key: "priority", label: "Priority", type: "text" },
      ],
    };
    const ok = validateWorkflowConfig({
      config: config({
        trigger,
        instructions: { markdown: "Contact @trigger.email.domain about @trigger.priority." },
      }),
      agent: agent(),
    });
    expect(ok).toEqual([]);

    const bad = validateWorkflowConfig({
      config: config({
        trigger,
        instructions: { markdown: "Contact @trigger.phone." },
      }),
      agent: agent(),
    });
    const messages = messagesAt(bad, "instructions.markdown");
    expect(messages[0]).toContain("does not match any form field key");
    expect(messages[0]).toContain("email, priority");
  });
});

describe("validateWorkflowConfig — @connection/@skill ⊆ agent context", () => {
  test("refs inside the agent's published context pass", () => {
    const diagnostics = validateWorkflowConfig({
      config: config({
        instructions: { markdown: "File it via @linear using @skill.release-notes." },
      }),
      agent: agent(),
    });
    expect(diagnostics).toEqual([]);
  });

  test("unknown connection ref is a blocking error naming the agent's slugs", () => {
    const diagnostics = validateWorkflowConfig({
      config: config({ instructions: { markdown: "Ping @slack about it." } }),
      agent: agent(),
    });
    const messages = messagesAt(diagnostics, "instructions.markdown");
    expect(messages[0]).toContain('"@slack"');
    expect(messages[0]).toContain("connections: linear");
  });

  test("unknown and bare @skill refs are blocking errors", () => {
    const unknown = validateWorkflowConfig({
      config: config({ instructions: { markdown: "Load @skill.debugging." } }),
      agent: agent(),
    });
    expect(messagesAt(unknown, "instructions.markdown")[0]).toContain(
      "skills: release-notes",
    );

    const bare = validateWorkflowConfig({
      config: config({ instructions: { markdown: "Load @skill now." } }),
      agent: agent(),
    });
    expect(messagesAt(bare, "instructions.markdown")[0]).toContain('bare "@skill"');
  });

  test("context refs are not re-flagged when the agent gate already failed", () => {
    const diagnostics = validateWorkflowConfig({
      config: config({ instructions: { markdown: "Use @linear." } }),
      agent: agent({ published: false, connectionSlugs: new Set() }),
    });
    // Only the agentId diagnostic — no ref noise against an unpublished agent.
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!.path).toBe("agentId");
  });
});

describe("validateWorkflowConfig — deep cron check (injected)", () => {
  const schedule = config({ trigger: { type: "schedule", cron: "0 9 * * 1" } });

  test("a firing cron passes; a never-firing cron is a blocking error", () => {
    expect(
      validateWorkflowConfig({ config: schedule, agent: agent() }, { validateCron: () => true }),
    ).toEqual([]);

    const diagnostics = validateWorkflowConfig(
      { config: schedule, agent: agent() },
      { validateCron: () => false },
    );
    expect(messagesAt(diagnostics, "trigger.cron")[0]).toContain("never fires");
  });

  test("the cron check is not consulted for non-schedule triggers", () => {
    let called = false;
    validateWorkflowConfig(
      { config: config(), agent: agent() },
      {
        validateCron: () => {
          called = true;
          return false;
        },
      },
    );
    expect(called).toBeFalse();
  });
});

describe("stalenessDiagnostics — published snapshot vs current agent", () => {
  const published = config({
    trigger: { type: "webhook" },
    instructions: { markdown: "File via @linear with @skill.release-notes." },
  });

  test("clean snapshot against an unchanged agent has no warnings", () => {
    expect(stalenessDiagnostics(published, agent())).toEqual([]);
  });

  test("missing agent is a published.agentId warning", () => {
    const diagnostics = stalenessDiagnostics(published, null);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!).toMatchObject({
      path: "published.agentId",
      severity: "warning",
    });
  });

  test("agent no longer published is a published.agentId warning", () => {
    const diagnostics = stalenessDiagnostics(published, agent({ published: false }));
    expect(diagnostics[0]!).toMatchObject({
      path: "published.agentId",
      severity: "warning",
    });
    expect(diagnostics[0]!.message).toContain("no longer published");
  });

  test("stranded @connection/@skill refs surface as warnings, one per ref", () => {
    const diagnostics = stalenessDiagnostics(
      published,
      agent({ connectionSlugs: new Set(), skillSlugs: new Set() }),
    );
    expect(diagnostics).toHaveLength(2);
    for (const diagnostic of diagnostics) {
      expect(diagnostic.path).toBe("published.instructions.markdown");
      expect(diagnostic.severity).toBe("warning");
      expect(diagnostic.message).toContain("literal text");
    }
  });

  test("@trigger legality is not re-checked (snapshot is internally consistent)", () => {
    const diagnostics = stalenessDiagnostics(
      config({
        trigger: { type: "webhook" },
        instructions: { markdown: "Email @trigger.email." },
      }),
      agent(),
    );
    expect(diagnostics).toEqual([]);
  });

  test("unparsable snapshot yields a single published warning", () => {
    const diagnostics = stalenessDiagnostics({ legacy: true }, agent());
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!).toMatchObject({ path: "published", severity: "warning" });
  });
});

describe("workflowValidationFailedError", () => {
  test("is a 422 with a stable code and the diagnostics as details", () => {
    const diagnostics = [
      { path: "agentId", message: "nope", severity: "error" as const },
    ];
    const error = workflowValidationFailedError(diagnostics);
    expect(error.status).toBe(422);
    expect(error.code).toBe("workflow_validation_failed");
    expect(error.toBody().error.details).toEqual({ diagnostics });
  });
});
