import { describe, expect, test } from "bun:test";

import {
  addModelAllowlistEntryRequestSchema,
  agentDtoSchema,
  agentSessionDtoSchema,
  agentSessionSummaryDtoSchema,
  agentSummaryDtoSchema,
  agentVersionDtoSchema,
  connectionDtoSchema,
  createAgentRequestSchema,
  createConnectionRequestSchema,
  createSessionRequestSchema,
  createSkillRequestSchema,
  createWorkflowRequestSchema,
  deliveryStatusSchema,
  dryRunCompileResponseSchema,
  isRunStreamTerminalStatus,
  listModelCapabilitiesResponseSchema,
  listSessionsQuerySchema,
  mcpAuthWriteSchema,
  modelCapabilityDtoSchema,
  modelIdShapeProblem,
  modelPresetDtoSchema,
  parseAgentDefinition,
  parseWorkflowConfig,
  postMessageRequestSchema,
  publishAgentResponseSchema,
  registryServerSummarySchema,
  resetSessionRequestSchema,
  resetSessionResponseSchema,
  RUN_STREAM_EVENT_NAMES,
  SESSION_TITLE_MAX_CHARS,
  runDtoSchema,
  runInputRequestSchema,
  runWorkflowRequestSchema,
  SESSION_BUSY_ERROR_CODE,
  SESSION_NOT_ACTIVE_ERROR_CODE,
  sessionContextControlResponseSchema,
  updateAgentRequestSchema,
  updateModelPresetRequestSchema,
  updateSkillRequestSchema,
  updateWorkflowRequestSchema,
  workflowDiagnosticsSchema,
  workflowDtoSchema,
  type ConnectionDto,
  type RunEventFrame,
  type RunStatus,
} from "./api";
import type { EveStreamEvent } from "./eve-events";

describe("request schemas", () => {
  test("createSessionRequest requires a non-empty message", () => {
    expect(createSessionRequestSchema.safeParse({ message: "hello" }).success).toBe(
      true,
    );
    expect(createSessionRequestSchema.safeParse({ message: "" }).success).toBe(false);
    expect(createSessionRequestSchema.safeParse({}).success).toBe(false);
  });

  test("postMessageRequest requires a non-empty message", () => {
    expect(postMessageRequestSchema.safeParse({ message: "again" }).success).toBe(
      true,
    );
    expect(postMessageRequestSchema.safeParse({ message: "" }).success).toBe(false);
  });
});

describe("run stream contract", () => {
  test("frame names are stable", () => {
    expect(RUN_STREAM_EVENT_NAMES).toEqual(["run_event", "run_status"]);
  });

  test("RunEventFrame carries frozen eve stream events + the stable event id", () => {
    // Compile-time contract check exercised at runtime with a live-observed shape.
    const event: EveStreamEvent = {
      type: "turn.started",
      data: { sequence: 0, turnId: "turn_0" },
      meta: { at: "2026-08-08T02:46:16.164Z", id: "evt_01KZFM75B4GZBXHR68PTHPR01G" },
    };
    const frame: RunEventFrame = {
      runId: "run_1",
      seq: 0,
      event,
      at: "2026-08-08T02:46:16.165Z",
      eventId: event.meta?.id,
    };
    expect(frame.event.type).toBe("turn.started");
    expect(frame.eventId).toBe("evt_01KZFM75B4GZBXHR68PTHPR01G");
  });

  test("eventId is optional — legacy 0.19-era rows have no meta.id", () => {
    const frame: RunEventFrame = {
      runId: "run_1",
      seq: 4,
      event: {
        type: "session.waiting",
        data: { wait: "next-user-message" },
        meta: { at: "2026-07-02T00:00:00.000Z" },
      },
      at: "2026-07-02T00:00:00.001Z",
    };
    expect(frame.eventId).toBeUndefined();
  });
});

describe("session 409 codes", () => {
  test("busy and not-active are DISTINCT codes with opposite recoveries", () => {
    expect(SESSION_BUSY_ERROR_CODE).toBe("session_busy");
    expect(SESSION_NOT_ACTIVE_ERROR_CODE).toBe("session_not_active");
    expect(SESSION_BUSY_ERROR_CODE).not.toBe(SESSION_NOT_ACTIVE_ERROR_CODE);
  });
});

