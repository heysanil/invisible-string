/**
 * Workflow validator — pure rule-set tests (no DB) for the pipeline publish
 * gate: shape guarding (+ the shared schema's tree-integrity refinements
 * surfacing as diagnostics), the step budget, slug requirement, tool-step
 * connection rules (exists/enabled/workspace-scoped + the advisory
 * tools-cache WARNING), agent-step rules (published agent, `session:
 * "thread"` legality), prompt non-emptiness, `@reference` legality across
 * markdown / `$tpl` / `$ref` / condition surfaces (earlier-step visibility,
 * `@item` scoping, `@trigger` per trigger type), the condition depth cap,
 * `onComplete.slackReply` trigger legality, the injected deep-cron check,
 * and published-snapshot staleness warnings.
 */
import { describe, expect, test } from "bun:test";

import {
  MAX_DECLARED_STEPS,
  stalenessDiagnostics,
  validateWorkflowConfig,
  workflowValidationFailedError,
  type PipelineAgentSnapshot,
  type PipelineConnectionSnapshot,
  type PipelineValidationResources,
} from "./workflow-validator";

const AGENT_ID = "5e7a0cbb-3c33-4b64-9f61-2d2c8f4e1a10";
const CONNECTION_ID = "cn_0123456789abcdef";

/** Minted-shape step ids (`st_` + 16 of [0-9a-z]), deterministic per index. */
function stepId(n: number): string {
  return `st_${n.toString(36).padStart(16, "0")}`;
}

function agentSnap(
  overrides: Partial<PipelineAgentSnapshot> = {},
): PipelineAgentSnapshot {
  return { id: AGENT_ID, name: "Software Engineer", published: true, ...overrides };
}

function connectionSnap(
  overrides: Partial<PipelineConnectionSnapshot> = {},
): PipelineConnectionSnapshot {
  return {
    id: CONNECTION_ID,
    name: "Linear",
    enabled: true,
    scope: "workspace",
    toolNames: new Set(["create_issue", "search_issues"]),
    ...overrides,
  };
}

function resources(overrides: {
  agents?: PipelineAgentSnapshot[];
  connections?: PipelineConnectionSnapshot[];
} = {}): PipelineValidationResources {
  return {
    agents: new Map((overrides.agents ?? [agentSnap()]).map((a) => [a.id, a])),
    connections: new Map(
      (overrides.connections ?? [connectionSnap()]).map((c) => [c.id, c]),
    ),
  };
}

// ── step fixtures (draft-shape objects; the validator parses) ───────────────

function toolStep(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: stepId(n),
    slug: `tool-${n}`,
    kind: "tool",
    connectionId: CONNECTION_ID,
    tool: "create_issue",
    args: {},
    ...overrides,
  };
}

function inferStep(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: stepId(n),
    slug: `infer-${n}`,
    kind: "infer",
    prompt: { markdown: "Summarize the input." },
    ...overrides,
  };
}

function agentStep(n: number, overrides: Record<string, unknown> = {}) {
  return {
    id: stepId(n),
    slug: `agent-${n}`,
    kind: "agent",
    agentId: AGENT_ID,
    instructions: { markdown: "Do the delegated thing." },
    ...overrides,
  };
}

function config(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 2,
    trigger: { type: "manual" },
    steps: [inferStep(0)],
    ...overrides,
  };
}

function validate(
  raw: Record<string, unknown>,
  res: PipelineValidationResources = resources(),
  options?: Parameters<typeof validateWorkflowConfig>[1],
) {
  return validateWorkflowConfig({ config: raw, resources: res }, options);
}

function messagesAt(diagnostics: { path: string; message: string }[], path: string) {
  return diagnostics.filter((d) => d.path === path).map((d) => d.message);
}

function errorsOf(diagnostics: { severity: string }[]) {
  return diagnostics.filter((d) => d.severity === "error");
}

// ── shape ───────────────────────────────────────────────────────────────────

