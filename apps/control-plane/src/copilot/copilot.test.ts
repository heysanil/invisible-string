/**
 * Copilot WS tests — no DB, no real model. The socket is exercised against a
 * real Elysia server with injected fakes: mocked workspace lookups, a static
 * inventory, and the deterministic scripted transport (the same fake-LLM
 * mode COPILOT_FAKE_SCRIPT enables).
 */
import { afterEach, describe, expect, test } from "bun:test";

import type { CopilotServerFrame } from "@invisible-string/shared";
import { Elysia } from "elysia";

import type { WorkspaceDeps } from "../workspace";
import { loadCopilotConfig, type CopilotConfig } from "./config";
import type { WorkspaceInventory } from "./inventory";
import { copilotPlugin, type CopilotDeps } from "./plugin";
import { createScriptedTransport, type ScriptedStep } from "./transport";
import { validateMutation } from "./validate";

const ORG = "org-1";
const OTHER_ORG = "org-2";
const WORKFLOW_ID = "aaaaaaaa-1111-4222-8333-444444444444";
const CONNECTION_ID = "bbbbbbbb-1111-4222-8333-444444444444";
const SKILL_ID = "cccccccc-1111-4222-8333-444444444444";
const AGENT_ID = "dddddddd-1111-4222-8333-444444444444";

const inventory: WorkspaceInventory = {
  connections: [
    {
      id: CONNECTION_ID,
      name: "Linear",
      slug: "linear",
      description: "issue tracker",
      enabled: true,
    },
  ],
  skills: [
    { id: SKILL_ID, name: "Triage Guide", slug: "triage-guide", description: null },
  ],
  agentPresets: [
    {
      id: AGENT_ID,
      name: "Support Agent",
      description: null,
      reasoningEffort: "medium",
      modelPreset: "balanced",
      modelId: null,
    },
  ],
  modelPresets: [
    { slug: "powerful", provider: "openrouter", modelId: "anthropic/claude-opus-4.8" },
    { slug: "balanced", provider: "openrouter", modelId: "anthropic/claude-sonnet-5" },
    { slug: "quick", provider: "openrouter", modelId: "anthropic/claude-haiku-4.5" },
  ],
  allowlist: [
    { provider: "openrouter", modelId: "anthropic/claude-sonnet-5", enabled: true },
    { provider: "openrouter", modelId: "vendor/disabled-model", enabled: false },
  ],
};

/** Cookie-driven fake auth: "user=<id>;org=<org>" grants a session. */
const fakeWorkspaceDeps: WorkspaceDeps = {
  async getSession(headers) {
    const cookie = headers.get("cookie");
    if (!cookie) return null;
    const user = /user=([^;]+)/.exec(cookie)?.[1];
    const org = /org=([^;]+)/.exec(cookie)?.[1];
    if (!user) return null;
    return {
      user: { id: user, email: `${user}@example.com`, name: user },
      session: { activeOrganizationId: org ?? null },
    };
  },
  async getMembership(userId, organizationId) {
    // user "outsider" is a member of nothing.
    if (userId === "outsider") return null;
    return organizationId === ORG || organizationId === OTHER_ORG
      ? { role: "member" }
      : null;
  },
};

interface TestServer {
  url: string;
  transport: ReturnType<typeof createScriptedTransport>;
  stop(): void;
}

const servers: TestServer[] = [];
afterEach(() => {
  for (const server of servers.splice(0)) server.stop();
});

function startServer(
  script: ScriptedStep[],
  configOverrides: Partial<CopilotConfig> = {},
): TestServer {
  const transport = createScriptedTransport(script);
  const deps: CopilotDeps = {
    workspaceDeps: fakeWorkspaceDeps,
    config: { ...loadCopilotConfig({}), ...configOverrides },
    transport,
    loadInventory: async () => inventory,
    workflowExists: async (workflowId, organizationId) =>
      workflowId === WORKFLOW_ID && organizationId === ORG,
  };
  const app = new Elysia().use(copilotPlugin(deps)).listen(0);
  const port = app.server!.port;
  const server: TestServer = {
    url: `ws://localhost:${port}/copilot`,
    transport,
    stop: () => void app.stop(true),
  };
  servers.push(server);
  return server;
}

