/**
 * Copilot WS tests — no DB, no real model. The socket is exercised against a
 * real Elysia server with injected fakes: mocked workspace lookups, a static
 * inventory, and the deterministic scripted transport (the same fake-LLM
 * mode COPILOT_FAKE_SCRIPT enables). Both surfaces are covered: workflow
 * (setTrigger/setAgent/setInstructions) and agent
 * (setPersona/setModel/addContext/removeContext).
 */
import { afterEach, describe, expect, test } from "bun:test";

import type { CopilotServerFrame } from "@invisible-string/shared";
import { Elysia } from "elysia";

import type { WorkspaceDeps } from "../workspace";
import { loadCopilotConfig, type CopilotConfig } from "./config";
import type { WorkspaceInventory } from "./inventory";
import { copilotPlugin, type CopilotDeps } from "./plugin";
import { createScriptedTransport, type ScriptedStep } from "./transport";
import {
  validateMutation,
  type AgentDraftState,
  type WorkflowDraftState,
} from "./validate";

const ORG = "org-1";
const OTHER_ORG = "org-2";
const WORKFLOW_ID = "aaaaaaaa-1111-4222-8333-444444444444";
const CONNECTION_ID = "bbbbbbbb-1111-4222-8333-444444444444";
const DISABLED_CONNECTION_ID = "bbbbbbbb-2222-4222-8333-444444444444";
const SKILL_ID = "cccccccc-1111-4222-8333-444444444444";
const PUBLISHED_AGENT_ID = "dddddddd-1111-4222-8333-444444444444";
const UNPUBLISHED_AGENT_ID = "dddddddd-2222-4222-8333-444444444444";