describe("validateWorkflowConfig — shape", () => {
  test("shape-invalid draft returns per-issue error diagnostics", () => {
    const diagnostics = validate({});
    expect(diagnostics.length).toBeGreaterThan(0);
    expect(diagnostics.every((d) => d.severity === "error")).toBeTrue();
    expect(diagnostics.some((d) => d.path === "version")).toBeTrue();
    expect(diagnostics.some((d) => d.path.startsWith("trigger"))).toBeTrue();
  });

  test("a valid pipeline has no diagnostics", () => {
    expect(validate(config())).toEqual([]);
  });

  test("tree-integrity refinements (duplicate slug) surface as shape errors", () => {
    const diagnostics = validate(
      config({ steps: [inferStep(0, { slug: "dup" }), inferStep(1, { slug: "dup" })] }),
    );
    expect(messagesAt(diagnostics, "steps.1.slug")[0]).toContain("duplicate step slug");
  });
});

// ── step budget + slugs ─────────────────────────────────────────────────────

describe("validateWorkflowConfig — step budget and slugs", () => {
  test("an empty pipeline blocks publish", () => {
    const diagnostics = validate(config({ steps: [] }));
    expect(messagesAt(diagnostics, "steps")[0]).toContain("no steps");
  });

  test("declared steps over the cap block publish (nested steps count)", () => {
    const body = Array.from({ length: MAX_DECLARED_STEPS }, (_, i) => inferStep(i + 10));
    const diagnostics = validate(
      config({
        steps: [
          {
            id: stepId(0),
            slug: "loop",
            kind: "for_each",
            items: { $ref: "trigger.items" },
            steps: body,
          },
        ],
        trigger: { type: "webhook" },
      }),
    );
    expect(messagesAt(diagnostics, "steps")[0]).toContain(`cap is ${MAX_DECLARED_STEPS}`);
  });

  test("an empty slug is a blocking error naming the handle role", () => {
    const diagnostics = validate(config({ steps: [inferStep(0, { slug: "" })] }));
    expect(messagesAt(diagnostics, "steps.0.slug")[0]).toContain("@steps.<slug>");
  });
});

// ── tool steps ──────────────────────────────────────────────────────────────

describe("validateWorkflowConfig — tool steps", () => {
  test("empty connectionId and tool are blocking errors", () => {
    const diagnostics = validate(
      config({ steps: [toolStep(0, { connectionId: "", tool: "" })] }),
    );
    expect(messagesAt(diagnostics, "steps.0.connectionId")).toHaveLength(1);
    expect(messagesAt(diagnostics, "steps.0.tool")).toHaveLength(1);
  });

  test("unknown connection is a blocking error", () => {
    const diagnostics = validate(config({ steps: [toolStep(0)] }), resources({ connections: [] }));
    expect(messagesAt(diagnostics, "steps.0.connectionId")[0]).toContain("not found");
  });

  test("user-scoped connections are rejected with the workspace-authority rule", () => {
    const diagnostics = validate(
      config({ steps: [toolStep(0)] }),
      resources({ connections: [connectionSnap({ scope: "user" })] }),
    );
    expect(messagesAt(diagnostics, "steps.0.connectionId")[0]).toContain(
      "user-scoped connections cannot back workflow steps",
    );
  });

  test("disabled connection is a blocking error", () => {
    const diagnostics = validate(
      config({ steps: [toolStep(0)] }),
      resources({ connections: [connectionSnap({ enabled: false })] }),
    );
    expect(messagesAt(diagnostics, "steps.0.connectionId")[0]).toContain("disabled");
  });

  test("a tool absent from the cached tool list is a WARNING, never blocking", () => {
    const diagnostics = validate(config({ steps: [toolStep(0, { tool: "nope" })] }));
    expect(errorsOf(diagnostics)).toEqual([]);
    const warningsAtTool = diagnostics.filter((d) => d.path === "steps.0.tool");
    expect(warningsAtTool).toHaveLength(1);
    expect(warningsAtTool[0]!.severity).toBe("warning");
    expect(warningsAtTool[0]!.message).toContain('"nope"');
  });

  test("no cache means no warning (the cache is advisory)", () => {
    const diagnostics = validate(
      config({ steps: [toolStep(0, { tool: "anything" })] }),
      resources({ connections: [connectionSnap({ toolNames: null })] }),
    );
    expect(diagnostics).toEqual([]);
  });
});

// ── reference legality across surfaces ──────────────────────────────────────

