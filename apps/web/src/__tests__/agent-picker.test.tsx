/**
 * AgentPicker component tests (happy-dom): published-only filtering, row
 * content (description + model chip), search + no-match fallback, pick/close
 * round-trips, and the no-published-agents empty state's /agents link.
 */
import { ensureDomForThisFile } from "../test/setup";

import { afterEach, expect, mock, test } from "bun:test";
import { cleanup, fireEvent } from "@testing-library/react";

import type { AgentSummaryDto } from "@invisible-string/shared";

import { AgentPicker, agentModelLabel } from "../components/chat/AgentPicker";
import {
  FIXTURE_AGENTS,
  FIXTURE_RELEASE_BOT,
  FIXTURE_SUPPORT_TRIAGER,
} from "../lib/agents/fixtures";
import { renderWithRouter } from "../test/router";

ensureDomForThisFile();
afterEach(cleanup);

const SUMMARIES: AgentSummaryDto[] = FIXTURE_AGENTS.map((entry) => entry.summary);
const LABELS: ReadonlyMap<string, string> = new Map(
  FIXTURE_AGENTS.flatMap((entry) => {
    const label = agentModelLabel(entry.definition);
    return label === null ? [] : [[entry.agent.id, label] as const];
  }),
);

test("agentModelLabel prefers the override and falls back to the preset slug", () => {
  expect(agentModelLabel(FIXTURE_SUPPORT_TRIAGER.definition)).toBe(
    "deepseek/deepseek-v4-pro",
  );
  expect(agentModelLabel(FIXTURE_RELEASE_BOT.definition)).toBe("powerful");
  expect(agentModelLabel({ not: "a definition" })).toBeNull();
});

test("lists published agents only, with description and model chips", async () => {
  const view = renderWithRouter(
    <AgentPicker agents={SUMMARIES} modelLabels={LABELS} onPick={() => {}} onClose={() => {}} />,
  );
  // RouterProvider resolves its initial route asynchronously.
  expect(await view.findByText("Executive assistant")).toBeTruthy();
  expect(view.getByText("Support triager")).toBeTruthy();
  expect(view.getByText("Data analyst")).toBeTruthy();
  // Draft-only agents are not listed (a session pins a published version).
  expect(view.queryByText("Release bot")).toBeNull();
  // Row content: description + model chip (override vs preset slug).
  expect(
    view.getByText("Handles email, calendar, and follow-ups across the team."),
  ).toBeTruthy();
  expect(view.getByText("deepseek/deepseek-v4-pro")).toBeTruthy();
  expect(view.getByText("balanced")).toBeTruthy();
});

test("search filters by name and shows the no-match fallback", async () => {
  const view = renderWithRouter(
    <AgentPicker agents={SUMMARIES} modelLabels={LABELS} onPick={() => {}} onClose={() => {}} />,
  );
  const search = await view.findByLabelText("Search published agents");

  fireEvent.input(search, { target: { value: "triag" } });
  expect(view.getByText("Support triager")).toBeTruthy();
  expect(view.queryByText("Executive assistant")).toBeNull();

  fireEvent.input(search, { target: { value: "zzz" } });
  expect(view.getByText(/No agents match/)).toBeTruthy();
});

test("picking a row hands back the agent summary", async () => {
  const onPick = mock((_agent: AgentSummaryDto) => {});
  const view = renderWithRouter(
    <AgentPicker agents={SUMMARIES} modelLabels={LABELS} onPick={onPick} onClose={() => {}} />,
  );
  fireEvent.click(await view.findByText("Support triager"));
  expect(onPick).toHaveBeenCalledTimes(1);
  expect(onPick.mock.calls[0]?.[0]?.id).toBe(FIXTURE_SUPPORT_TRIAGER.agent.id);
});

test("a published agent whose build FAILED is disabled with a chip (session create would 422)", async () => {
  const onPick = mock((_agent: AgentSummaryDto) => {});
  const view = renderWithRouter(
    <AgentPicker agents={SUMMARIES} modelLabels={LABELS} onPick={onPick} onClose={() => {}} />,
  );
  // "Data analyst" is the published-but-build-failed fixture: still listed
  // (visibility beats mystery) but not pickable — the first message would
  // fail with raw protocol copy ("version_not_ready") otherwise.
  const row = (await view.findByText("Data analyst")).closest("button")!;
  expect(row.hasAttribute("disabled")).toBe(true);
  expect(view.getByText("Build failed")).toBeTruthy();
  fireEvent.click(row);
  expect(onPick).not.toHaveBeenCalled();
});

test("Escape closes the picker", async () => {
  const onClose = mock(() => {});
  const view = renderWithRouter(
    <AgentPicker agents={SUMMARIES} onPick={() => {}} onClose={onClose} />,
  );
  await view.findByText("Executive assistant");
  fireEvent.keyDown(document, { key: "Escape" });
  expect(onClose).toHaveBeenCalled();
});

test("no published agents → empty state linking to the Agents section", async () => {
  const view = renderWithRouter(
    <AgentPicker
      agents={[FIXTURE_RELEASE_BOT.summary]}
      onPick={() => {}}
      onClose={() => {}}
    />,
  );
  expect(await view.findByText("No published agents")).toBeTruthy();
  expect(
    view.getByText("Publish an agent to start chatting with it."),
  ).toBeTruthy();
  const link = view.getByRole("link", { name: "Open Agents" });
  expect(link.getAttribute("href")).toBe("/agents");
});