/** WS client with an awaitable frame queue. */
class Client {
  readonly ws: WebSocket;
  private readonly frames: CopilotServerFrame[] = [];
  private waiters: Array<() => void> = [];
  readonly closed: Promise<{ code: number }>;
  readonly opened: Promise<boolean>;

  constructor(url: string, cookie?: string) {
    this.ws = new WebSocket(url, {
      headers: cookie ? { cookie } : {},
    } as never);
    this.ws.addEventListener("message", (event) => {
      this.frames.push(JSON.parse(String(event.data)) as CopilotServerFrame);
      const waiters = this.waiters.splice(0);
      for (const wake of waiters) wake();
    });
    this.opened = new Promise((resolve) => {
      this.ws.addEventListener("open", () => resolve(true), { once: true });
      this.ws.addEventListener("close", () => resolve(false), { once: true });
      this.ws.addEventListener("error", () => resolve(false), { once: true });
    });
    this.closed = new Promise((resolve) => {
      this.ws.addEventListener("close", (event) =>
        resolve({ code: (event as CloseEvent).code }),
      );
    });
  }

  send(frame: unknown): void {
    this.ws.send(JSON.stringify(frame));
  }

  /** Wait until a frame matching `predicate` arrives; returns all frames so far. */
  async waitFor(
    predicate: (frame: CopilotServerFrame) => boolean,
    timeoutMs = 5_000,
  ): Promise<CopilotServerFrame> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const match = this.frames.find(predicate);
      if (match) return match;
      if (Date.now() > deadline) {
        throw new Error(
          `timed out waiting for frame; got ${JSON.stringify(this.frames)}`,
        );
      }
      await new Promise<void>((resolve) => {
        this.waiters.push(resolve);
        setTimeout(resolve, 50);
      });
    }
  }

  all(): CopilotServerFrame[] {
    return [...this.frames];
  }

  close(): void {
    this.ws.close();
  }
}

function userMessage(message = "help me build this") {
  return {
    type: "user_message",
    workflowId: WORKFLOW_ID,
    draft: {
      trigger: { type: "manual" },
      context: { mcpConnectionIds: [], skillIds: [] },
      agent: { agentPresetId: AGENT_ID },
      instructions: { markdown: "" },
    },
    message,
  };
}

describe("copilot ws auth + scoping", () => {
  test("unauthenticated upgrade is rejected", async () => {
    const server = startServer([]);
    const client = new Client(server.url);
    expect(await client.opened).toBe(false);
  });

  test("authenticated member without active org is rejected", async () => {
    const server = startServer([]);
    const client = new Client(server.url, "user=alice");
    expect(await client.opened).toBe(false);
  });

  test("non-member is rejected at upgrade", async () => {
    const server = startServer([]);
    const client = new Client(server.url, `user=outsider;org=${ORG}`);
    expect(await client.opened).toBe(false);
  });

  test("workflow outside the active workspace → workflow_not_found", async () => {
    const server = startServer([{ text: "hi" }]);
    const client = new Client(server.url, `user=alice;org=${OTHER_ORG}`);
    expect(await client.opened).toBe(true);
    client.send(userMessage());
    const error = await client.waitFor((f) => f.type === "error");
    expect(error).toMatchObject({ type: "error", code: "workflow_not_found" });
    client.close();
  });

  test("malformed frame → invalid_frame error", async () => {
    const server = startServer([]);
    const client = new Client(server.url, `user=alice;org=${ORG}`);
    expect(await client.opened).toBe(true);
    client.send({ type: "user_message", message: "" });
    const error = await client.waitFor((f) => f.type === "error");
    expect(error).toMatchObject({ type: "error", code: "invalid_frame" });
    client.close();
  });
});

