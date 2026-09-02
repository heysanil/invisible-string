import { describe, expect, test } from "bun:test";

import {
  buildReferenceInventory,
  cronExpressionSchema,
  formTriggerSchema,
  parseReferences,
  slackTriggerSchema,
  triggerConfigSchema,
  workflowConfigSchema,
  type WorkflowConfigInput,
} from "./workflow-config";

const UUID_A = "6b4d8f6e-3a4e-4f6a-9a0e-2f6a1c9d8e7b";

// ── Trigger ─────────────────────────────────────────────────────────────────

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

// ── Full config ─────────────────────────────────────────────────────────────

describe("workflowConfigSchema", () => {
  test("parses a full v2 pipeline and applies nested defaults", () => {
    const input = {
      version: 2,
      trigger: {
        type: "form",
        fields: [{ key: "email", label: "Email", type: "text" }],
      },
      steps: [
        {
          id: "st_0000000000000001",
          slug: "notify",
          kind: "agent",
          agentId: UUID_A,
          instructions: { markdown: "Email @trigger.email via @gmail." },
        },
      ],
    } satisfies WorkflowConfigInput;

    const parsed = workflowConfigSchema.parse(input);
    expect(parsed.trigger.type).toBe("form");
    expect(parsed.overlap).toBe("skip");
    const step = parsed.steps[0];
    if (step?.kind !== "agent") throw new Error("expected agent step");
    expect(step.agentId).toBe(UUID_A);
    expect(step.session).toBe("fresh");
  });

  test("an empty pipeline is a valid DRAFT (steps default to [])", () => {
    const parsed = workflowConfigSchema.parse({
      version: 2,
      trigger: { type: "manual" },
    });
    expect(parsed.steps).toEqual([]);
    expect(parsed.onComplete).toBeUndefined();
  });

  test("requires the version 2 literal", () => {
    expect(
      workflowConfigSchema.safeParse({ trigger: { type: "manual" }, steps: [] })
        .success,
    ).toBe(false);
    expect(
      workflowConfigSchema.safeParse({
        version: 1,
        trigger: { type: "manual" },
        steps: [],
      }).success,
    ).toBe(false);
  });

  test("rejects a config missing its trigger", () => {
    expect(
      workflowConfigSchema.safeParse({ version: 2, steps: [] }).success,
    ).toBe(false);
  });

  test("onComplete slackReply carries a markdown template", () => {
    const parsed = workflowConfigSchema.parse({
      version: 2,
      trigger: { type: "slack", binding: {} },
      steps: [],
      onComplete: { slackReply: { template: { markdown: "Done: @steps.sum" } } },
    });
    expect(parsed.onComplete?.slackReply?.template.markdown).toBe(
      "Done: @steps.sum",
    );
  });

  test("rejects duplicate step slugs anywhere in the tree", () => {
    const result = workflowConfigSchema.safeParse({
      version: 2,
      trigger: { type: "manual" },
      steps: [
        {
          id: "st_0000000000000001",
          slug: "search",
          kind: "tool",
        },
        {
          id: "st_0000000000000002",
          slug: "loop",
          kind: "for_each",
          items: { $ref: "steps.search.result.messages" },
          steps: [
            {
              id: "st_0000000000000003",
              slug: "search",
              kind: "state",
            },
          ],
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.path).toEqual([
        "steps",
        1,
        "steps",
        0,
        "slug",
      ]);
    }
  });

  test("rejects duplicate step ids; empty slugs stay draft-legal", () => {
    const result = workflowConfigSchema.safeParse({
      version: 2,
      trigger: { type: "manual" },
      steps: [
        { id: "st_0000000000000001", slug: "", kind: "state" },
        { id: "st_0000000000000001", slug: "", kind: "state" },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues).toHaveLength(1); // dup id only — "" slugs pass
      expect(result.error.issues[0]?.path).toEqual(["steps", 1, "id"]);
    }
  });

  test("rejects a for_each nested inside another for_each", () => {
    const result = workflowConfigSchema.safeParse({
      version: 2,
      trigger: { type: "manual" },
      steps: [
        {
          id: "st_0000000000000001",
          slug: "outer",
          kind: "for_each",
          items: { $ref: "trigger.items" },
          steps: [
            {
              id: "st_0000000000000002",
              slug: "inner",
              kind: "for_each",
              items: { $ref: "item.children" },
              steps: [],
            },
          ],
        },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues[0]?.message).toContain("cannot nest");
    }
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

  test("extracts step refs with slug + output path", () => {
    const refs = parseReferences("Use @steps.search.result.messages here");
    expect(refs).toEqual([
      {
        kind: "step",
        raw: "@steps.search.result.messages",
        slug: "search",
        path: "result.messages",
        start: 4,
        end: 33,
      },
    ]);
  });

  test("a slug-only step ref names the whole output; bare @steps flags empty slug", () => {
    expect(parseReferences("Post @steps.summarize")[0]).toMatchObject({
      kind: "step",
      slug: "summarize",
      path: "",
    });
    expect(parseReferences("Post @steps")[0]).toMatchObject({
      kind: "step",
      slug: "",
      path: "",
    });
  });

  test("extracts state refs by key (dot path into the value allowed)", () => {
    expect(parseReferences("Since @state.cursor")[0]).toEqual({
      kind: "state",
      raw: "@state.cursor",
      key: "cursor",
      start: 6,
      end: 19,
    });
    expect(parseReferences("At @state.cursor.ts")[0]).toMatchObject({
      kind: "state",
      key: "cursor.ts",
    });
  });

  test("extracts item refs, bare and with a path", () => {
    expect(parseReferences("Summarize @item now")[0]).toEqual({
      kind: "item",
      raw: "@item",
      path: "",
      start: 10,
      end: 15,
    });
    expect(parseReferences("Title: @item.text")[0]).toMatchObject({
      kind: "item",
      path: "text",
    });
  });

  test("@now takes no path — the span truncates like connection refs", () => {
    expect(parseReferences("Run at @now.")[0]).toEqual({
      kind: "now",
      raw: "@now",
      start: 7,
      end: 11,
    });
    const truncated = parseReferences("Stamp @now.date here");
    expect(truncated[0]).toEqual({
      kind: "now",
      raw: "@now",
      start: 6,
      end: 10,
    });
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
      "Take @trigger.email, join @steps.search.result, since @state.cursor, per @item.text at @now — search @deepwiki, apply @skill.summary, cc @trigger.owner",
    );
    expect(inv.all).toHaveLength(8);
    expect(inv.trigger.map((r) => r.path)).toEqual(["email", "owner"]);
    expect(inv.steps.map((r) => r.slug)).toEqual(["search"]);
    expect(inv.state.map((r) => r.key)).toEqual(["cursor"]);
    expect(inv.items.map((r) => r.path)).toEqual(["text"]);
    expect(inv.now).toHaveLength(1);
    expect(inv.connections.map((r) => r.name)).toEqual(["deepwiki"]);
    expect(inv.skills.map((r) => r.slug)).toEqual(["summary"]);
  });

  test("empty markdown yields an empty inventory", () => {
    expect(buildReferenceInventory("")).toEqual({
      all: [],
      trigger: [],
      steps: [],
      state: [],
      items: [],
      now: [],
      connections: [],
      skills: [],
    });
  });
});
