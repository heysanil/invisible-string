/**
 * AuthorizationCard states (connectors plan-3 task 9): the waiting-amber
 * pending card (server name, PROMINENT target host — the consent URL is
 * server-supplied content in trusted chrome, spec §13 — instructions, user
 * code, expiry countdown, consent link in a new tab) and the four
 * `authorization.completed` resolved states.
 *
 * The surface is DORMANT on eve 0.31.3 for platform connections (spike
 * REPORT finding 30) — rendered defensively against eve's declared types.
 */
import { ensureDomForThisFile } from "../test/setup";

import { afterEach, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import type { AuthorizationView, RunView } from "../lib/chat/run-view";
import { AuthorizationCard } from "../components/chat/AuthorizationCard";
import { RunMessage } from "../components/chat/RunMessage";

ensureDomForThisFile();
afterEach(async () => {
  cleanup();
  await new Promise((resolve) => setTimeout(resolve, 0));
});

const CONSENT_URL = "https://consent.example.com/authorize?req=1";

function baseAuth(overrides: Partial<AuthorizationView> = {}): AuthorizationView {
  return {
    name: "linear",
    description: "Linear MCP",
    url: CONSENT_URL,
    host: "consent.example.com",
    instructions: "Enter the code shown.",
    userCode: "ABCD-1234",
    // Far future so the countdown renders deterministically as pending.
    expiresAt: new Date(Date.now() + 5 * 60 * 1000).toISOString(),
    outcome: null,
    reason: null,
    ...overrides,
  };
}

test("pending: name, prominent host, instructions, code, countdown, consent link in a new tab", () => {
  const view = render(<AuthorizationCard authorization={baseAuth()} />);

  const group = view.getByRole("group", { name: "Authorization required" });
  expect(group).toBeTruthy();
  // Server name + the target host, displayed OUTSIDE the link too, so the
  // user sees where the consent link goes before clicking (spec §13).
  expect(view.getByText(/linear/)).toBeTruthy();
  expect(view.getAllByText("consent.example.com").length).toBeGreaterThan(0);
  expect(view.getByText("Enter the code shown.")).toBeTruthy();
  expect(view.getByText("ABCD-1234")).toBeTruthy();
  expect(view.getByText(/expires in/i)).toBeTruthy();

  const link = view.getByRole("link") as HTMLAnchorElement;
  expect(link.getAttribute("href")).toBe(CONSENT_URL);
  expect(link.getAttribute("target")).toBe("_blank");
  expect(link.getAttribute("rel")).toContain("noopener");
});

test("pending with a past expiry reads Expired and keeps the link", () => {
  const view = render(
    <AuthorizationCard
      authorization={baseAuth({
        expiresAt: new Date(Date.now() - 60 * 1000).toISOString(),
      })}
    />,
  );
  expect(view.getByText(/expired/i)).toBeTruthy();
  expect(view.getByRole("link")).toBeTruthy();
});

test("pending without url/code/expiry renders the minimal card (no link, no countdown)", () => {
  const view = render(
    <AuthorizationCard
      authorization={baseAuth({
        url: null,
        host: null,
        userCode: null,
        expiresAt: null,
        instructions: null,
      })}
    />,
  );
  expect(view.getByRole("group", { name: "Authorization required" })).toBeTruthy();
  expect(view.queryByRole("link")).toBeNull();
  expect(view.queryByText(/expires/i)).toBeNull();
});

test.each([
  ["authorized", /authorized/i],
  ["declined", /declined/i],
  ["failed", /failed/i],
  ["timed-out", /timed out/i],
] as const)("resolved %s: outcome text shown, consent link gone", (outcome, pattern) => {
  const view = render(
    <AuthorizationCard authorization={baseAuth({ outcome })} />,
  );
  expect(view.getByRole("group", { name: "Authorization resolved" })).toBeTruthy();
  expect(view.getByText(pattern)).toBeTruthy();
  expect(view.queryByRole("link")).toBeNull();
  // The countdown is over once the challenge resolved.
  expect(view.queryByText(/expires in/i)).toBeNull();
});

test("resolved failure surfaces the completion reason", () => {
  const view = render(
    <AuthorizationCard
      authorization={baseAuth({ outcome: "failed", reason: "grant rejected" })}
    />,
  );
  expect(view.getByText(/grant rejected/)).toBeTruthy();
});

test("RunMessage renders authorization cards from the run view", () => {
  const run: RunView = {
    runId: "run1",
    status: "waiting",
    userMessage: "Sync my issues",
    block: null,
    reply: null,
    pendingInputs: [],
    authorizations: [baseAuth()],
    error: null,
    modelId: null,
    canceled: false,
    contextCleared: false,
  };
  const view = render(
    <RunMessage run={run} isChatOrigin onRespond={() => {}} />,
  );
  expect(view.getByRole("group", { name: "Authorization required" })).toBeTruthy();
});