describe("copilot tool loop", () => {
  test("propose → accept → final message round trip (deltas stream)", async () => {
    const server = startServer([
      {
        text: "Setting a schedule.",
        toolCalls: [
          {
            toolName: "setTrigger",
            input: {
              trigger: { type: "schedule", cron: "0 9 * * 1-5" },
              rationale: "run every weekday morning",
            },
          },
        ],
      },
      { text: "Done — it now runs weekday mornings." },
    ]);
    const client = new Client(server.url, `user=alice;org=${ORG}`);
    expect(await client.opened).toBe(true);
    client.send(userMessage("run this every weekday at 9"));

    const proposalFrame = await client.waitFor((f) => f.type === "proposal");
    expect(proposalFrame.type === "proposal" && proposalFrame.proposal).toMatchObject({
      tool: "setTrigger",
      params: { trigger: { type: "schedule", cron: "0 9 * * 1-5" } },
      rationale: "run every weekday morning",
    });
    // rationale must be stripped from the applied params.
    if (proposalFrame.type === "proposal") {
      expect("rationale" in (proposalFrame.proposal.params as object)).toBe(false);
    }

    const proposalId =
      proposalFrame.type === "proposal" ? proposalFrame.proposal.id : "";
    client.send({ type: "mutation_result", proposalId, outcome: "accepted" });

    const done = await client.waitFor((f) => f.type === "done");
    expect(done).toMatchObject({ type: "done", reason: "completed" });
    const deltas = client
      .all()
      .filter((f) => f.type === "delta")
      .map((f) => (f.type === "delta" ? f.text : ""))
      .join("");
    expect(deltas).toContain("Setting a schedule.");
    expect(deltas).toContain("Done — it now runs weekday mornings.");

    // The model saw the acceptance as the tool result.
    const secondRequest = server.transport.requests[1]!;
    const toolMessage = secondRequest.messages.find((m) => m.role === "tool");
    expect(JSON.stringify(toolMessage)).toContain("accepted");
    client.close();
  });

  test("schema-invalid tool call is NOT forwarded and the model self-corrects", async () => {
    const server = startServer([
      {
        toolCalls: [{ toolName: "setModelPreset", input: { slug: "fastest" } }],
      },
      {
        toolCalls: [{ toolName: "setModelPreset", input: { slug: "quick" } }],
      },
      { text: "Switched to quick." },
    ]);
    const client = new Client(server.url, `user=alice;org=${ORG}`);
    expect(await client.opened).toBe(true);
    client.send(userMessage("use the cheapest model"));

    const proposalFrame = await client.waitFor((f) => f.type === "proposal");
    // Only the corrected call reaches the client.
    expect(client.all().filter((f) => f.type === "proposal")).toHaveLength(1);
    expect(proposalFrame.type === "proposal" && proposalFrame.proposal.params).toEqual(
      { slug: "quick" },
    );
    const proposalId =
      proposalFrame.type === "proposal" ? proposalFrame.proposal.id : "";
    client.send({ type: "mutation_result", proposalId, outcome: "accepted" });
    await client.waitFor((f) => f.type === "done");

    // The invalid call came back to the model as a tool error.
    const secondRequest = server.transport.requests[1]!;
    expect(JSON.stringify(secondRequest.messages)).toContain("INVALID TOOL CALL");
    client.close();
  });

  test("semantic-invalid call (unknown context id) is bounced to the model", async () => {
    const server = startServer([
      {
        toolCalls: [
          {
            toolName: "addContext",
            input: { kind: "skill", id: "eeeeeeee-1111-4222-8333-444444444444" },
          },
        ],
      },
      { toolCalls: [{ toolName: "addContext", input: { kind: "skill", id: SKILL_ID } }] },
      { text: "attached." },
    ]);
    const client = new Client(server.url, `user=alice;org=${ORG}`);
    expect(await client.opened).toBe(true);
    client.send(userMessage("attach the triage skill"));
    const proposalFrame = await client.waitFor((f) => f.type === "proposal");
    expect(proposalFrame.type === "proposal" && proposalFrame.proposal.params).toEqual(
      { kind: "skill", id: SKILL_ID },
    );
    const proposalId =
      proposalFrame.type === "proposal" ? proposalFrame.proposal.id : "";
    client.send({ type: "mutation_result", proposalId, outcome: "accepted" });
    await client.waitFor((f) => f.type === "done");
    expect(JSON.stringify(server.transport.requests[1]!.messages)).toContain(
      "does not exist",
    );
    client.close();
  });

  test("propose → reject feeds the reason back and the model adapts", async () => {
    const server = startServer([
      {
        toolCalls: [
          { toolName: "setTrigger", input: { trigger: { type: "webhook" } } },
        ],
      },
      {
        toolCalls: [
          {
            toolName: "setTrigger",
            input: { trigger: { type: "schedule", cron: "0 8 * * *" } },
          },
        ],
      },
      { text: "Okay, schedule it is." },
    ]);
    const client = new Client(server.url, `user=alice;org=${ORG}`);
    expect(await client.opened).toBe(true);
    client.send(userMessage());

    const first = await client.waitFor((f) => f.type === "proposal");
    const firstId = first.type === "proposal" ? first.proposal.id : "";
    client.send({
      type: "mutation_result",
      proposalId: firstId,
      outcome: "rejected",
      reason: "I want a schedule, not a webhook",
    });

    const second = await client.waitFor(
      (f) =>
        f.type === "proposal" &&
        JSON.stringify(f.proposal.params).includes("schedule"),
    );
    const secondId = second.type === "proposal" ? second.proposal.id : "";
    client.send({ type: "mutation_result", proposalId: secondId, outcome: "accepted" });
    await client.waitFor((f) => f.type === "done");

    expect(JSON.stringify(server.transport.requests[1]!.messages)).toContain(
      "I want a schedule, not a webhook",
    );
    client.close();
  });

  test("setInstructions with unattached @refs is bounced back", async () => {
    const server = startServer([
      {
        toolCalls: [
          {
            toolName: "setInstructions",
            input: { markdown: "Use @github to file issues." },
          },
        ],
      },
      {
        toolCalls: [
          {
            toolName: "setInstructions",
            input: { markdown: "Use @linear and @skill.triage-guide on @trigger.subject." },
          },
        ],
      },
      { text: "written." },
    ]);
    const client = new Client(server.url, `user=alice;org=${ORG}`);
    expect(await client.opened).toBe(true);
    client.send(userMessage());
    const proposalFrame = await client.waitFor((f) => f.type === "proposal");
    expect(
      proposalFrame.type === "proposal" &&
        JSON.stringify(proposalFrame.proposal.params),
    ).toContain("@linear");
    const proposalId =
      proposalFrame.type === "proposal" ? proposalFrame.proposal.id : "";
    client.send({ type: "mutation_result", proposalId, outcome: "accepted" });
    await client.waitFor((f) => f.type === "done");
    expect(JSON.stringify(server.transport.requests[1]!.messages)).toContain(
      "unknown connection",
    );
    client.close();
  });

  test("over-budget turn ends with a clean over_budget error", async () => {
    const server = startServer(
      [{ text: "expensive answer", outputTokens: 999_999 }],
      { maxOutputTokensPerTurn: 100 },
    );
    const client = new Client(server.url, `user=alice;org=${ORG}`);
    expect(await client.opened).toBe(true);
    client.send(userMessage());
    const error = await client.waitFor((f) => f.type === "error");
    expect(error).toMatchObject({ type: "error", code: "over_budget" });
    client.close();
  });

  test("runaway tool loop hits the step cap", async () => {
    const looping: ScriptedStep[] = Array.from({ length: 10 }, () => ({
      toolCalls: [{ toolName: "setModelPreset", input: { slug: "fastest" } }],
    }));
    const server = startServer(looping, { maxStepsPerTurn: 3 });
    const client = new Client(server.url, `user=alice;org=${ORG}`);
    expect(await client.opened).toBe(true);
    client.send(userMessage());
    const error = await client.waitFor((f) => f.type === "error");
    expect(error).toMatchObject({ type: "error", code: "over_budget" });
    client.close();
  });

  test("abort while a proposal is pending → done(aborted)", async () => {
    const server = startServer([
      {
        toolCalls: [
          { toolName: "setTrigger", input: { trigger: { type: "manual" } } },
        ],
      },
      { text: "never reached" },
    ]);
    const client = new Client(server.url, `user=alice;org=${ORG}`);
    expect(await client.opened).toBe(true);
    client.send(userMessage());
    await client.waitFor((f) => f.type === "proposal");
    client.send({ type: "abort" });
    const done = await client.waitFor((f) => f.type === "done");
    expect(done).toMatchObject({ type: "done", reason: "aborted" });
    // The scripted second step was never consumed.
    expect(server.transport.requests).toHaveLength(1);
    client.close();
  });

  test("second user_message during a streaming turn → turn_in_progress", async () => {
    const server = startServer([
      {
        toolCalls: [
          { toolName: "setTrigger", input: { trigger: { type: "manual" } } },
        ],
      },
      { text: "done" },
    ]);
    const client = new Client(server.url, `user=alice;org=${ORG}`);
    expect(await client.opened).toBe(true);
    client.send(userMessage());
    await client.waitFor((f) => f.type === "proposal");
    client.send(userMessage("second message while busy"));
    const error = await client.waitFor((f) => f.type === "error");
    expect(error).toMatchObject({ type: "error", code: "turn_in_progress" });
    client.send({ type: "abort" });
    await client.waitFor((f) => f.type === "done");
    client.close();
  });
});

