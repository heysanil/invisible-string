import { describe, expect, test } from "bun:test";

import {
  addModelAllowlistEntryRequestSchema,
  agentSessionSummaryDtoSchema,
  createAgentPresetRequestSchema,
  createMcpConnectionRequestSchema,
  createSessionRequestSchema,
  createSkillRequestSchema,
  createWorkflowRequestSchema,
  dryRunCompileResponseSchema,
  installMcpConnectionRequestSchema,
  isRunStreamTerminalStatus,
  listSessionsQuerySchema,
  mcpAuthWriteSchema,
  mcpConnectionDtoSchema,
  parseWorkflowDraft,
  postMessageRequestSchema,
  registryServerSummarySchema,
  RUN_STREAM_EVENT_NAMES,
  runDtoSchema,
  runInputRequestSchema,
  updateAgentPresetRequestSchema,
  updateMcpConnectionRequestSchema,
  updateModelPresetRequestSchema,
  updateSkillRequestSchema,
  updateWorkflowRequestSchema,
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

  test("RunEventFrame carries frozen eve stream events", () => {
    // Compile-time contract check exercised at runtime with a live-observed shape.
    const event: EveStreamEvent = {
      type: "turn.started",
      data: { sequence: 0, turnId: "turn_0" },
      meta: { at: "2026-07-02T00:00:00.000Z" },
    };
    const frame: RunEventFrame = {
      runId: "run_1",
      seq: 0,
      event,
      at: "2026-07-02T00:00:00.001Z",
    };
    expect(frame.event.type).toBe("turn.started");
  });
});

// ── Phase-2 contracts ────────────────────────────────────────────────────────

const NOW = "2026-07-03T00:00:00.000Z";
const UUID = "3f2e2952-979d-456c-9c33-51f89124002a";
const UUID_2 = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";

const validDraft = {
  trigger: { type: "manual" },
  context: { mcpConnectionIds: [], skillIds: [] },
  agent: { agentPresetId: UUID },
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

  test("update requires at least one field", () => {
    expect(updateWorkflowRequestSchema.safeParse({}).success).toBe(false);
    expect(updateWorkflowRequestSchema.safeParse({ name: "Renamed" }).success).toBe(true);
    expect(updateWorkflowRequestSchema.safeParse({ draft: validDraft }).success).toBe(true);
  });

  test("parseWorkflowDraft guards shape and nulls legacy blobs", () => {
    expect(parseWorkflowDraft(validDraft)?.trigger.type).toBe("manual");
    expect(parseWorkflowDraft({})).toBeNull();
    expect(parseWorkflowDraft({ legacy: true })).toBeNull();
  });
});

describe("sessions list schemas", () => {
  test("query accepts optional workflowId + status", () => {
    expect(listSessionsQuerySchema.safeParse({}).success).toBe(true);
    expect(
      listSessionsQuerySchema.safeParse({ workflowId: UUID, status: "waiting" }).success,
    ).toBe(true);
    expect(listSessionsQuerySchema.safeParse({ status: "bogus" }).success).toBe(false);
  });

  test("summary DTO extends the session DTO with list fields", () => {
    const parsed = agentSessionSummaryDtoSchema.safeParse({
      id: UUID,
      workflowId: UUID_2,
      workflowVersionId: UUID,
      origin: "chat",
      status: "active",
      eveSessionId: null,
      createdAt: NOW,
      updatedAt: NOW,
      workflowName: "Ops bot",
      lastRunStatus: "running",
      lastActivityAt: NOW,
    });
    expect(parsed.success).toBe(true);
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

  test("create requires an http(s) URL and at most one tool filter", () => {
    const base = { name: "Linear", url: "https://mcp.linear.app/mcp" };
    expect(createMcpConnectionRequestSchema.safeParse(base).success).toBe(true);
    expect(
      createMcpConnectionRequestSchema.safeParse({ ...base, url: "ftp://nope" }).success,
    ).toBe(false);
    expect(
      createMcpConnectionRequestSchema.safeParse({
        ...base,
        toolAllow: ["create_issue"],
        toolBlock: ["delete_issue"],
      }).success,
    ).toBe(false);
    expect(
      createMcpConnectionRequestSchema.safeParse({
        ...base,
        toolAllow: ["create_issue"],
        approvalPolicy: { default: "always" },
      }).success,
    ).toBe(true);
  });

  test("update requires at least one field; auth omitted keeps credentials", () => {
    expect(updateMcpConnectionRequestSchema.safeParse({}).success).toBe(false);
    expect(updateMcpConnectionRequestSchema.safeParse({ enabled: false }).success).toBe(true);
    expect(
      updateMcpConnectionRequestSchema.safeParse({ auth: { type: "none" } }).success,
    ).toBe(true);
  });

  test("DTO carries hasCredentials, never secret material", () => {
    const parsed = mcpConnectionDtoSchema.safeParse({
      id: UUID,
      scope: "workspace",
      name: "Linear",
      description: null,
      source: "registry",
      registryId: "io.linear/mcp",
      url: "https://mcp.linear.app/mcp",
      toolAllow: null,
      toolBlock: null,
      approvalPolicy: { default: "always", tools: { delete_issue: "always" } },
      enabled: true,
      hasCredentials: true,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(parsed.success).toBe(true);
    expect(parsed.success && "authConfigEncrypted" in parsed.data).toBe(false);
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

  test("install request maps a chosen remote + optional auth", () => {
    expect(
      installMcpConnectionRequestSchema.safeParse({
        registryName: "io.github.acme/notes",
        remoteUrl: "https://notes.example.com/mcp",
        auth: { type: "headers", values: { "x-api-key": "secret" } },
      }).success,
    ).toBe(true);
    expect(
      installMcpConnectionRequestSchema.safeParse({ registryName: "io.github.acme/notes" })
        .success,
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

  test("allowlist add defaults enabled to true", () => {
    const parsed = addModelAllowlistEntryRequestSchema.parse({
      provider: "anthropic",
      modelId: "claude-sonnet-5",
    });
    expect(parsed.enabled).toBe(true);
  });
});

describe("agent preset schemas", () => {
  test("create applies reasoning/preset defaults", () => {
    const parsed = createAgentPresetRequestSchema.parse({
      name: "General Purpose",
      basePrompt: "You are a helpful generalist.",
    });
    expect(parsed.reasoningEffort).toBe("medium");
    expect(parsed.modelPreset).toBe("balanced");
  });

  test("update requires at least one field; null clears model override", () => {
    expect(updateAgentPresetRequestSchema.safeParse({}).success).toBe(false);
    expect(updateAgentPresetRequestSchema.safeParse({ modelId: null }).success).toBe(true);
  });
});

describe("stream helpers + dto parsing", () => {
  test("isRunStreamTerminalStatus matches the server's closure rule", () => {
    const terminal: RunStatus[] = ["waiting", "succeeded", "failed", "canceled"];
    const live: RunStatus[] = ["queued", "running"];
    for (const status of terminal) expect(isRunStreamTerminalStatus(status)).toBe(true);
    for (const status of live) expect(isRunStreamTerminalStatus(status)).toBe(false);
  });

  test("runDtoSchema parses a wire run payload", () => {
    const parsed = runDtoSchema.safeParse({
      id: UUID,
      agentSessionId: UUID_2,
      status: "waiting",
      triggerEvent: {
        workflowId: UUID,
        triggerType: "manual",
        message: "hello",
        data: {},
        principal: { workspaceId: "org_1", userId: "user_1", source: "chat" },
      },
      eveRunId: null,
      error: null,
      startedAt: NOW,
      completedAt: null,
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