describe("validateWorkflowConfig — @references", () => {
  test("@steps must name an EARLIER step; forward refs are blocked", () => {
    const diagnostics = validate(
      config({
        steps: [
          inferStep(0, { slug: "first", prompt: { markdown: "Use @steps.second.text" } }),
          inferStep(1, { slug: "second", prompt: { markdown: "Use @steps.first.text" } }),
        ],
      }),
    );
    const messages = messagesAt(diagnostics, "steps.0.prompt.markdown");
    expect(messages[0]).toContain("does not name an earlier step");
    expect(messages[0]).toContain("earlier steps: none");
    // The backward reference in the second step is legal.
    expect(messagesAt(diagnostics, "steps.1.prompt.markdown")).toEqual([]);
  });

  test("$ref paths in tool args are validated with the arg's diagnostic path", () => {
    const diagnostics = validate(
      config({
        steps: [
          toolStep(0, {
            slug: "create",
            args: {
              title: { $ref: "steps.missing.result" },
              body: { $tpl: "From @item today" },
              nested: { deep: [{ $ref: "bogus.head" }] },
            },
          }),
        ],
      }),
    );
    expect(messagesAt(diagnostics, "steps.0.args.title")[0]).toContain("steps.missing");
    expect(messagesAt(diagnostics, "steps.0.args.body")[0]).toContain("for_each");
    expect(messagesAt(diagnostics, "steps.0.args.nested.deep.0")[0]).toContain(
      'unknown reference head "bogus"',
    );
  });

  test("empty $ref and pathed now are blocked; state keys are free", () => {
    const diagnostics = validate(
      config({
        steps: [
          {
            id: stepId(0),
            slug: "write",
            kind: "state",
            set: {
              a: { $ref: "" },
              b: { $ref: "now.date" },
              c: { $ref: "state.anything.goes" },
            },
          },
        ],
      }),
    );
    expect(messagesAt(diagnostics, "steps.0.set.a")[0]).toContain('empty "$ref"');
    expect(messagesAt(diagnostics, "steps.0.set.b")[0]).toContain('"now" takes no path');
    expect(messagesAt(diagnostics, "steps.0.set.c")).toEqual([]);
  });

  test("@trigger legality is enforced per trigger type on markdown surfaces", () => {
    // manual/schedule carry no dispatch data.
    for (const trigger of [
      { type: "manual" },
      { type: "schedule", cron: "*/5 * * * *" },
    ]) {
      const diagnostics = validate(
        config({
          trigger,
          steps: [inferStep(0, { prompt: { markdown: "Email @trigger.email please." } })],
        }),
      );
      expect(
        messagesAt(diagnostics, "steps.0.prompt.markdown").some((m) =>
          m.includes("carries no dispatch data"),
        ),
      ).toBeTrue();
    }
    // webhook data is free-form.
    expect(
      validate(
        config({
          trigger: { type: "webhook" },
          steps: [inferStep(0, { prompt: { markdown: "Email @trigger.customer.email." } })],
        }),
      ),
    ).toEqual([]);
  });

  test("form @trigger paths must match a field key (markdown and $ref alike)", () => {
    const trigger = {
      type: "form",
      fields: [
        { key: "email", label: "Email", type: "text" },
        { key: "priority", label: "Priority", type: "text" },
      ],
    };
    const ok = validate(
      config({
        trigger,
        steps: [
          toolStep(0, { args: { to: { $ref: "trigger.email" } } }),
          inferStep(1, { prompt: { markdown: "Rank @trigger.priority." } }),
        ],
      }),
    );
    expect(ok).toEqual([]);

    const bad = validate(
      config({
        trigger,
        steps: [toolStep(0, { args: { to: { $ref: "trigger.phone" } } })],
      }),
    );
    expect(messagesAt(bad, "steps.0.args.to")[0]).toContain(
      "does not match any form field key",
    );
  });

  test("bare @trigger in markdown is flagged; bare trigger $ref is legal", () => {
    const diagnostics = validate(
      config({
        trigger: { type: "webhook" },
        steps: [
          inferStep(0, { prompt: { markdown: "Use @trigger now." } }),
          toolStep(1, { args: { payload: { $ref: "trigger" } } }),
        ],
      }),
    );
    expect(messagesAt(diagnostics, "steps.0.prompt.markdown")[0]).toContain(
      'bare "@trigger"',
    );
    expect(messagesAt(diagnostics, "steps.1.args.payload")).toEqual([]);
  });
});

// ── agent steps ─────────────────────────────────────────────────────────────

