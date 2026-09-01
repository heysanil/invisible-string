import { ensureDomForThisFile } from "../test/setup";
import "../test/auth-mock";

import { afterEach, beforeEach, expect, test } from "bun:test";
import { cleanup, render, waitFor } from "@testing-library/react";
import {
  QueryClient,
  QueryClientProvider,
  useQuery,
} from "@tanstack/react-query";

import {
  authMockState,
  demoSession,
  demoWorkspace,
  registerAuthMock,
  resetAuthMock,
} from "../test/auth-mock";
import { installFetchMock, type FetchMock } from "../test/harness";
import { queryKeys } from "../lib/queries/keys";

ensureDomForThisFile();
registerAuthMock();

const { completeSignIn, completeSignOut, refetchViewer, useViewer } =
  await import("../lib/auth/viewer");

const ALICE_SKILL = queryKeys.skills.detail({ scope: "user" }, "sk_1");

function bobSession() {
  return {
    user: { id: "u_bob", email: "bob@example.com", name: "Bob" },
    session: { activeOrganizationId: "org_test_1" },
  };
}

function makeClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false, refetchOnWindowFocus: false } },
  });
}

let fetchMock: FetchMock;

beforeEach(() => {
  resetAuthMock();
  fetchMock = installFetchMock();
});
afterEach(() => {
  cleanup();
  fetchMock.restore();
});

/**
 * The Critical finding, at render granularity.
 *
 * Tab A holds Alice's personal-skill detail under the bare `["me"]` scope
 * (`lib/queries/keys.ts`). Tab B signs Alice out and Bob in; cookies are
 * shared, QueryClients are not. When Tab A's viewer refetch resolves as Bob,
 * every `["me"]` entry still holds Alice's rows — and a mounted personal
 * route renders Alice's instructions to Bob.
 *
 * The assertion is not "it is eventually cleaned up": it records EVERY render
 * and proves no frame ever paired Bob's identity with Alice's data. An effect
 * that purges after the fact would fail this.
 */
test("an externally changed principal drops the previous user's cache before it can render", async () => {
  authMockState.session = demoSession();
  authMockState.organizations = [demoWorkspace()];

  const queryClient = makeClient();
  const renders: string[] = [];

  // Seeded, never-stale: nothing but the purge can remove Alice's row.
  queryClient.setQueryData(ALICE_SKILL, "alice-private-skill");

  function Probe() {
    const { viewer } = useViewer();
    const skill = useQuery({
      queryKey: ALICE_SKILL,
      queryFn: async () => "refetched",
      staleTime: Infinity,
    });
    const line = `${viewer?.user.email ?? "none"}|${skill.data ?? "none"}`;
    renders.push(line);
    return <p data-testid="probe">{line}</p>;
  }

  const view = render(
    <QueryClientProvider client={queryClient}>
      <Probe />
    </QueryClientProvider>,
  );

  expect(
    await view.findByText("demo@example.com|alice-private-skill"),
  ).toBeTruthy();

  // Another tab swapped the principal. Nothing in THIS tab signed anybody in.
  authMockState.session = bobSession();
  await refetchViewer(queryClient);

  await waitFor(() => {
    expect(view.getByTestId("probe").textContent).toContain("bob@example.com");
  });

  expect(renders).not.toContain("bob@example.com|alice-private-skill");
  expect(queryClient.getQueryData<string>(ALICE_SKILL)).not.toBe("alice-private-skill");
});

test("a principal change to signed-out drops the previous user's cache too", async () => {
  authMockState.session = demoSession();
  authMockState.organizations = [demoWorkspace()];

  const queryClient = makeClient();
  await refetchViewer(queryClient);
  queryClient.setQueryData(ALICE_SKILL, "alice-private-skill");

  authMockState.session = null;
  expect(await refetchViewer(queryClient)).toBeNull();

  expect(queryClient.getQueryData<string>(ALICE_SKILL)).toBeUndefined();
});

/**
 * The same principal must NOT be purged: a routine focus refetch that returns
 * the same user has to leave the workspace cache alone, or every refocus
 * becomes a full app reload.
 */
test("a refetch that resolves the same principal keeps the cache", async () => {
  authMockState.session = demoSession();
  authMockState.organizations = [demoWorkspace()];

  const queryClient = makeClient();
  await refetchViewer(queryClient);
  queryClient.setQueryData(ALICE_SKILL, "alice-private-skill");

  await refetchViewer(queryClient);

  expect(queryClient.getQueryData<string>(ALICE_SKILL)).toBe("alice-private-skill");
});

/** An undetermined answer is not a principal change — it must purge nothing. */
test("a viewer refetch that throws leaves the cache intact", async () => {
  authMockState.session = demoSession();
  authMockState.organizations = [demoWorkspace()];

  const queryClient = makeClient();
  await refetchViewer(queryClient);
  queryClient.setQueryData(ALICE_SKILL, "alice-private-skill");

  authMockState.getSessionError = { status: 503, message: "unavailable" };
  await expect(refetchViewer(queryClient)).rejects.toBeTruthy();

  expect(queryClient.getQueryData<string>(ALICE_SKILL)).toBe("alice-private-skill");
});

/** Deleting `queryClient.clear()` from completeSignIn must fail the suite. */
test("completeSignIn drops the previous principal's cached data", async () => {
  const queryClient = makeClient();
  queryClient.setQueryData(ALICE_SKILL, "alice-private-skill");

  authMockState.session = demoSession();
  authMockState.organizations = [demoWorkspace()];
  await completeSignIn(queryClient);

  expect(queryClient.getQueryData<string>(ALICE_SKILL)).toBeUndefined();
});

/** Same for completeSignOut. */
test("completeSignOut drops the signed-out principal's cached data", async () => {
  const queryClient = makeClient();
  authMockState.session = demoSession();
  authMockState.organizations = [demoWorkspace()];
  await refetchViewer(queryClient);
  queryClient.setQueryData(ALICE_SKILL, "alice-private-skill");

  await completeSignOut(queryClient);

  expect(queryClient.getQueryData<string>(ALICE_SKILL)).toBeUndefined();
  expect(queryClient.getQueryData(["viewer"])).toBeUndefined();
});
