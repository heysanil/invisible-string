/**
 * Keyed scripted transport tests — the STATELESS fake the browser E2E
 * harness boots via COPILOT_FAKE_SCRIPT. Selection, history-derived step
 * indexing, inventory-id placeholders and the {{toolResults}} echo are all
 * pure functions of the request, so they are tested directly on stream().
 */
import { describe, expect, test } from "bun:test";
import type { ModelMessage } from "ai";

import {
  createFakeTransport,
  createKeyedScriptedTransport,
  type KeyedScript,
  type TransportPart,
  type TransportRequest,
} from "./transport";

const SYSTEM = [
  "## Workspace inventory",
  "MCP connections:",
  '- id=11111111-1111-4111-8111-111111111111 name="notes" ref=@notes — stub notes server',
  '- id=22222222-2222-4222-8222-222222222222 name="notes archive" ref=@notes-archive',
  "Skills:",
  '- id=33333333-3333-4333-8333-333333333333 name="Triage Guide" ref=@skill.triage-guide',
].join("\n");

function request(messages: ModelMessage[]): TransportRequest {
  return {
    system: SYSTEM,
    messages,
    tools: [],
    abortSignal: new AbortController().signal,
    maxOutputTokens: 8_192,
  };
}

async function collect(
  transport: { stream(req: TransportRequest): AsyncIterable<TransportPart> },
  messages: ModelMessage[],
): Promise<TransportPart[]> {
  const parts: TransportPart[] = [];
  for await (const part of transport.stream(request(messages))) parts.push(part);
  return parts;
}

const SCRIPTS: KeyedScript[] = [
  {
    match: "scaffold me",
    steps: [
      {
        text: "Starting.",
        toolCalls: [
          {
            toolName: "addContext",
            input: { kind: "connection", id: "{{connectionId:notes}}" },
          },
          {
            toolName: "addContext",
            input: { kind: "skill", id: "{{skillId:triage-guide}}" },
          },
        ],
      },
      { text: "Outcomes: {{toolResults}}" },
    ],
  },
];

describe("createKeyedScriptedTransport", () => {
  test("selects the script by user-message substring; no match ends the turn", async () => {
    const transport = createKeyedScriptedTransport(SCRIPTS);
    const parts = await collect(transport, [
      { role: "user", content: "something entirely different" },
    ]);
    expect(parts).toEqual([{ type: "finish", outputTokens: 0 }]);
  });

  test("resolves inventory-id placeholders from the system prompt", async () => {
    const transport = createKeyedScriptedTransport(SCRIPTS);
    const parts = await collect(transport, [
      { role: "user", content: "please scaffold me a workflow" },
    ]);
    const calls = parts.filter((p) => p.type === "tool-call");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.input).toEqual({
      kind: "connection",
      // Exact-slug match: "notes" must NOT resolve to "notes-archive".
      id: "11111111-1111-4111-8111-111111111111",
    });
    expect(calls[1]!.input).toEqual({
      kind: "skill",
      id: "33333333-3333-4333-8333-333333333333",
    });
  });

  test("step index derives from tool messages after the last user turn (stateless replay)", async () => {
    const transport = createKeyedScriptedTransport(SCRIPTS);
    const turnSoFar: ModelMessage[] = [
      { role: "user", content: "scaffold me something" },
      { role: "assistant", content: "Starting." },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "x",
            toolName: "addContext",
            output: { type: "text", value: "accepted — applied" },
          },
        ],
      },
    ];
    // Same request twice — a stateless transport must answer identically.
    for (let i = 0; i < 2; i++) {
      const parts = await collect(transport, turnSoFar);
      const text = parts
        .filter((p) => p.type === "text-delta")
        .map((p) => p.text)
        .join("");
      expect(text).toBe("Outcomes: addContext: accepted — applied");
      expect(parts.some((p) => p.type === "tool-call")).toBe(false);
    }
  });

  test("a SECOND user turn in the same session restarts step indexing", async () => {
    const transport = createKeyedScriptedTransport(SCRIPTS);
    const parts = await collect(transport, [
      { role: "user", content: "scaffold me one" },
      { role: "assistant", content: "Starting." },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "x",
            toolName: "addContext",
            output: { type: "text", value: "accepted" },
          },
        ],
      },
      { role: "assistant", content: "Outcomes: …" },
      { role: "user", content: "scaffold me again" },
    ]);
    // Step 0 again: text + the two tool calls.
    expect(parts.filter((p) => p.type === "tool-call")).toHaveLength(2);
  });
});

describe("createFakeTransport format detection", () => {
  test("array of {match, steps} builds the keyed transport", async () => {
    const transport = createFakeTransport(JSON.stringify(SCRIPTS));
    const parts = await collect(transport, [
      { role: "user", content: "scaffold me now" },
    ]);
    expect(parts.filter((p) => p.type === "tool-call")).toHaveLength(2);
  });

  test("array of plain steps builds the sequential transport", async () => {
    const transport = createFakeTransport(
      JSON.stringify([{ text: "hello" }, { text: "world" }]),
    );
    const first = await collect(transport, [{ role: "user", content: "a" }]);
    const second = await collect(transport, [{ role: "user", content: "b" }]);
    const text = (parts: TransportPart[]) =>
      parts
        .filter((p) => p.type === "text-delta")
        .map((p) => p.text)
        .join("");
    expect(text(first)).toBe("hello");
    expect(text(second)).toBe("world");
  });

  test("non-array JSON is rejected", () => {
    expect(() => createFakeTransport('{"match":"x"}')).toThrow(/array/);
  });
});