describe("validateWorkflowConfig — agent steps", () => {
  test("null / unknown / unpublished agents are blocking errors", () => {
    const nullAgent = validate(config({ steps: [agentStep(0, { agentId: null })] }));
    expect(messagesAt(nullAgent, "steps.0.agentId")[0]).toContain("choose an agent");

    const unknown = validate(config({ steps: [agentStep(0)] }), resources({ agents: [] }));
    expect(messagesAt(unknown, "steps.0.agentId")[0]).toContain("not found");

    const unpublished = validate(
      config({ steps: [agentStep(0)] }),
      resources({ agents: [agentSnap({ published: false })] }),
    );
    expect(messagesAt(unpublished, "steps.0.agentId")[0]).toContain("no published version");
  });

  test("empty instructions block publish", () => {
    const diagnostics = validate(
      config({ steps: [agentStep(0, { instructions: { markdown: "  \n" } })] }),
    );
    expect(messagesAt(diagnostics, "steps.0.instructions.markdown")[0]).toContain(
      "needs instructions",
    );
  });

  test('session "thread" needs a slack trigger and no output schema', () => {
    const wrongTrigger = validate(
      config({ steps: [agentStep(0, { session: "thread" })] }),
    );
    expect(messagesAt(wrongTrigger, "steps.0.session")[0]).toContain("slack trigger");

    const withOutput = validate(
      config({
        trigger: { type: "slack", binding: { mentionOnly: true } },
        steps: [
          agentStep(0, {
            session: "thread",
            output: { schema: { type: "object", properties: { a: { type: "string" } } } },
          }),
        ],
      }),
    );
    expect(messagesAt(withOutput, "steps.0.session")[0]).toContain("output schema");

    const legal = validate(
      config({
        trigger: { type: "slack", binding: { mentionOnly: true } },
        steps: [agentStep(0, { session: "thread" })],
      }),
    );
    expect(legal).toEqual([]);
  });
});

// ── infer steps ─────────────────────────────────────────────────────────────

describe("validateWorkflowConfig — infer steps", () => {
  test("an empty prompt blocks publish", () => {
    const diagnostics = validate(
      config({ steps: [inferStep(0, { prompt: { markdown: "   " } })] }),
    );
    expect(messagesAt(diagnostics, "steps.0.prompt.markdown")[0]).toContain("prompt");
  });
});

// ── control verbs ───────────────────────────────────────────────────────────

describe("validateWorkflowConfig — for_each, branch, filter", () => {
  test("for_each items renders OUTSIDE the body: @item is illegal in it, and the body sees earlier steps but not its own ancestor", () => {
    const diagnostics = validate(
      config({
        trigger: { type: "webhook" },
        steps: [
          toolStep(0, { slug: "search", tool: "search_issues" }),
          {
            id: stepId(1),
            slug: "loop",
            kind: "for_each",
            items: { $ref: "item.messages" },
            steps: [
              inferStep(2, {
                slug: "summarize",
                prompt: { markdown: "Summarize @item using @steps.search.text" },
              }),
              inferStep(3, {
                slug: "self-ref",
                prompt: { markdown: "Check @steps.loop.result" },
              }),
            ],
          },
        ],
      }),
    );
    expect(messagesAt(diagnostics, "steps.1.items")[0]).toContain("for_each");
    // @item + earlier-step refs inside the body are legal…
    expect(messagesAt(diagnostics, "steps.1.steps.0.prompt.markdown")).toEqual([]);
    // …but the enclosing loop has no output while you are inside it.
    expect(messagesAt(diagnostics, "steps.1.steps.1.prompt.markdown")[0]).toContain(
      "does not name an earlier step",
    );
  });

  test("branch lane diagnostics use the branches.<lane> path grammar; condition $refs are validated", () => {
    const diagnostics = validate(
      config({
        trigger: { type: "webhook" },
        steps: [
          {
            id: stepId(0),
            slug: "route",
            kind: "branch",
            branches: [
              { when: { truthy: { $ref: "trigger.urgent" } }, steps: [inferStep(1)] },
              {
                when: { eq: [{ $ref: "steps.missing.x" }, "y"] },
                steps: [inferStep(2, { slug: "lane-two" })],
              },
            ],
          },
        ],
      }),
    );
    expect(messagesAt(diagnostics, "steps.0.branches.1.when")[0]).toContain(
      "steps.missing",
    );
  });

  test("condition nesting beyond the depth cap is one blocking error", () => {
    // Depth 9: not(not(not(not(not(not(not(not(truthy))))))))
    let where: Record<string, unknown> = { truthy: true };
    for (let i = 0; i < 8; i += 1) where = { not: where };
    const diagnostics = validate(
      config({
        steps: [{ id: stepId(0), slug: "gate", kind: "filter", where }, inferStep(1)],
      }),
    );
    expect(messagesAt(diagnostics, "steps.0.where")).toHaveLength(1);
    expect(messagesAt(diagnostics, "steps.0.where")[0]).toContain("depth cap");
  });
});