const inventory: WorkspaceInventory = {
  connections: [
    {
      id: CONNECTION_ID,
      name: "Linear",
      slug: "linear",
      description: "issue tracker",
      enabled: true,
    },
    {
      id: DISABLED_CONNECTION_ID,
      name: "Old CRM",
      slug: "old-crm",
      description: null,
      enabled: false,
    },
  ],
  skills: [
    { id: SKILL_ID, name: "Triage Guide", slug: "triage-guide", description: null },
  ],
  agents: [
    {
      id: PUBLISHED_AGENT_ID,
      name: "Support Agent",
      description: "handles support requests",
      published: true,
      contextConnectionSlugs: ["linear"],
      contextSkillSlugs: ["triage-guide"],
    },
    {
      id: UNPUBLISHED_AGENT_ID,
      name: "Draft Agent",
      description: null,
      published: false,
      contextConnectionSlugs: [],
      contextSkillSlugs: [],
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

/** Per-surface entity rows living in ORG only. */
const fakeEntityExists: CopilotDeps["entityExists"] = async (
  surface,
  entityId,
  organizationId,
) => {
  if (organizationId !== ORG) return false;
  return surface === "workflow"
    ? entityId === WORKFLOW_ID
    : entityId === PUBLISHED_AGENT_ID || entityId === UNPUBLISHED_AGENT_ID;
};

interface TestServer {
  /** Socket URL for ORG (the common case). */
  url: string;
  /** Socket URL addressing a specific workspace path segment. */
  urlFor(org: string): string;
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
  depsOverrides: Partial<CopilotDeps> = {},
): TestServer {
  const transport = createScriptedTransport(script);
  const deps: CopilotDeps = {
    workspaceDeps: fakeWorkspaceDeps,
    config: { ...loadCopilotConfig({}), ...configOverrides },
    transport,
    loadInventory: async () => inventory,
    entityExists: fakeEntityExists,
    ...depsOverrides,
  };
  const app = new Elysia().use(copilotPlugin(deps)).listen(0);
  const port = app.server!.port;
  const server: TestServer = {
    url: `ws://localhost:${port}/workspaces/${ORG}/copilot`,
    urlFor: (org) => `ws://localhost:${port}/workspaces/${org}/copilot`,
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

function workflowMessage(message = "help me build this workflow") {
  return {
    type: "user_message",
    surface: "workflow",
    entityId: WORKFLOW_ID,
    draft: {
      trigger: { type: "manual" },
      agentId: null,
      instructions: { markdown: "" },
    },
    message,
  };
}

function agentMessage(message = "help me shape this agent") {
  return {
    type: "user_message",
    surface: "agent",
    entityId: PUBLISHED_AGENT_ID,
    draft: {
      persona: "You are a helpful support agent.",
      model: { preset: "balanced", reasoning: "medium" },
      context: { mcpConnectionIds: [], skillIds: [] },
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

  test("path workspace differing from the active workspace is rejected at upgrade (IDOR)", async () => {
    const server = startServer([]);
    const client = new Client(server.urlFor(OTHER_ORG), `user=alice;org=${ORG}`);
    expect(await client.opened).toBe(false);
  });

  test("workflow entity outside the active workspace → entity_not_found", async () => {
    const server = startServer([{ text: "hi" }]);
    const client = new Client(server.urlFor(OTHER_ORG), `user=alice;org=${OTHER_ORG}`);
    expect(await client.opened).toBe(true);
    client.send(workflowMessage());
    const error = await client.waitFor((f) => f.type === "error");
    expect(error).toMatchObject({ type: "error", code: "entity_not_found" });
    client.close();
  });

  test("entity existence is checked PER SURFACE — a workflow id is not an agent", async () => {
    const server = startServer([{ text: "hi" }]);
    const client = new Client(server.url, `user=alice;org=${ORG}`);
    expect(await client.opened).toBe(true);
    client.send({ ...agentMessage(), entityId: WORKFLOW_ID });
    const error = await client.waitFor((f) => f.type === "error");
    expect(error).toMatchObject({ type: "error", code: "entity_not_found" });
    expect(server.transport.requests).toHaveLength(0);
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

  test("user_message without a surface → invalid_frame", async () => {
    const server = startServer([{ text: "hi" }]);
    const client = new Client(server.url, `user=alice;org=${ORG}`);
    expect(await client.opened).toBe(true);
    const frame = workflowMessage() as Record<string, unknown>;
    delete frame.surface;
    client.send(frame);
    const error = await client.waitFor((f) => f.type === "error");
    expect(error).toMatchObject({ type: "error", code: "invalid_frame" });
    expect(server.transport.requests).toHaveLength(0);
    client.close();
  });
});

describe("copilot workflow-surface tool loop", () => {
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
    client.send(workflowMessage("run this every weekday at 9"));

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
    client.send(workflowMessage());

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

  test("setAgent must name a PUBLISHED agent — unpublished bounces to the model", async () => {
    const server = startServer([
      {
        toolCalls: [
          { toolName: "setAgent", input: { agentId: UNPUBLISHED_AGENT_ID } },
        ],
      },
      {
        toolCalls: [
          { toolName: "setAgent", input: { agentId: PUBLISHED_AGENT_ID } },
        ],
      },
      { text: "Support Agent selected." },
    ]);
    const client = new Client(server.url, `user=alice;org=${ORG}`);
    expect(await client.opened).toBe(true);
    client.send(workflowMessage("use the draft agent"));

    const proposalFrame = await client.waitFor((f) => f.type === "proposal");
    // Only the published-agent call reaches the client.
    expect(client.all().filter((f) => f.type === "proposal")).toHaveLength(1);
    expect(proposalFrame.type === "proposal" && proposalFrame.proposal.params).toEqual(
      { agentId: PUBLISHED_AGENT_ID },
    );
    client.send({
      type: "mutation_result",
      proposalId: proposalFrame.type === "proposal" ? proposalFrame.proposal.id : "",
      outcome: "accepted",
    });
    await client.waitFor((f) => f.type === "done");
    expect(JSON.stringify(server.transport.requests[1]!.messages)).toContain(
      "no published version",
    );
    client.close();
  });

  test("setInstructions @refs must be in the (turn-updated) selected agent's published context", async () => {
    const server = startServer([
      // No agent selected yet → bounced.
      {
        toolCalls: [
          {
            toolName: "setInstructions",
            input: { markdown: "Use @linear to file issues." },
          },
        ],
      },
      // Select the published agent first (accepted) …
      {
        toolCalls: [
          { toolName: "setAgent", input: { agentId: PUBLISHED_AGENT_ID } },
        ],
      },
      // … a slug outside its published context is still bounced …
      {
        toolCalls: [
          {
            toolName: "setInstructions",
            input: { markdown: "Use @github to file issues." },
          },
        ],
      },
      // … and its own context slugs now validate.
      {
        toolCalls: [
          {
            toolName: "setInstructions",
            input: {
              markdown: "Use @linear and follow @skill.triage-guide.",
            },
          },
        ],
      },
      { text: "written." },
    ]);
    const client = new Client(server.url, `user=alice;org=${ORG}`);
    expect(await client.opened).toBe(true);
    client.send(workflowMessage());

    const first = await client.waitFor((f) => f.type === "proposal");
    expect(first.type === "proposal" && first.proposal.tool).toBe("setAgent");
    client.send({
      type: "mutation_result",
      proposalId: first.type === "proposal" ? first.proposal.id : "",
      outcome: "accepted",
    });
    const second = await client.waitFor(
      (f) => f.type === "proposal" && f.proposal.tool === "setInstructions",
    );
    expect(
      second.type === "proposal" && JSON.stringify(second.proposal.params),
    ).toContain("@linear");
    client.send({
      type: "mutation_result",
      proposalId: second.type === "proposal" ? second.proposal.id : "",
      outcome: "accepted",
    });
    await client.waitFor((f) => f.type === "done");
    // Both invalid variants came back to the model as tool errors.
    expect(JSON.stringify(server.transport.requests[1]!.messages)).toContain(
      "has no agent",
    );
    expect(JSON.stringify(server.transport.requests[3]!.messages)).toContain(
      "is not in agent",
    );
    client.close();
  });

  test("@trigger refs are validated against the (turn-updated) draft trigger", async () => {
    const server = startServer([
      // Manual trigger carries no dispatch data → bounced.
      {
        toolCalls: [
          {
            toolName: "setInstructions",
            input: { markdown: "Read @trigger.subject first." },
          },
        ],
      },
      // Switch to a form trigger (accepted) …
      {
        toolCalls: [
          {
            toolName: "setTrigger",
            input: {
              trigger: {
                type: "form",
                fields: [
                  { key: "subject", label: "Subject", type: "text", required: true },
                ],
              },
            },
          },
        ],
      },
      // … an unknown field key is still bounced …
      {
        toolCalls: [
          {
            toolName: "setInstructions",
            input: { markdown: "Read @trigger.body first." },
          },
        ],
      },
      // … and the matching key now validates.
      {
        toolCalls: [
          {
            toolName: "setInstructions",
            input: { markdown: "Read @trigger.subject first." },
          },
        ],
      },
      { text: "done." },
    ]);
    const client = new Client(server.url, `user=alice;org=${ORG}`);
    expect(await client.opened).toBe(true);
    client.send(workflowMessage());

    const triggerProposal = await client.waitFor((f) => f.type === "proposal");
    expect(triggerProposal.type === "proposal" && triggerProposal.proposal.tool).toBe(
      "setTrigger",
    );
    client.send({
      type: "mutation_result",
      proposalId:
        triggerProposal.type === "proposal" ? triggerProposal.proposal.id : "",
      outcome: "accepted",
    });
    const instructions = await client.waitFor(
      (f) => f.type === "proposal" && f.proposal.tool === "setInstructions",
    );
    client.send({
      type: "mutation_result",
      proposalId: instructions.type === "proposal" ? instructions.proposal.id : "",
      outcome: "accepted",
    });
    await client.waitFor((f) => f.type === "done");
    expect(JSON.stringify(server.transport.requests[1]!.messages)).toContain(
      "carries no dispatch data",
    );
    expect(JSON.stringify(server.transport.requests[3]!.messages)).toContain(
      "does not match any form field key",
    );
    client.close();
  });

  test("agent-surface tools are rejected on the workflow surface", async () => {
    const server = startServer([
      { toolCalls: [{ toolName: "setPersona", input: { markdown: "Be nice." } }] },
      { text: "understood." },
    ]);
    const client = new Client(server.url, `user=alice;org=${ORG}`);
    expect(await client.opened).toBe(true);
    client.send(workflowMessage());
    await client.waitFor((f) => f.type === "done");
    // Never surfaced as a proposal; bounced to the model instead.
    expect(client.all().filter((f) => f.type === "proposal")).toHaveLength(0);
    expect(JSON.stringify(server.transport.requests[1]!.messages)).toContain(
      "not available on the workflow surface",
    );
    client.close();
  });
});

describe("copilot agent-surface tool loop", () => {
  test("schema-invalid tool call is NOT forwarded and the model self-corrects", async () => {
    const server = startServer([
      // Empty setModel fails the ≥1-field refinement.
      { toolCalls: [{ toolName: "setModel", input: {} }] },
      { toolCalls: [{ toolName: "setModel", input: { preset: "quick" } }] },
      { text: "Switched to quick." },
    ]);
    const client = new Client(server.url, `user=alice;org=${ORG}`);
    expect(await client.opened).toBe(true);
    client.send(agentMessage("use the cheapest model"));

    const proposalFrame = await client.waitFor((f) => f.type === "proposal");
    // Only the corrected call reaches the client.
    expect(client.all().filter((f) => f.type === "proposal")).toHaveLength(1);
    expect(proposalFrame.type === "proposal" && proposalFrame.proposal.params).toEqual(
      { preset: "quick" },
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
    client.send(agentMessage("attach the triage skill"));
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

  test("setPersona @refs must be ATTACHED, not merely workspace-known (compiler parity)", async () => {
    const server = startServer([
      // Workspace-unknown ref → bounced.
      {
        toolCalls: [
          {
            toolName: "setPersona",
            input: { markdown: "Use @github to file issues." },
          },
        ],
      },
      // Known in the workspace but NOT attached to the draft → also bounced
      // (publish would throw UNRESOLVED_REFERENCE).
      {
        toolCalls: [
          {
            toolName: "setPersona",
            input: { markdown: "Use @linear to file issues." },
          },
        ],
      },
      // Attach it first (accepted), then the same persona is valid.
      {
        toolCalls: [
          { toolName: "addContext", input: { kind: "connection", id: CONNECTION_ID } },
        ],
      },
      {
        toolCalls: [
          {
            toolName: "setPersona",
            input: { markdown: "Use @linear to file issues." },
          },
        ],
      },
      { text: "written." },
    ]);
    const client = new Client(server.url, `user=alice;org=${ORG}`);
    expect(await client.opened).toBe(true);
    client.send(agentMessage());

    const first = await client.waitFor((f) => f.type === "proposal");
    expect(first.type === "proposal" && first.proposal.tool).toBe("addContext");
    client.send({
      type: "mutation_result",
      proposalId: first.type === "proposal" ? first.proposal.id : "",
      outcome: "accepted",
    });
    const second = await client.waitFor(
      (f) => f.type === "proposal" && f.proposal.tool === "setPersona",
    );
    expect(
      second.type === "proposal" && JSON.stringify(second.proposal.params),
    ).toContain("@linear");
    client.send({
      type: "mutation_result",
      proposalId: second.type === "proposal" ? second.proposal.id : "",
      outcome: "accepted",
    });
    await client.waitFor((f) => f.type === "done");
    // Both invalid variants came back to the model as tool errors.
    expect(JSON.stringify(server.transport.requests[1]!.messages)).toContain(
      "unknown connection",
    );
    expect(JSON.stringify(server.transport.requests[2]!.messages)).toContain(
      "not attached",
    );
    client.close();
  });

  test("setPersona rejects @trigger refs (compile error TRIGGER_REF_NOT_ALLOWED parity)", async () => {
    const server = startServer([
      {
        toolCalls: [
          {
            toolName: "setPersona",
            input: { markdown: "Always read @trigger.subject first." },
          },
        ],
      },
      {
        toolCalls: [
          {
            toolName: "setPersona",
            input: { markdown: "You triage inbound support requests." },
          },
        ],
      },
      { text: "persona written." },
    ]);
    const client = new Client(server.url, `user=alice;org=${ORG}`);
    expect(await client.opened).toBe(true);
    client.send(agentMessage());
    const proposalFrame = await client.waitFor((f) => f.type === "proposal");
    expect(
      proposalFrame.type === "proposal" &&
        JSON.stringify(proposalFrame.proposal.params),
    ).not.toContain("@trigger");
    client.send({
      type: "mutation_result",
      proposalId:
        proposalFrame.type === "proposal" ? proposalFrame.proposal.id : "",
      outcome: "accepted",
    });
    await client.waitFor((f) => f.type === "done");
    expect(JSON.stringify(server.transport.requests[1]!.messages)).toContain(
      "not allowed in an agent persona",
    );
    client.close();
  });

  test("addContext with a DISABLED connection is bounced (publish would reject it)", async () => {
    const server = startServer([
      {
        toolCalls: [
          {
            toolName: "addContext",
            input: { kind: "connection", id: DISABLED_CONNECTION_ID },
          },
        ],
      },
      {
        toolCalls: [
          { toolName: "addContext", input: { kind: "connection", id: CONNECTION_ID } },
        ],
      },
      { text: "attached." },
    ]);
    const client = new Client(server.url, `user=alice;org=${ORG}`);
    expect(await client.opened).toBe(true);
    client.send(agentMessage("attach the crm"));
    const proposalFrame = await client.waitFor((f) => f.type === "proposal");
    expect(proposalFrame.type === "proposal" && proposalFrame.proposal.params).toEqual(
      { kind: "connection", id: CONNECTION_ID },
    );
    client.send({
      type: "mutation_result",
      proposalId:
        proposalFrame.type === "proposal" ? proposalFrame.proposal.id : "",
      outcome: "accepted",
    });
    await client.waitFor((f) => f.type === "done");
    expect(JSON.stringify(server.transport.requests[1]!.messages)).toContain(
      "disabled",
    );
    client.close();
  });

  test("setModel modelId must be on the enabled allowlist", async () => {
    const server = startServer([
      {
        toolCalls: [
          { toolName: "setModel", input: { modelId: "vendor/disabled-model" } },
        ],
      },
      {
        toolCalls: [
          { toolName: "setModel", input: { modelId: "anthropic/claude-sonnet-5" } },
        ],
      },
      { text: "model set." },
    ]);
    const client = new Client(server.url, `user=alice;org=${ORG}`);
    expect(await client.opened).toBe(true);
    client.send(agentMessage("pin the model"));
    const proposalFrame = await client.waitFor((f) => f.type === "proposal");
    expect(proposalFrame.type === "proposal" && proposalFrame.proposal.params).toEqual(
      { modelId: "anthropic/claude-sonnet-5" },
    );
    client.send({
      type: "mutation_result",
      proposalId:
        proposalFrame.type === "proposal" ? proposalFrame.proposal.id : "",
      outcome: "accepted",
    });
    await client.waitFor((f) => f.type === "done");
    expect(JSON.stringify(server.transport.requests[1]!.messages)).toContain(
      "allowlist",
    );
    client.close();
  });

  test("workflow-surface tools are rejected on the agent surface", async () => {
    const server = startServer([
      {
        toolCalls: [
          { toolName: "setTrigger", input: { trigger: { type: "webhook" } } },
        ],
      },
      { text: "understood." },
    ]);
    const client = new Client(server.url, `user=alice;org=${ORG}`);
    expect(await client.opened).toBe(true);
    client.send(agentMessage());
    await client.waitFor((f) => f.type === "done");
    expect(client.all().filter((f) => f.type === "proposal")).toHaveLength(0);
    expect(JSON.stringify(server.transport.requests[1]!.messages)).toContain(
      "not available on the agent surface",
    );
    client.close();
  });
});

describe("copilot budgets + aborts", () => {
  test("over-budget turn ends with a clean over_budget error", async () => {
    const server = startServer(
      [{ text: "expensive answer", outputTokens: 999_999 }],
      { maxOutputTokensPerTurn: 100 },
    );
    const client = new Client(server.url, `user=alice;org=${ORG}`);
    expect(await client.opened).toBe(true);
    client.send(workflowMessage());
    const error = await client.waitFor((f) => f.type === "error");
    expect(error).toMatchObject({ type: "error", code: "over_budget" });
    client.close();
  });

  test("runaway tool loop hits the step cap", async () => {
    const looping: ScriptedStep[] = Array.from({ length: 10 }, () => ({
      toolCalls: [{ toolName: "setModel", input: {} }],
    }));
    const server = startServer(looping, { maxStepsPerTurn: 3 });
    const client = new Client(server.url, `user=alice;org=${ORG}`);
    expect(await client.opened).toBe(true);
    client.send(agentMessage());
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
    client.send(workflowMessage());
    await client.waitFor((f) => f.type === "proposal");
    client.send({ type: "abort" });
    const done = await client.waitFor((f) => f.type === "done");
    expect(done).toMatchObject({ type: "done", reason: "aborted" });
    // The scripted second step was never consumed.
    expect(server.transport.requests).toHaveLength(1);
    client.close();
  });

  test("abort mid-proposal leaves history provider-valid — the NEXT turn still works", async () => {
    const server = startServer([
      {
        toolCalls: [
          { toolName: "setTrigger", input: { trigger: { type: "manual" } } },
        ],
      },
      { text: "hello again" },
    ]);
    const client = new Client(server.url, `user=alice;org=${ORG}`);
    expect(await client.opened).toBe(true);
    client.send(workflowMessage("first turn"));
    await client.waitFor((f) => f.type === "proposal");
    client.send({ type: "abort" });
    await client.waitFor((f) => f.type === "done");

    // Second turn on the same socket must reach the model with every
    // assistant tool-call paired to a tool result (Anthropic/OpenAI both 400
    // on dangling tool_use).
    client.send(workflowMessage("second turn"));
    await client.waitFor(
      (f) => f.type === "done" && f.reason === "completed",
    );
    const secondRequest = server.transport.requests[1]!;
    const messages = secondRequest.messages;
    for (const [index, message] of messages.entries()) {
      if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
      const callIds = message.content
        .filter((part) => (part as { type?: string }).type === "tool-call")
        .map((part) => (part as { toolCallId: string }).toolCallId);
      if (callIds.length === 0) continue;
      const next = messages[index + 1];
      expect(next?.role).toBe("tool");
      const resultIds = Array.isArray(next?.content)
        ? next.content.map((part) => (part as { toolCallId: string }).toolCallId)
        : [];
      for (const id of callIds) expect(resultIds).toContain(id);
    }
    // The synthesized result marks the abort for the model.
    expect(JSON.stringify(messages)).toContain(
      "aborted by the user before a decision",
    );
    client.close();
  });

  test("an abort racing ahead of the turn start cancels it before any model call", async () => {
    const server = startServer([{ text: "never reached" }], {}, {
      // Hold the pre-turn scope check long enough for the abort to land.
      entityExists: async () => {
        await new Promise((resolve) => setTimeout(resolve, 100));
        return true;
      },
    });
    const client = new Client(server.url, `user=alice;org=${ORG}`);
    expect(await client.opened).toBe(true);
    client.send(workflowMessage("start"));
    client.send({ type: "abort" });
    const done = await client.waitFor((f) => f.type === "done");
    expect(done).toMatchObject({ type: "done", reason: "aborted" });
    expect(server.transport.requests).toHaveLength(0);
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
    client.send(workflowMessage());
    await client.waitFor((f) => f.type === "proposal");
    client.send(workflowMessage("second message while busy"));
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
    const other = new Client(server.urlFor(OTHER_ORG), `user=carol;org=${OTHER_ORG}`);
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

describe("copilot budget + frame bounds", () => {
  test("per-workspace turn cap rejects further turns in the window", async () => {
    const server = startServer([{ text: "one" }, { text: "two" }], {
      maxTurnsPerWindow: 1,
    });
    const client = new Client(server.url, `user=alice;org=${ORG}`);
    expect(await client.opened).toBe(true);
    client.send(workflowMessage("first"));
    await client.waitFor((f) => f.type === "done");
    client.send(workflowMessage("second"));
    const error = await client.waitFor((f) => f.type === "error");
    expect(error).toMatchObject({ type: "error", code: "over_budget" });
    // Only the first turn reached the model.
    expect(server.transport.requests).toHaveLength(1);
    client.close();
  });

  test("per-workspace token budget accumulates across turns", async () => {
    const server = startServer(
      [{ text: "pricey", outputTokens: 5_000 }, { text: "cheap" }],
      { maxTokensPerWindow: 5_000 },
    );
    const client = new Client(server.url, `user=alice;org=${ORG}`);
    expect(await client.opened).toBe(true);
    client.send(workflowMessage("first"));
    await client.waitFor((f) => f.type === "done");
    client.send(workflowMessage("second"));
    const error = await client.waitFor((f) => f.type === "error");
    expect(error).toMatchObject({ type: "error", code: "over_budget" });
    expect(server.transport.requests).toHaveLength(1);
    client.close();
  });

  test("oversized draft is rejected at the frame boundary (input-cost bound)", async () => {
    const server = startServer([{ text: "hi" }]);
    const client = new Client(server.url, `user=alice;org=${ORG}`);
    expect(await client.opened).toBe(true);
    const frame = workflowMessage("hello");
    (frame.draft as Record<string, unknown>).blob = "x".repeat(140_000);
    client.send(frame);
    const error = await client.waitFor((f) => f.type === "error");
    expect(error).toMatchObject({ type: "error", code: "invalid_frame" });
    expect(server.transport.requests).toHaveLength(0);
    client.close();
  });
});

describe("copilot per-turn re-authorization", () => {
  test("a revoked session cannot run further turns — the socket is closed", async () => {
    let revoked = false;
    const server = startServer([{ text: "one" }, { text: "never" }], {}, {
      workspaceDeps: {
        getSession: async (headers) =>
          revoked ? null : fakeWorkspaceDeps.getSession(headers),
        getMembership: fakeWorkspaceDeps.getMembership,
      },
    });
    const client = new Client(server.url, `user=alice;org=${ORG}`);
    expect(await client.opened).toBe(true);
    client.send(workflowMessage("first"));
    await client.waitFor((f) => f.type === "done");

    revoked = true;
    client.send(workflowMessage("second"));
    const error = await client.waitFor((f) => f.type === "error");
    expect(error).toMatchObject({ type: "error", code: "unauthorized" });
    const closed = await client.closed;
    expect(closed.code).toBe(1008);
    expect(server.transport.requests).toHaveLength(1);
  });

  test("a removed membership cannot run further turns", async () => {
    let removed = false;
    const server = startServer([{ text: "one" }, { text: "never" }], {}, {
      workspaceDeps: {
        getSession: fakeWorkspaceDeps.getSession,
        getMembership: async (userId, organizationId) =>
          removed
            ? null
            : fakeWorkspaceDeps.getMembership(userId, organizationId),
      },
    });
    const client = new Client(server.url, `user=alice;org=${ORG}`);
    expect(await client.opened).toBe(true);
    client.send(workflowMessage("first"));
    await client.waitFor((f) => f.type === "done");

    removed = true;
    client.send(workflowMessage("second"));
    const error = await client.waitFor((f) => f.type === "error");
    expect(error).toMatchObject({ type: "error", code: "unauthorized" });
    expect((await client.closed).code).toBe(1008);
  });
});

describe("copilot config guards", () => {
  test("COPILOT_FAKE_SCRIPT is dev/test-gated: dropped under NODE_ENV=production", () => {
    expect(
      loadCopilotConfig({
        NODE_ENV: "production",
        COPILOT_FAKE_SCRIPT: '[{"text":"fake"}]',
      }).fakeScript,
    ).toBeUndefined();
    expect(
      loadCopilotConfig({ COPILOT_FAKE_SCRIPT: '[{"text":"fake"}]' }).fakeScript,
    ).toBe('[{"text":"fake"}]');
  });
});

describe("validateMutation", () => {
  const workflowState = (
    overrides: Partial<Omit<WorkflowDraftState, "surface">> = {},
  ): WorkflowDraftState => ({
    surface: "workflow",
    trigger: { type: "manual" },
    agentId: null,
    ...overrides,
  });
  const agentState = (
    overrides: Partial<Omit<AgentDraftState, "surface">> = {},
  ): AgentDraftState => ({
    surface: "agent",
    connectionIds: new Set(),
    skillIds: new Set(),
    ...overrides,
  });

  test("setAgent requires an existing, PUBLISHED agent", () => {
    const ok = validateMutation(
      "setAgent",
      { agentId: PUBLISHED_AGENT_ID },
      inventory,
      workflowState(),
    );
    expect(ok.ok).toBe(true);
    const unknown = validateMutation(
      "setAgent",
      { agentId: "eeeeeeee-1111-4222-8333-444444444444" },
      inventory,
      workflowState(),
    );
    expect(unknown.ok).toBe(false);
    expect(!unknown.ok && unknown.message).toContain("does not exist");
    const unpublished = validateMutation(
      "setAgent",
      { agentId: UNPUBLISHED_AGENT_ID },
      inventory,
      workflowState(),
    );
    expect(unpublished.ok).toBe(false);
    expect(!unpublished.ok && unpublished.message).toContain("no published version");
  });

  test("unknown tool name is invalid on both surfaces", () => {
    expect(
      validateMutation("dropDatabase", {}, inventory, workflowState()).ok,
    ).toBe(false);
    expect(validateMutation("dropDatabase", {}, inventory, agentState()).ok).toBe(
      false,
    );
  });

  test("tools from the other surface are rejected, with a surface-naming message", () => {
    const personaOnWorkflow = validateMutation(
      "setPersona",
      { markdown: "Be nice." },
      inventory,
      workflowState(),
    );
    expect(personaOnWorkflow.ok).toBe(false);
    expect(!personaOnWorkflow.ok && personaOnWorkflow.message).toContain(
      "not available on the workflow surface",
    );
    const triggerOnAgent = validateMutation(
      "setTrigger",
      { trigger: { type: "manual" } },
      inventory,
      agentState(),
    );
    expect(triggerOnAgent.ok).toBe(false);
    expect(!triggerOnAgent.ok && triggerOnAgent.message).toContain(
      "not available on the agent surface",
    );
  });

  test("setModel modelId must be allowlisted AND enabled", () => {
    const ok = validateMutation(
      "setModel",
      { modelId: "anthropic/claude-sonnet-5" },
      inventory,
      agentState(),
    );
    expect(ok.ok).toBe(true);
    const disabled = validateMutation(
      "setModel",
      { modelId: "vendor/disabled-model" },
      inventory,
      agentState(),
    );
    expect(disabled.ok).toBe(false);
    const empty = validateMutation("setModel", {}, inventory, agentState());
    expect(empty.ok).toBe(false);
  });

  test("addContext rejects disabled connections; removeContext still allows them", () => {
    const add = validateMutation(
      "addContext",
      { kind: "connection", id: DISABLED_CONNECTION_ID },
      inventory,
      agentState(),
    );
    expect(add.ok).toBe(false);
    expect(!add.ok && add.message).toContain("disabled");
    const remove = validateMutation(
      "removeContext",
      { kind: "connection", id: DISABLED_CONNECTION_ID },
      inventory,
      agentState(),
    );
    expect(remove.ok).toBe(true);
  });

  test("setPersona treats a disabled connection's slug as unknown", () => {
    const result = validateMutation(
      "setPersona",
      { markdown: "Use @old-crm for history." },
      inventory,
      agentState({ connectionIds: new Set([DISABLED_CONNECTION_ID]) }),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("unknown connection");
  });

  test("setPersona rejects @trigger refs outright", () => {
    const result = validateMutation(
      "setPersona",
      { markdown: "Always read @trigger.subject." },
      inventory,
      agentState(),
    );
    expect(result.ok).toBe(false);
    expect(!result.ok && result.message).toContain("not allowed in an agent persona");
  });

  test("workflow setInstructions checks refs against the SELECTED agent's published context", () => {
    // No agent selected → any context ref is a problem.
    const noAgent = validateMutation(
      "setInstructions",
      { markdown: "Use @linear." },
      inventory,
      workflowState(),
    );
    expect(noAgent.ok).toBe(false);
    expect(!noAgent.ok && noAgent.message).toContain("has no agent");

    // Selected but unpublished agent → still a problem.
    const unpublished = validateMutation(
      "setInstructions",
      { markdown: "Use @linear." },
      inventory,
      workflowState({ agentId: UNPUBLISHED_AGENT_ID }),
    );
    expect(unpublished.ok).toBe(false);
    expect(!unpublished.ok && unpublished.message).toContain("no published version");

    // Selected agent that has since been deleted → still a problem.
    const deleted = validateMutation(
      "setInstructions",
      { markdown: "Use @linear." },
      inventory,
      workflowState({ agentId: "ffffffff-1111-4222-8333-444444444444" }),
    );
    expect(deleted.ok).toBe(false);
    expect(!deleted.ok && deleted.message).toContain("no longer exists");

    // Published agent: its own context slugs pass, others bounce.
    const selected = workflowState({ agentId: PUBLISHED_AGENT_ID });
    const ok = validateMutation(
      "setInstructions",
      { markdown: "Use @linear and @skill.triage-guide." },
      inventory,
      selected,
    );
    expect(ok.ok).toBe(true);
    const outside = validateMutation(
      "setInstructions",
      { markdown: "Use @github." },
      inventory,
      selected,
    );
    expect(outside.ok).toBe(false);
    expect(!outside.ok && outside.message).toContain("is not in agent");
  });

  test("workflow setInstructions flags bare @trigger and skips trigger checks on unparseable triggers", () => {
    const bare = validateMutation(
      "setInstructions",
      { markdown: "Start from @trigger data." },
      inventory,
      workflowState({ trigger: { type: "webhook" } }),
    );
    expect(bare.ok).toBe(false);
    expect(!bare.ok && bare.message).toContain("bare");

    // Unparseable draft trigger (null) — lenient: trigger refs pass through.
    const lenient = validateMutation(
      "setInstructions",
      { markdown: "Read @trigger.subject." },
      inventory,
      workflowState({ trigger: null }),
    );
    expect(lenient.ok).toBe(true);
  });
});
