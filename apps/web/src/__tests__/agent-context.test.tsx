/**
 * The workflow builder's reference sources must mirror DISPATCH, not the
 * agent editor: `useSelectedAgentContext` resolves the selected agent's
 * PUBLISHED context (what the server-side workflow validator and dispatch
 * resolve `@connection`/`@skill` refs against), never the draft. When draft
 * and published context diverge, the published one wins.
 */
import { ensureDomForThisFile } from "../test/setup";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, waitFor } from "@testing-library/react";

import {
  installFetchMock,
  jsonResponse,
  renderWithProviders,
  type FetchMock,
} from "../test/harness";
import { useSelectedAgentContext } from "../lib/builder/agent-context";

ensureDomForThisFile();

const AGENT_ID = "aaaaaaaa-1111-4111-8111-111111111111";
const VERSION_ID = "bbbbbbbb-1111-4111-8111-111111111111";
const DRAFT_CONN = "cccccccc-1111-4111-8111-111111111111";
const PUBLISHED_CONN = "dddddddd-1111-4111-8111-111111111111";
const PUBLISHED_SKILL = "eeeeeeee-1111-4111-8111-111111111111";
const NOW = "2026-07-10T00:00:00.000Z";

function agentPayload(options: { published: boolean }) {
  return {
    agent: {
      id: AGENT_ID,
      name: "Support Bot",
      description: null,
      runAsUserId: "user_1",
      // DRAFT context diverges from the published one (gmail detached,
      // newconn attached — neither republished).
      draft: {
        persona: "Help.",
        model: { preset: "balanced", reasoning: "medium" },
        context: { mcpConnectionIds: [DRAFT_CONN], skillIds: [] },
      },
      publishedVersionId: options.published ? VERSION_ID : null,
      publishedDefinition: options.published
        ? {
            persona: "Help.",
            model: { preset: "balanced", reasoning: "medium" },
            context: {
              mcpConnectionIds: [PUBLISHED_CONN],
              skillIds: [PUBLISHED_SKILL],
            },
          }
        : null,
      createdAt: NOW,
      updatedAt: NOW,
    },
  };
}

function Probe({ agentId }: { agentId: string | null }) {
  const context = useSelectedAgentContext("org_1", agentId);
  return <pre data-testid="ctx">{context === null ? "null" : JSON.stringify(context)}</pre>;
}

let fetchMock: FetchMock;

beforeEach(() => {
  fetchMock = installFetchMock();
});

afterEach(() => {
  fetchMock.restore();
  cleanup();
});

test("resolves the PUBLISHED context when draft and published diverge (mirrors dispatch)", async () => {
  fetchMock.on("GET", `/agents/${AGENT_ID}`, () =>
    jsonResponse(agentPayload({ published: true })),
  );
  const view = renderWithProviders(<Probe agentId={AGENT_ID} />);
  await waitFor(() => {
    const text = view.getByTestId("ctx").textContent ?? "";
    expect(text).not.toBe("null");
  });
  const context = JSON.parse(view.getByTestId("ctx").textContent!) as {
    mcpConnectionIds: string[];
    skillIds: string[];
  };
  // Published wins; the draft-only connection must NOT be offered.
  expect(context.mcpConnectionIds).toEqual([PUBLISHED_CONN]);
  expect(context.skillIds).toEqual([PUBLISHED_SKILL]);
});

test("an UNPUBLISHED agent resolves to the empty context (nothing is dispatch-resolvable)", async () => {
  fetchMock.on("GET", `/agents/${AGENT_ID}`, () =>
    jsonResponse(agentPayload({ published: false })),
  );
  const view = renderWithProviders(<Probe agentId={AGENT_ID} />);
  await waitFor(() => {
    expect(view.getByTestId("ctx").textContent).not.toBe("null");
  });
  const context = JSON.parse(view.getByTestId("ctx").textContent!) as {
    mcpConnectionIds: string[];
    skillIds: string[];
  };
  expect(context.mcpConnectionIds).toEqual([]);
  expect(context.skillIds).toEqual([]);
});

test("no agent selected → null (checks wait for a selection, not a fetch)", () => {
  const view = renderWithProviders(<Probe agentId={null} />);
  expect(view.getByTestId("ctx").textContent).toBe("null");
  expect(fetchMock.calls).toHaveLength(0);
});
