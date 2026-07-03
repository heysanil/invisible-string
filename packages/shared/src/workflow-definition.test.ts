import { describe, expect, test } from "bun:test";

import {
  agentConfigSchema,
  buildReferenceInventory,
  contextConfigSchema,
  cronExpressionSchema,
  formTriggerSchema,
  parseReferences,
  slackTriggerSchema,
  triggerConfigSchema,
  workflowDefinitionSchema,
  type WorkflowDefinitionInput,
} from "./workflow-definition";

const UUID_A = "6b4d8f6e-3a4e-4f6a-9a0e-2f6a1c9d8e7b";
const UUID_B = "0f8fad5b-d9cb-469f-a165-70867728950e";

// ── Trigger pillar ──────────────────────────────────────────────────────────

describe("triggerConfigSchema", () => {
  test("manual and webhook triggers are bare discriminants", () => {
    expect(triggerConfigSchema.parse({ type: "manual" })).toEqual({
      type: "manual",
    });
    expect(triggerConfigSchema.parse({ type: "webhook" })).toEqual({
      type: "webhook",
    });
  });

  test("rejects unknown discriminants", () => {
    expect(triggerConfigSchema.safeParse({ type: "email" }).success).toBe(false);
  });

  test("form trigger parses fields and applies required default", () => {
    const parsed = triggerConfigSchema.parse({
      type: "form",
      fields: [
        { key: "customer_email", label: "Customer email", type: "text" },
        {
          key: "priority",
          label: "Priority",
          type: "select",
          required: true,
          options: ["low", "high"],
        },
      ],
    });
    if (parsed.type !== "form") throw new Error("expected form");
    expect(parsed.fields[0]?.required).toBe(false);
    expect(parsed.fields[1]?.options).toEqual(["low", "high"]);
  });

  test("form trigger requires at least one field", () => {
    expect(formTriggerSchema.safeParse({ type: "form", fields: [] }).success).toBe(
      false,
    );
  });

  test("form field keys must be @trigger-referenceable identifiers", () => {
    for (const badKey of ["1bad", "has space", "", "dot.key", "@x"]) {
      expect(
        formTriggerSchema.safeParse({
          type: "form",
          fields: [{ key: badKey, label: "x", type: "text" }],
        }).success,
      ).toBe(false);
    }
  });

  test("form trigger rejects duplicate field keys", () => {
    const result = formTriggerSchema.safeParse({
      type: "form",
      fields: [
        { key: "email", label: "Email", type: "text" },
        { key: "email", label: "Email again", type: "text" },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual(["fields", 1, "key"]);
    }
  });

  test("select fields require options; other types forbid them", () => {
    expect(
      formTriggerSchema.safeParse({
        type: "form",
        fields: [{ key: "p", label: "P", type: "select" }],
      }).success,
    ).toBe(false);
    expect(
      formTriggerSchema.safeParse({
        type: "form",
        fields: [{ key: "p", label: "P", type: "select", options: [] }],
      }).success,
    ).toBe(false);
    expect(
      formTriggerSchema.safeParse({
        type: "form",
        fields: [{ key: "p", label: "P", type: "text", options: ["a"] }],
      }).success,
    ).toBe(false);
  });

  test("slack trigger applies binding defaults", () => {
    const parsed = slackTriggerSchema.parse({ type: "slack", binding: {} });
    expect(parsed.binding).toEqual({
      mentionOnly: true,
      includeDirectMessages: false,
    });
    const bound = slackTriggerSchema.parse({
      type: "slack",
      binding: { channelId: "C0123", mentionOnly: false },
    });
    expect(bound.binding.channelId).toBe("C0123");
    expect(bound.binding.mentionOnly).toBe(false);
  });

  test("schedule trigger validates 5-field cron", () => {
    expect(
      triggerConfigSchema.safeParse({ type: "schedule", cron: "*/5 * * * *" }).success,
    ).toBe(true);
    expect(
      triggerConfigSchema.safeParse({ type: "schedule", cron: "0 9 * * MON" }).success,
    ).toBe(true);
    // 4 and 6 fields rejected
    expect(
      triggerConfigSchema.safeParse({ type: "schedule", cron: "* * * *" }).success,
    ).toBe(false);
    expect(
      triggerConfigSchema.safeParse({ type: "schedule", cron: "* * * * * *" }).success,
    ).toBe(false);
    expect(cronExpressionSchema.safeParse("").success).toBe(false);
  });
});

// ── Context pillar ──────────────────────────────────────────────────────────

describe("contextConfigSchema", () => {
  test("defaults both id lists to empty arrays", () => {
    expect(contextConfigSchema.parse({})).toEqual({
      mcpConnectionIds: [],
      skillIds: [],
    });
  });

  test("accepts uuids, rejects non-uuids", () => {
    expect(
      contextConfigSchema.safeParse({ mcpConnectionIds: [UUID_A], skillIds: [UUID_B] })
        .success,
    ).toBe(true);
    expect(
      contextConfigSchema.safeParse({ mcpConnectionIds: ["linear"] }).success,
    ).toBe(false);
  });

  test("rejects duplicate ids", () => {
    expect(
      contextConfigSchema.safeParse({ mcpConnectionIds: [UUID_A, UUID_A] }).success,
    ).toBe(false);
    expect(contextConfigSchema.safeParse({ skillIds: [UUID_B, UUID_B] }).success).toBe(
      false,
    );
  });
});

// ── Agent pillar ────────────────────────────────────────────────────────────

describe("agentConfigSchema", () => {
  test("requires only agentPresetId; overrides optional", () => {
    expect(agentConfigSchema.parse({ agentPresetId: UUID_A })).toEqual({
      agentPresetId: UUID_A,
    });
    const full = agentConfigSchema.parse({
      agentPresetId: UUID_A,
      modelPreset: "quick",
      modelId: "deepseek/deepseek-v4-flash",
      reasoning: "high",
    });
    expect(full.modelPreset).toBe("quick");
    expect(full.reasoning).toBe("high");
  });

  test("rejects unknown preset slugs and reasoning efforts", () => {
    expect(
      agentConfigSchema.safeParse({ agentPresetId: UUID_A, modelPreset: "turbo" })
        .success,
    ).toBe(false);
    expect(
      agentConfigSchema.safeParse({ agentPresetId: UUID_A, reasoning: "max" }).success,
    ).toBe(false);
  });

  test("rejects non-uuid agentPresetId", () => {
    expect(agentConfigSchema.safeParse({ agentPresetId: "general" }).success).toBe(
      false,
    );
  });
});

// ── Full definition ─────────────────────────────────────────────────────────

describe("workflowDefinitionSchema", () => {
  test("parses a full four-pillar definition and applies nested defaults", () => {
    const input = {
      trigger: {
        type: "form",
        fields: [{ key: "email", label: "Email", type: "text" }],
      },
      context: { mcpConnectionIds: [UUID_A] },
      agent: { agentPresetId: UUID_B },
      instructions: { markdown: "Email @trigger.email via @gmail. Use @skill.tone." },
    } satisfies WorkflowDefinitionInput;

    const parsed = workflowDefinitionSchema.parse(input);
    expect(parsed.context.skillIds).toEqual([]);
    expect(parsed.trigger.type).toBe("form");
  });

  test("empty instructions markdown is a valid DRAFT", () => {
    expect(
      workflowDefinitionSchema.safeParse({
        trigger: { type: "manual" },
        context: {},
        agent: { agentPresetId: UUID_A },
        instructions: { markdown: "" },
      }).success,
    ).toBe(true);
  });

  test("rejects a definition missing a pillar", () => {
    expect(
      workflowDefinitionSchema.safeParse({
        trigger: { type: "manual" },
        agent: { agentPresetId: UUID_A },
        instructions: { markdown: "" },
      }).success,
    ).toBe(false);
  });
});

// ── @reference parsing ──────────────────────────────────────────────────────

describe("parseReferences", () => {
  test("extracts trigger refs with dot paths", () => {
    const refs = parseReferences("Send to @trigger.customer.email now");
    expect(refs).toEqual([
      {
        kind: "trigger",
        raw: "@trigger.customer.email",
        path: "customer.email",
        start: 8,
        end: 31,
      },
    ]);
  });

  test("bare @trigger parses with empty path (validators flag it)", () => {
    const refs = parseReferences("use @trigger data");
    expect(refs).toEqual([
      { kind: "trigger", raw: "@trigger", path: "", start: 4, end: 12 },
    ]);
  });

  test("extracts skill refs by slug", () => {
    const refs = parseReferences("Follow @skill.brand-voice.");
    expect(refs).toEqual([
      {
        kind: "skill",
        raw: "@skill.brand-voice",
        slug: "brand-voice",
        start: 7,
        end: 25,
      },
    ]);
  });

  test("extracts connection refs (bare names)", () => {
    const refs = parseReferences("File it in @linear and notify @slack-alerts");
    expect(refs).toEqual([
      { kind: "connection", raw: "@linear", name: "linear", start: 11, end: 18 },
      {
        kind: "connection",
        raw: "@slack-alerts",
        name: "slack-alerts",
        start: 30,
        end: 43,
      },
    ]);
  });

  test("connection refs truncate to the first segment", () => {
    const refs = parseReferences("query @linear.issues");
    expect(refs).toEqual([
      { kind: "connection", raw: "@linear", name: "linear", start: 6, end: 13 },
    ]);
  });

  test("never matches email addresses", () => {
    expect(parseReferences("mail sanil@example.com or hi@sanil.co")).toEqual([]);
  });

  test("does not match @@ or @ followed by non-letters", () => {
    expect(parseReferences("meet @5pm, use @@escaped, price @ $5")).toEqual([]);
  });

  test("matches after punctuation and at start of input", () => {
    const refs = parseReferences("@trigger.id (@linear) [@skill.x]");
    expect(refs.map((r) => r.kind)).toEqual(["trigger", "connection", "skill"]);
  });

  test("does not consume trailing dots", () => {
    const refs = parseReferences("Resolve @trigger.email.");
    expect(refs[0]?.raw).toBe("@trigger.email");
    expect(refs[0]?.kind).toBe("trigger");
  });

  test("numeric path segments stay addressable", () => {
    const refs = parseReferences("first item: @trigger.items.0.name");
    expect(refs[0]).toMatchObject({ kind: "trigger", path: "items.0.name" });
  });

  test("offsets slice back to the raw text", () => {
    const doc = "Use @gmail to send @trigger.report to @skill.tone-guide readers";
    for (const ref of parseReferences(doc)) {
      expect(doc.slice(ref.start, ref.end)).toBe(ref.raw);
    }
  });

  test("returns references in document order, duplicates preserved", () => {
    const refs = parseReferences("@linear then @trigger.a then @linear");
    expect(refs.map((r) => r.raw)).toEqual(["@linear", "@trigger.a", "@linear"]);
  });
});

describe("buildReferenceInventory", () => {
  test("groups references by kind and keeps document order in all", () => {
    const inv = buildReferenceInventory(
      "Take @trigger.email, search @deepwiki, apply @skill.summary, cc @trigger.owner",
    );
    expect(inv.all).toHaveLength(4);
    expect(inv.trigger.map((r) => r.path)).toEqual(["email", "owner"]);
    expect(inv.connections.map((r) => r.name)).toEqual(["deepwiki"]);
    expect(inv.skills.map((r) => r.slug)).toEqual(["summary"]);
  });

  test("empty markdown yields an empty inventory", () => {
    expect(buildReferenceInventory("")).toEqual({
      all: [],
      trigger: [],
      connections: [],
      skills: [],
    });
  });
});