// ── Phase-2 contracts ────────────────────────────────────────────────────────

const NOW = "2026-07-03T00:00:00.000Z";
const UUID = "3f2e2952-979d-456c-9c33-51f89124002a";
const UUID_2 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const validDraft = {
  trigger: { type: "manual" },
  agentId: UUID,
  instructions: { markdown: "Do the thing." },
};

describe("workflow CRUD schemas", () => {
  test("create requires a name; draft is optional but shape-checked", () => {
    expect(createWorkflowRequestSchema.safeParse({ name: "Ops bot" }).success).toBe(true);
    expect(
      createWorkflowRequestSchema.safeParse({ name: "Ops bot", draft: validDraft }).success,
    ).toBe(true);
    expect(createWorkflowRequestSchema.safeParse({ name: "  " }).success).toBe(false);
    expect(
      createWorkflowRequestSchema.safeParse({
        name: "Ops bot",
        draft: { trigger: { type: "nope" } },
      }).success,
    ).toBe(false);
  });

  test("update requires at least one field; enabled toggles alone", () => {
    expect(updateWorkflowRequestSchema.safeParse({}).success).toBe(false);
    expect(updateWorkflowRequestSchema.safeParse({ name: "Renamed" }).success).toBe(true);
    expect(updateWorkflowRequestSchema.safeParse({ draft: validDraft }).success).toBe(true);
    expect(updateWorkflowRequestSchema.safeParse({ enabled: false }).success).toBe(true);
  });

  test("parseWorkflowConfig guards shape and nulls legacy blobs", () => {
    expect(parseWorkflowConfig(validDraft)?.trigger.type).toBe("manual");
    expect(parseWorkflowConfig({})).toBeNull();
    expect(parseWorkflowConfig({ legacy: true })).toBeNull();
  });

  test("workflow DTO carries draft + published snapshot + enabled", () => {
    const parsed = workflowDtoSchema.safeParse({
      id: UUID,
      name: "Ops bot",
      draft: validDraft,
      published: null,
      enabled: true,
      publishedAt: null,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(parsed.success).toBe(true);
    expect(
      workflowDtoSchema.safeParse({
        id: UUID,
        name: "Ops bot",
        draft: validDraft,
        published: validDraft,
        enabled: false,
        publishedAt: NOW,
        createdAt: NOW,
        updatedAt: NOW,
      }).success,
    ).toBe(true);
  });

  test("diagnostics carry path/message/severity", () => {
    expect(
      workflowDiagnosticsSchema.safeParse([
        { path: "agentId", message: "pick a published agent", severity: "error" },
        {
          path: "instructions.markdown",
          message: '"@linear" is no longer in the agent\'s context',
          severity: "warning",
        },
      ]).success,
    ).toBe(true);
    expect(
      workflowDiagnosticsSchema.safeParse([
        { path: "agentId", message: "x", severity: "fatal" },
      ]).success,
    ).toBe(false);
  });
});

describe("session titles (spec D9)", () => {
  const session = {
    id: UUID,
    agentId: UUID_2,
    agentVersionId: UUID_2,
    workflowId: null,
    origin: "chat",
    status: "active",
    eveSessionId: null,
    createdAt: NOW,
    updatedAt: NOW,
  };

  test("title is a required key with a nullable value", () => {
    expect(agentSessionDtoSchema.safeParse({ ...session, title: null }).success).toBe(
      true,
    );
    expect(
      agentSessionDtoSchema.safeParse({ ...session, title: "Ship the notes" }).success,
    ).toBe(true);
    // Omitted entirely is a serializer bug — clients must be able to tell
    // "no title yet" (null → fall back to the message truncation) apart from
    // a field the server forgot to send.
    expect(agentSessionDtoSchema.safeParse(session).success).toBe(false);
  });

  test("a title longer than the column budget is rejected", () => {
    expect(
      agentSessionDtoSchema.safeParse({
        ...session,
        title: "x".repeat(SESSION_TITLE_MAX_CHARS),
      }).success,
    ).toBe(true);
    expect(
      agentSessionDtoSchema.safeParse({
        ...session,
        title: "x".repeat(SESSION_TITLE_MAX_CHARS + 1),
      }).success,
    ).toBe(false);
  });
});

describe("sessions list schemas", () => {
  test("query accepts optional agentId + workflowId + status", () => {
    expect(listSessionsQuerySchema.safeParse({}).success).toBe(true);
    expect(
      listSessionsQuerySchema.safeParse({ agentId: UUID, status: "waiting" }).success,
    ).toBe(true);
    expect(
      listSessionsQuerySchema.safeParse({ agentId: UUID, workflowId: UUID_2 }).success,
    ).toBe(true);
    expect(listSessionsQuerySchema.safeParse({ status: "bogus" }).success).toBe(false);
  });

  test("summary DTO extends the session DTO with list fields", () => {
    // Direct chat: no workflow provenance.
    expect(
      agentSessionSummaryDtoSchema.safeParse({
        id: UUID,
        agentId: UUID_2,
        agentVersionId: UUID,
        workflowId: null,
        origin: "chat",
        status: "active",
        // Untitled until the titler lands — the normal early state.
        title: null,
        eveSessionId: null,
        createdAt: NOW,
        updatedAt: NOW,
        agentName: "General Purpose",
        workflowName: null,
        lastRunStatus: "running",
        lastActivityAt: NOW,
      }).success,
    ).toBe(true);
    // Trigger-origin: workflow provenance present.
    expect(
      agentSessionSummaryDtoSchema.safeParse({
        id: UUID,
        agentId: UUID_2,
        agentVersionId: UUID,
        workflowId: UUID_2,
        origin: "webhook",
        status: "active",
        title: "Nightly digest",
        eveSessionId: "eve_1",
        createdAt: NOW,
        updatedAt: NOW,
        agentName: "General Purpose",
        workflowName: "Ops bot",
        lastRunStatus: "succeeded",
        lastActivityAt: NOW,
      }).success,
    ).toBe(true);
  });
});

describe("run input schema", () => {
  test("accepts exactly one of optionId or text", () => {
    expect(
      runInputRequestSchema.safeParse({ requestId: "req_1", optionId: "approve" }).success,
    ).toBe(true);
    expect(runInputRequestSchema.safeParse({ requestId: "req_1", text: "use prod" }).success).toBe(
      true,
    );
    expect(runInputRequestSchema.safeParse({ requestId: "req_1" }).success).toBe(false);
    expect(
      runInputRequestSchema.safeParse({ requestId: "req_1", optionId: "approve", text: "x" })
        .success,
    ).toBe(false);
    expect(runInputRequestSchema.safeParse({ optionId: "approve" }).success).toBe(false);
  });
});

describe("session context controls (eve 0.31)", () => {
  const session = {
    id: UUID,
    agentId: UUID_2,
    agentVersionId: UUID_2,
    workflowId: null,
    origin: "chat",
    status: "active",
    title: "Ship the release notes",
    eveSessionId: "wrun_01KZFM7CCZWQ4SXBPVV0CGA9HN",
    createdAt: NOW,
    updatedAt: NOW,
  };

  test("clear/compact answer the session plus an eve-derived status", () => {
    expect(
      sessionContextControlResponseSchema.safeParse({ session, status: "accepted" })
        .success,
    ).toBe(true);
    expect(
      sessionContextControlResponseSchema.safeParse({
        session,
        status: "no_active_session",
      }).success,
    ).toBe(true);
    // `no_active_turn` belongs to cancel, not to the context controls.
    expect(
      sessionContextControlResponseSchema.safeParse({
        session,
        status: "no_active_turn",
      }).success,
    ).toBe(false);
  });

  test("reset mints a replacement session only on the `reset` arm", () => {
    const replacement = { ...session, id: UUID_2, eveSessionId: null };
    const parsed = resetSessionResponseSchema.safeParse({
      status: "reset",
      previousSession: session,
      session: replacement,
    });
    expect(parsed.success).toBe(true);

    // A reset without a replacement row would strand the thread on a retired
    // eve session id that can never accept another message.
    expect(
      resetSessionResponseSchema.safeParse({
        status: "reset",
        previousSession: session,
      }).success,
    ).toBe(false);

    expect(
      resetSessionResponseSchema.safeParse({
        status: "no_active_session",
        previousSession: session,
      }).success,
    ).toBe(true);
  });

  test("reset body is optional and takes an audit reason only", () => {
    expect(resetSessionRequestSchema.safeParse(undefined).success).toBe(true);
    expect(resetSessionRequestSchema.safeParse({}).success).toBe(true);
    expect(resetSessionRequestSchema.safeParse({ reason: "starting over" }).success).toBe(
      true,
    );
    expect(resetSessionRequestSchema.safeParse({ reason: "" }).success).toBe(false);
  });
});

describe("mcp connection schemas", () => {
  test("auth write shape covers none/bearer/headers and rejects empties", () => {
    expect(mcpAuthWriteSchema.safeParse({ type: "none" }).success).toBe(true);
    expect(
      mcpAuthWriteSchema.safeParse({ type: "bearer", values: { token: "sk-123" } }).success,
    ).toBe(true);
    expect(
      mcpAuthWriteSchema.safeParse({
        type: "headers",
        values: { "x-api-key": "abc" },
      }).success,
    ).toBe(true);
    expect(mcpAuthWriteSchema.safeParse({ type: "bearer", values: { token: "" } }).success).toBe(
      false,
    );
    expect(mcpAuthWriteSchema.safeParse({ type: "headers", values: {} }).success).toBe(false);
  });
});

describe("registry schemas", () => {
  test("server summary applies defaults for remotes/envVarDeclarations", () => {
    const parsed = registryServerSummarySchema.parse({
      name: "io.github.acme/notes",
      description: "Notes MCP",
      version: "1.2.0",
    });
    expect(parsed.remotes).toEqual([]);
    expect(parsed.envVarDeclarations).toEqual([]);
  });

  test("remote urls must be http(s)", () => {
    expect(
      registryServerSummarySchema.safeParse({
        name: "io.github.acme/notes",
        description: "",
        version: "1.0.0",
        remotes: [{ type: "streamable-http", url: "not-a-url" }],
      }).success,
    ).toBe(false);
  });

});

describe("skill schemas", () => {
  test("create allows empty content (draft) but caps size", () => {
    expect(createSkillRequestSchema.safeParse({ name: "Runbook", content: "" }).success).toBe(
      true,
    );
    expect(createSkillRequestSchema.safeParse({ name: "", content: "x" }).success).toBe(false);
  });

  test("update requires at least one field", () => {
    expect(updateSkillRequestSchema.safeParse({}).success).toBe(false);
    expect(updateSkillRequestSchema.safeParse({ description: null }).success).toBe(true);
  });
});

describe("model preset + allowlist schemas", () => {
  test("preset update requires a known provider", () => {
    expect(
      updateModelPresetRequestSchema.safeParse({
        provider: "openrouter",
        modelId: "deepseek/deepseek-v4-pro",
      }).success,
    ).toBe(true);
    expect(
      updateModelPresetRequestSchema.safeParse({ provider: "openai", modelId: "gpt" }).success,
    ).toBe(false);
  });

  test("the preset DTO carries the effort; the update body may omit it", () => {
    const preset = {
      id: UUID,
      slug: "quick",
      provider: "openrouter",
      modelId: "~deepseek/deepseek-v4-flash-latest",
      reasoning: "low",
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(modelPresetDtoSchema.safeParse(preset).success).toBe(true);
    // Required on reads — a preset without an effort is not resolvable.
    const { reasoning: _dropped, ...withoutEffort } = preset;
    expect(modelPresetDtoSchema.safeParse(withoutEffort).success).toBe(false);

    // Optional on writes: a web bundle from before efforts existed must keep
    // working mid-deploy (absent = keep the stored effort).
    const parsed = updateModelPresetRequestSchema.parse({
      provider: "openrouter",
      modelId: "~deepseek/deepseek-v4-flash-latest",
    });
    expect(parsed.reasoning).toBeUndefined();
    expect(
      updateModelPresetRequestSchema.safeParse({
        provider: "openrouter",
        modelId: "moonshotai/kimi-k3",
        reasoning: "max",
      }).success,
    ).toBe(true);
    expect(
      updateModelPresetRequestSchema.safeParse({
        provider: "openrouter",
        modelId: "moonshotai/kimi-k3",
        reasoning: "ultra",
      }).success,
    ).toBe(false);
  });

  test("allowlist add defaults enabled to true", () => {
    const parsed = addModelAllowlistEntryRequestSchema.parse({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
    });
    expect(parsed.enabled).toBe(true);
  });

  test("allowlist add enforces provider-aware id shape (keyed-run papercut: malformed ids used to fail only at run time)", () => {
    // openrouter ids are vendor/slug (optionally :variant), and a leading `~`
    // marks OpenRouter's floating `-latest` aliases — part of the id, not a
    // typo (a seeded preset points at one).
    for (const good of [
      "deepseek/deepseek-v4-flash",
      "z-ai/glm-5.2",
      "openai/gpt-5.2:extended",
      "~deepseek/deepseek-v4-flash-latest",
      "moonshotai/kimi-k3",
    ]) {
      expect(
        addModelAllowlistEntryRequestSchema.safeParse({
          provider: "openrouter",
          modelId: good,
        }).success,
      ).toBe(true);
    }
    for (const bad of [
      "claude-sonnet-5",
      "deepseek/",
      "/model",
      "a b/c",
      // the tilde is a PREFIX, not a free-floating character
      "~/model",
      "deep~seek/model",
    ]) {
      expect(
        addModelAllowlistEntryRequestSchema.safeParse({
          provider: "openrouter",
          modelId: bad,
        }).success,
      ).toBe(false);
    }
    // anthropic native ids never carry a vendor prefix.
    expect(
      addModelAllowlistEntryRequestSchema.safeParse({
        provider: "anthropic",
        modelId: "anthropic/claude-opus-4-8",
      }).success,
    ).toBe(false);
    expect(
      modelIdShapeProblem("openrouter", "no-vendor-prefix"),
    ).toContain("vendor/model");
    expect(modelIdShapeProblem("anthropic", "claude-opus-4-8")).toBeNull();
    expect(
      modelIdShapeProblem("openrouter", "~deepseek/deepseek-v4-flash-latest"),
    ).toBeNull();
  });

  test("capability DTOs: unknown efforts are null, never an empty list", () => {
    expect(
      modelCapabilityDtoSchema.safeParse({
        provider: "openrouter",
        modelId: "moonshotai/kimi-k3",
        supportedEfforts: ["max", "high", "low"],
        defaultEffort: "high",
        contextWindowTokens: 1_048_576,
      }).success,
    ).toBe(true);
    // Anthropic / no catalog entry / catalog unreachable — unknown, and the
    // UI must offer the full vocabulary rather than an empty selector.
    const unknown = modelCapabilityDtoSchema.parse({
      provider: "anthropic",
      modelId: "claude-opus-4-8",
      supportedEfforts: null,
    });
    expect(unknown.supportedEfforts).toBeNull();
    expect(unknown.defaultEffort).toBeUndefined();
    // Nullable, not optional: an absent key is a server bug, not "unknown".
    expect(
      modelCapabilityDtoSchema.safeParse({
        provider: "anthropic",
        modelId: "claude-opus-4-8",
      }).success,
    ).toBe(false);
    expect(
      modelCapabilityDtoSchema.safeParse({
        provider: "openrouter",
        modelId: "moonshotai/kimi-k3",
        supportedEfforts: ["ultra"],
      }).success,
    ).toBe(false);
    expect(
      modelCapabilityDtoSchema.safeParse({
        provider: "openrouter",
        modelId: "moonshotai/kimi-k3",
        supportedEfforts: null,
        contextWindowTokens: 0,
      }).success,
    ).toBe(false);

    expect(
      listModelCapabilitiesResponseSchema.safeParse({
        models: [],
        catalogAvailable: false,
      }).success,
    ).toBe(true);
    expect(
      listModelCapabilitiesResponseSchema.safeParse({ models: [] }).success,
    ).toBe(false);
  });
});

describe("agent schemas", () => {
  const validAgentDraft = {
    persona: "You are a helpful generalist.",
    model: { preset: "balanced", reasoning: "medium" },
    context: { mcpConnectionIds: [], skillIds: [] },
  };

  test("create requires a name; draft is optional but shape-checked", () => {
    expect(createAgentRequestSchema.safeParse({ name: "General Purpose" }).success).toBe(
      true,
    );
    expect(
      createAgentRequestSchema.safeParse({
        name: "General Purpose",
        draft: validAgentDraft,
      }).success,
    ).toBe(true);
    expect(createAgentRequestSchema.safeParse({ name: "  " }).success).toBe(false);
    expect(
      createAgentRequestSchema.safeParse({
        name: "General Purpose",
        draft: { model: { preset: "turbo" }, context: {} },
      }).success,
    ).toBe(false);
  });

  test("update requires at least one field; null clears description", () => {
    expect(updateAgentRequestSchema.safeParse({}).success).toBe(false);
    expect(updateAgentRequestSchema.safeParse({ description: null }).success).toBe(true);
    expect(
      updateAgentRequestSchema.safeParse({ draft: validAgentDraft }).success,
    ).toBe(true);
  });

  test("parseAgentDefinition guards shape and nulls legacy blobs", () => {
    expect(parseAgentDefinition(validAgentDraft)?.model.preset).toBe("balanced");
    expect(parseAgentDefinition({ basePrompt: "legacy preset" })).toBeNull();
  });

  test("agent DTO carries the published definition (null while unpublished)", () => {
    const base = {
      id: UUID,
      name: "General Purpose",
      description: null,
      runAsUserId: "user_1",
      draft: validAgentDraft,
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(
      agentDtoSchema.safeParse({
        ...base,
        publishedVersionId: null,
        publishedDefinition: null,
      }).success,
    ).toBe(true);
    expect(
      agentDtoSchema.safeParse({
        ...base,
        publishedVersionId: UUID_2,
        publishedDefinition: validAgentDraft,
      }).success,
    ).toBe(true);
    // The field is part of the contract — clients mirror dispatch through it.
    expect(
      agentDtoSchema.safeParse({ ...base, publishedVersionId: null }).success,
    ).toBe(false);
  });

  test("run-workflow request: message and data both optional (schedule fires send {})", () => {
    expect(runWorkflowRequestSchema.safeParse({}).success).toBe(true);
    expect(
      runWorkflowRequestSchema.safeParse({ message: "go", data: { a: 1 } }).success,
    ).toBe(true);
    expect(runWorkflowRequestSchema.safeParse({ data: [] }).success).toBe(false);
  });

  test("summary DTO distinguishes published from draft-only agents", () => {
    const base = {
      id: UUID,
      name: "General Purpose",
      description: null,
      runAsUserId: "user_1",
      createdAt: NOW,
      updatedAt: NOW,
    };
    expect(
      agentSummaryDtoSchema.safeParse({
        ...base,
        publishedVersionId: null,
        publishedAt: null,
        buildStatus: null,
      }).success,
    ).toBe(true);
    expect(
      agentSummaryDtoSchema.safeParse({
        ...base,
        publishedVersionId: UUID_2,
        publishedAt: NOW,
        buildStatus: "succeeded",
      }).success,
    ).toBe(true);
  });

  test("version DTO carries the compiled snapshot + resolved model", () => {
    expect(
      agentVersionDtoSchema.safeParse({
        id: UUID,
        agentId: UUID_2,
        definition: validAgentDraft,
        contentHash: "abc123",
        compilerVersion: "3.0.0",
        eveVersion: "0.6.0",
        modelProvider: "openrouter",
        modelId: "deepseek/deepseek-v4-flash",
        buildStatus: "building",
        createdAt: NOW,
      }).success,
    ).toBe(true);
  });

  test("publish response mirrors the build-triggering publish shape", () => {
    expect(
      publishAgentResponseSchema.safeParse({
        agentId: UUID,
        versionId: UUID_2,
        contentHash: "abc123",
        buildStatus: "pending",
        cached: false,
        buildError: null,
      }).success,
    ).toBe(true);
  });
});

describe("delivery status", () => {
  test("mirrors the delivery_status pgEnum values", () => {
    expect(deliveryStatusSchema.options).toEqual([
      "pending",
      "delivered",
      "failed",
    ]);
  });
});

describe("stream helpers + dto parsing", () => {
  test("isRunStreamTerminalStatus matches the server's closure rule", () => {
    const terminal: RunStatus[] = ["waiting", "succeeded", "failed", "canceled"];
    const live: RunStatus[] = ["queued", "running"];
    for (const status of terminal) expect(isRunStreamTerminalStatus(status)).toBe(true);
    for (const status of live) expect(isRunStreamTerminalStatus(status)).toBe(false);
  });

  test("runDtoSchema parses a wire run payload (chat: no task message/delivery)", () => {
    const parsed = runDtoSchema.safeParse({
      id: UUID,
      agentSessionId: UUID_2,
      status: "waiting",
      triggerEvent: {
        agentId: UUID_2,
        workflowId: null,
        triggerType: "manual",
        message: "hello",
        data: {},
        principal: { workspaceId: "org_1", userId: "user_1", source: "chat" },
      },
      taskMessage: null,
      deliveryStatus: null,
      eveRunId: null,
      error: null,
      startedAt: NOW,
      completedAt: null,
      createdAt: NOW,
    });
    expect(parsed.success).toBe(true);
  });

  test("runDtoSchema parses a dispatched run (task message + slack delivery)", () => {
    const parsed = runDtoSchema.safeParse({
      id: UUID,
      agentSessionId: UUID_2,
      status: "succeeded",
      triggerEvent: {
        agentId: UUID_2,
        workflowId: UUID,
        triggerType: "slack",
        message: "help please",
        data: { channel: "C1", ts: "1.2", thread_ts: "1.2", text: "help please" },
        principal: { workspaceId: "org_1", source: "slack:U777" },
      },
      taskMessage: "<workflow-task>\nTriage the request.\n</workflow-task>",
      deliveryStatus: "delivered",
      eveRunId: "run_9",
      error: null,
      startedAt: NOW,
      completedAt: NOW,
      createdAt: NOW,
    });
    expect(parsed.success).toBe(true);
  });

  test("dry-run compile response discriminates on ok", () => {
    expect(
      dryRunCompileResponseSchema.safeParse({ ok: true, contentHash: "abc123" }).success,
    ).toBe(true);
    expect(
      dryRunCompileResponseSchema.safeParse({
        ok: false,
        error: { code: "compile_failed", message: "bad ref" },
      }).success,
    ).toBe(true);
    expect(dryRunCompileResponseSchema.safeParse({ ok: false }).success).toBe(false);
  });
});

describe("connection contracts", () => {
  test("connectionDtoSchema round-trips a full row DTO", () => {
    const dto = {
      id: "cn_a1b2c3d4e5f6g7h8",
      scope: "workspace",
      name: "Linear",
      description: null,
      source: "catalog",
      catalogSlug: "linear",
      registryName: null,
      url: "https://mcp.linear.app/mcp",
      transport: "streamable-http",
      authType: "none",
      hasCredentials: false,
      oauthStatus: null,
      toolAllow: null,
      toolBlock: null,
      approvalPolicy: null,
      enabled: true,
      health: "unknown",
      lastCheckedAt: null,
      lastError: null,
      tools: null,
      toolsCachedAt: null,
      createdAt: "2026-08-09T00:00:00.000Z",
      updatedAt: "2026-08-09T00:00:00.000Z",
    } satisfies ConnectionDto;
    expect(connectionDtoSchema.parse(dto)).toEqual(dto);
  });

  test("createConnectionRequestSchema discriminates on source", () => {
    expect(
      createConnectionRequestSchema.safeParse({
        source: "catalog",
        slug: "deepwiki",
      }).success,
    ).toBe(true);
    expect(
      createConnectionRequestSchema.safeParse({
        source: "custom",
        name: "CMS",
        url: "https://cms.example.com/mcp",
      }).success,
    ).toBe(true);
    // registry create without remoteUrl is invalid
    expect(
      createConnectionRequestSchema.safeParse({
        source: "registry",
        registryName: "app.linear/linear",
      }).success,
    ).toBe(false);
  });
});