// ── onComplete ──────────────────────────────────────────────────────────────

describe("validateWorkflowConfig — onComplete.slackReply", () => {
  test("needs a slack trigger (no thread to reply into otherwise)", () => {
    const diagnostics = validate(
      config({
        onComplete: { slackReply: { template: { markdown: "Done." } } },
      }),
    );
    expect(messagesAt(diagnostics, "onComplete.slackReply")[0]).toContain(
      "slack trigger",
    );
  });

  test("template renders against the FINAL scope: every slug visible, no @item", () => {
    const diagnostics = validate(
      config({
        trigger: { type: "slack", binding: { mentionOnly: true } },
        steps: [inferStep(0, { slug: "summary" })],
        onComplete: {
          slackReply: {
            template: { markdown: "Result: @steps.summary.text (@item is illegal)" },
          },
        },
      }),
    );
    const messages = messagesAt(diagnostics, "onComplete.slackReply.template.markdown");
    expect(messages).toHaveLength(1);
    expect(messages[0]).toContain("@item");
  });
});

// ── injected deep-cron check ────────────────────────────────────────────────

describe("validateWorkflowConfig — deep cron check (injected)", () => {
  const schedule = config({ trigger: { type: "schedule", cron: "0 9 * * 1" } });

  test("a firing cron passes; a never-firing cron is a blocking error", () => {
    expect(validate(schedule, resources(), { validateCron: () => true })).toEqual([]);
    const diagnostics = validate(schedule, resources(), { validateCron: () => false });
    expect(messagesAt(diagnostics, "trigger.cron")[0]).toContain("never fires");
  });

  test("the cron check is not consulted for non-schedule triggers", () => {
    let called = false;
    validate(config(), resources(), {
      validateCron: () => {
        called = true;
        return false;
      },
    });
    expect(called).toBeFalse();
  });
});

// ── staleness ───────────────────────────────────────────────────────────────

describe("stalenessDiagnostics — published snapshot vs current workspace", () => {
  const published = config({
    trigger: { type: "webhook" },
    steps: [toolStep(0, { slug: "create" }), agentStep(1, { slug: "delegate" })],
  });

  test("clean snapshot against unchanged resources has no warnings", () => {
    expect(stalenessDiagnostics(published, resources())).toEqual([]);
  });

  test("missing / unpublished agent warns at the published step path", () => {
    const missing = stalenessDiagnostics(published, resources({ agents: [] }));
    expect(missing).toHaveLength(1);
    expect(missing[0]!).toMatchObject({
      path: "published.steps.1.agentId",
      severity: "warning",
    });

    const unpublished = stalenessDiagnostics(
      published,
      resources({ agents: [agentSnap({ published: false })] }),
    );
    expect(unpublished[0]!.message).toContain("no longer published");
  });

  test("missing / disabled connection warns at the published step path", () => {
    const missing = stalenessDiagnostics(published, resources({ connections: [] }));
    expect(missing[0]!).toMatchObject({
      path: "published.steps.0.connectionId",
      severity: "warning",
    });

    const disabled = stalenessDiagnostics(
      published,
      resources({ connections: [connectionSnap({ enabled: false })] }),
    );
    expect(disabled[0]!.message).toContain("disabled");
  });

  test("unparsable snapshot yields a single published warning", () => {
    const diagnostics = stalenessDiagnostics({ legacy: true }, resources());
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]!).toMatchObject({ path: "published", severity: "warning" });
  });
});

describe("workflowValidationFailedError", () => {
  test("is a 422 with a stable code and the diagnostics as details", () => {
    const diagnostics = [
      { path: "steps", message: "nope", severity: "error" as const },
    ];
    const error = workflowValidationFailedError(diagnostics);
    expect(error.status).toBe(422);
    expect(error.code).toBe("workflow_validation_failed");
    expect(error.toBody().error.details).toEqual({ diagnostics });
  });
});