describe("copilot session cap", () => {
  test("per-workspace concurrent session cap rejects the extra socket", async () => {
    const server = startServer([], { maxSessionsPerWorkspace: 1 });
    const first = new Client(server.url, `user=alice;org=${ORG}`);
    expect(await first.opened).toBe(true);

    const second = new Client(server.url, `user=bob;org=${ORG}`);
    expect(await second.opened).toBe(true);
    const error = await second.waitFor((f) => f.type === "error");
    expect(error).toMatchObject({ type: "error", code: "session_limit" });
    await second.closed;

    // A different workspace is unaffected.
    const other = new Client(server.url, `user=carol;org=${OTHER_ORG}`);
    expect(await other.opened).toBe(true);

    // Closing the first frees the slot.
    first.close();
    await first.closed;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const third = new Client(server.url, `user=dave;org=${ORG}`);
    expect(await third.opened).toBe(true);
    const frames = third.all();
    expect(frames.some((f) => f.type === "error")).toBe(false);
    other.close();
    third.close();
  });
});

describe("validateMutation", () => {
  test("setAgent modelId must be allowlisted AND enabled", () => {
    const ok = validateMutation(
      "setAgent",
      { modelId: "anthropic/claude-sonnet-5" },
      inventory,
    );
    expect(ok.ok).toBe(true);
    const disabled = validateMutation(
      "setAgent",
      { modelId: "vendor/disabled-model" },
      inventory,
    );
    expect(disabled.ok).toBe(false);
    const unknownPreset = validateMutation(
      "setAgent",
      { agentPresetId: "eeeeeeee-1111-4222-8333-444444444444" },
      inventory,
    );
    expect(unknownPreset.ok).toBe(false);
  });

  test("unknown tool name is invalid", () => {
    expect(validateMutation("dropDatabase", {}, inventory).ok).toBe(false);
  });
});
