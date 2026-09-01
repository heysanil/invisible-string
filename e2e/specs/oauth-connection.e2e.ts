/**
 * THE FULL OAUTH SPINE (connectors redesign spec §6, plan-3 Task 11) against
 * the real stack — every hop of the broker chain, end to end:
 *
 *   1. CREATE a custom connection on the stub's OAuth-protected endpoint
 *      (`/mcp-oauth`) with `auth:{type:"oauth"}` → row + pending grant. The
 *      custom-URL dialog has no OAuth lane (catalog recipes own the UI entry
 *      point), so the create rides the same unified `POST /connections` the
 *      dialog posts, from the browser session; everything after is UI. A
 *      connection born without a grant reads **Auth required**, and NOTHING
 *      dials the server: not the create, not the detail (whose stale re-probe
 *      is suppressed until there is a grant), not even an explicit Test
 *      connection, which answers `auth_required` without a round trip (fix
 *      plan F10/P1.2 — consent is the missing piece, and dialling could only
 *      collect the server's entirely correct 401).
 *   2. CONNECT from the detail panel: the popup runs the control plane's REAL
 *      discovery (401 → `WWW-Authenticate` PRM pointer + challenge scope →
 *      stub AS metadata) → DCR (localhost base URL is never CIMD-usable) →
 *      PKCE consent on the stub AS's interstitial (Playwright clicks Approve)
 *      → callback page closes the popup → the panel flips to Connected.
 *   3. The POST-CONNECT PROBE is the assertion this spec exists for (fix plan
 *      F1/P1.3). The stub's `/mcp-oauth` refuses an unauthenticated handshake
 *      exactly like every real OAuth MCP server (Vercel, Linear, Notion,
 *      Sentry — verified live), so health can reach `ok` only if the probe
 *      went through the broker's token lifecycle: it must have refreshed
 *      centrally (the AS counts the grant) and presented a bearer the AS says
 *      is active. Tool discovery then works for an OAuth connection for the
 *      first time — `tools_cache` is written only on a healthy probe — so the
 *      card counts the tool and the TOOL PICKER lists `save_note` by name.
 *      The fixture used to leave the handshake open to accommodate a
 *      token-less probe, which made this same `ok` certify the bug.
 *   4. ATTACH → PUBLISH (real eve build: oauth codegen emits `getToken` via
 *      the platform token broker) → CHAT. Connection tools are not advertised
 *      directly on eve 0.31 — the mock-model choreography is a
 *      `connection_search` discovery turn, then explicit
 *      `<slug>__save_note` turns (spike finding 34).
 *   5. The tool call proves the DELIVERY CHAIN: the compiled agent's
 *      `getToken` self-mints a version-bound platform JWT, hits
 *      `POST /internal/connections/token`, the broker refreshes centrally
 *      (the stub AS issues 30 s tokens — below both 60 s expiry margins, so
 *      every read refreshes), and the stub MCP server's `tools/call` accepts
 *      only a bearer the stub AS says is active (introspection).
 *   6. `POST /__expire` force-expires every outstanding access token — the
 *      next tool call STILL succeeds, which only a freshly-refreshed token
 *      can explain (the AS's refresh-grant counter increments again).
 *   7. The AS flips to `invalid_grant`: the broker lands the grant `expired`
 *      + connection `auth_error`, the run surfaces a FAILED tool call (never
 *      a hang — spike finding 34: a getToken failure is a failed
 *      `action.result` and the turn completes), and the detail offers
 *      Reconnect.
 *
 * One serial test: it is a single user story and the stack runs one worker.
 */
import { expect, test, type Page } from "@playwright/test";

import { API_BASE_URL, PORTS, STUB_AS_URL, STUB_OAUTH_MCP_URL } from "../config.ts";
import { gotoSection } from "../support/authoring.ts";
import {
  attachAgentResource,
  openNewAgent,
  publishAgentAndWaitReady,
  startChatAndSend,
  writePersona,
  RUN_TIMEOUT_MS,
} from "../support/builder.ts";
import { signUpIntoWorkspace } from "../support/flows.ts";

/** Name doubles as the compiled slug (lowercase alnum survives slugify). */
const CONNECTION = "securenotes";
/** The stub's single MCP tool (e2e/scripts/stub-mcp.ts). */
const STUB_TOOL = "save_note";
const AGENT_NAME = "OAuth spine agent";
const STUB_CALLS_URL = `http://127.0.0.1:${PORTS.stubMcp}/__calls`;

interface AsStats {
  mode: "ok" | "invalid_grant";
  tokenEndpointHits: number;
  authorizationCodeGrants: number;
  refreshTokenGrants: number;
  registrations: number;
  issuedAccessTokens: number;
}

interface StubCalls {
  oauthCalls: { name: string; args: unknown }[];
  /**
   * Every request the OAuth-protected stub endpoint saw: HTTP method, rpc
   * method (`?` for the bodyless discovery GET), and whether it carried a
   * bearer the stub AS says is active. Never token values.
   */
  oauthRequests: {
    httpMethod: string;
    rpcMethod: string;
    authValid: boolean;
  }[];
}

type OauthRequest = StubCalls["oauthRequests"][number];

/** Authenticated handshake/list dials — what a token-carrying probe leaves. */
function authenticatedDials(requests: OauthRequest[], rpcMethod: string): number {
  return requests.filter(
    (request) => request.rpcMethod === rpcMethod && request.authValid,
  ).length;
}

async function asStats(): Promise<AsStats> {
  const res = await fetch(`${STUB_AS_URL}/__stats`);
  expect(res.ok).toBe(true);
  return (await res.json()) as AsStats;
}

async function stubCalls(): Promise<StubCalls> {
  const res = await fetch(STUB_CALLS_URL);
  expect(res.ok).toBe(true);
  return (await res.json()) as StubCalls;
}

async function setAsMode(mode: "ok" | "invalid_grant"): Promise<void> {
  const res = await fetch(`${STUB_AS_URL}/__mode`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ mode }),
  });
  expect(res.ok).toBe(true);
}

/** Credentialed JSON POST from the browser origin (flows.ts `callAuth` idiom). */
async function apiPost(
  page: Page,
  path: string,
  payload: unknown,
): Promise<{ status: number; body: unknown }> {
  return page.evaluate(
    async ({ url, body }) => {
      const res = await fetch(url, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      const json = (await res.json().catch(() => ({}))) as unknown;
      return { status: res.status, body: json };
    },
    { url: `${API_BASE_URL}${path}`, body: payload },
  );
}

test("oauth consent, broker refresh, and compiled-agent token delivery", async ({
  page,
}) => {
  // A prior run (E2E_REUSE) may have left the AS rejecting grants.
  await setAsMode("ok");
  // The stub's logs survive an E2E_REUSE stack, so every count below is read
  // as a DELTA from here — an absolute zero would be a previous run's ghost.
  const requestsAtStart = (await stubCalls()).oauthRequests.length;
  const oauthRequests = async (): Promise<OauthRequest[]> =>
    (await stubCalls()).oauthRequests.slice(requestsAtStart);

  const { orgId } = await signUpIntoWorkspace(page, "oauth");

  // ── 1. create the OAuth connection on the protected stub endpoint ──────────
  const created = await apiPost(page, `/workspaces/${orgId}/connections`, {
    source: "custom",
    name: CONNECTION,
    url: STUB_OAUTH_MCP_URL,
    auth: { type: "oauth" },
  });
  expect(created.status).toBe(201);
  const createdBody = created.body as {
    connection: {
      id: string;
      oauthStatus: string | null;
      health: string;
      hasCredentials: boolean;
    };
    oauthStartPath?: string;
  };
  const connectionId = createdBody.connection.id;
  expect(connectionId).toMatch(/^cn_[0-9a-z]{16}$/);
  expect(createdBody.connection.oauthStatus).toBe("pending");
  // Born WITHOUT a grant: the honest state is "we hold no credential", not
  // "yours was rejected" (fix plan F10). Both halves matter — the health the
  // create states, and the `hasCredentials` that used to be hardcoded true
  // for every oauth row and is what disguised one as the other.
  expect(createdBody.connection.health).toBe("auth_required");
  expect(createdBody.connection.hasCredentials).toBe(false);
  expect(createdBody.oauthStartPath).toBe(
    `/workspaces/${orgId}/connections/${connectionId}/oauth/start`,
  );

  // ── 2. detail shows the pending grant; Connect runs the popup consent ──────
  await gotoSection(page, "Context");
  const card = page.getByRole("button", { name: `${CONNECTION} details` });
  await expect(card).toBeVisible();
  await card.click();
  const detail = page.getByRole("dialog", { name: CONNECTION });
  await expect(detail).toBeVisible();
  await expect(detail.getByText(/Not connected yet/)).toBeVisible();

  // Nothing has checked this row and nothing will on its own: the detail's
  // stale re-probe is suppressed while the grant is un-consented, so the
  // panel reads the state the create already stated.
  await expect(detail.getByText("Auth required", { exact: true })).toBeVisible();
  await expect(detail.getByText("Never checked", { exact: true })).toBeVisible();

  // Ask anyway — "Test connection" is still offered, and it must land
  // `auth_required` WITHOUT DIALLING. An un-consented grant cannot produce a
  // token, and asking the server about a credential we do not hold can only
  // collect its entirely correct 401: that is how a brand-new install came to
  // read "http 401" before anyone had clicked Connect (F1/F10). The timestamp
  // flipping is what makes the request-count assertion below non-vacuous.
  const preConsentProbe = page.waitForResponse(
    (res) => res.request().method() === "POST" && res.url().includes("/probe"),
  );
  await detail.getByRole("button", { name: "Test connection" }).click();
  const preConsentResponse = await preConsentProbe;
  expect(preConsentResponse.status()).toBe(200);
  expect(
    ((await preConsentResponse.json()) as { connection: { health: string } })
      .connection.health,
  ).toBe("auth_required");
  await expect(detail.getByText(/^Checked (just now|\dm ago)$/)).toBeVisible();
  expect(await oauthRequests()).toHaveLength(0);

  const statsBeforeConsent = await asStats();
  const popupPromise = page.waitForEvent("popup");
  // exact: "Test connection" / "Remove connection" substring-match "Connect".
  await detail.getByRole("button", { name: "Connect", exact: true }).click();
  const popup = await popupPromise;

  // The popup lands on the stub AS's interstitial once the start route has
  // run discovery + DCR and armed the PKCE flow. Approving 302s through the
  // session-bound callback, which posts to the opener and closes itself.
  await popup.getByRole("button", { name: "Approve" }).click();
  await expect.poll(() => popup.isClosed(), { timeout: 15_000 }).toBe(true);

  // The grant is live: the auth panel flips to the Connected shield.
  await expect(detail.getByText("Connected", { exact: true })).toBeVisible({
    timeout: 15_000,
  });
  const statsAfterConsent = await asStats();
  expect(statsAfterConsent.authorizationCodeGrants).toBe(
    statsBeforeConsent.authorizationCodeGrants + 1,
  );
  // localhost base URL ⇒ CIMD unusable ⇒ the broker registered via DCR.
  expect(statsAfterConsent.registrations).toBeGreaterThanOrEqual(1);

  // ── 3. the post-connect probe carries the broker's token ───────────────────
  // Health can only reach `ok` here if the probe presented a bearer the stub
  // AS accepts: the fixture refuses an unauthenticated handshake exactly like
  // every real OAuth MCP server. Before the fix the same badge went green
  // against a fixture that answered `initialize`/`tools/list` to anyone.
  await detail.getByRole("button", { name: "Close" }).click();
  await expect(detail).toBeHidden();
  await expect(async () => {
    await page.reload();
    await expect(card).toBeVisible({ timeout: 4_000 });
    await expect(card.getByTitle("Healthy")).toBeVisible({ timeout: 4_000 });
    await expect(card.getByText("1 tool", { exact: true })).toBeVisible({
      timeout: 1_000,
    });
  }).toPass({ timeout: 60_000 });

  const afterProbe = await oauthRequests();
  expect(authenticatedDials(afterProbe, "initialize")).toBeGreaterThanOrEqual(1);
  expect(authenticatedDials(afterProbe, "tools/list")).toBeGreaterThanOrEqual(1);
  // Every rpc the stub saw carried a live bearer. The only unauthenticated
  // request in the log is discovery's bodyless GET — the 401 whose challenge
  // pointed the broker at the PRM in the first place.
  expect(
    afterProbe
      .filter((request) => request.rpcMethod !== "?" && !request.authValid)
      .map((request) => request.rpcMethod),
  ).toEqual([]);
  expect(
    afterProbe.some(
      (request) => request.httpMethod === "GET" && !request.authValid,
    ),
  ).toBe(true);
  // And the token came through the central lifecycle rather than from
  // anywhere else: the stub AS issues 30 s tokens, inside the broker's 60 s
  // expiry margin, so the probe's read had to REFRESH and the AS counted the
  // grant. The baseline is pre-consent, because consent itself spends an
  // `authorization_code` grant and the post-callback probe is fire-and-forget
  // — it can easily have refreshed before the panel finished flipping.
  const statsAfterProbe = await asStats();
  expect(statsAfterProbe.refreshTokenGrants).toBeGreaterThan(
    statsBeforeConsent.refreshTokenGrants,
  );

  // Tool discovery on an OAuth connection — new ground, not a restatement of
  // the badge: `tools_cache` is written ONLY on a healthy probe, so before
  // this fix no OAuth connection anywhere could fill the picker, the per-tool
  // approvals, the version tool directory, or the copilot inventory.
  await card.click();
  await expect(detail).toBeVisible();
  await detail.getByRole("button", { name: /^allow$/i }).click();
  await expect(detail.getByRole("checkbox", { name: STUB_TOOL })).toBeVisible();
  // Leave the filter as it was found — the published agent should see the
  // connection's full tool set, exactly as the other specs do.
  await detail.getByRole("button", { name: "All tools" }).click();
  await detail.getByRole("button", { name: "Close" }).click();
  await expect(detail).toBeHidden();

  // ── 4. attach → publish (real eve build with oauth getToken codegen) ───────
  await openNewAgent(page, AGENT_NAME);
  await writePersona(
    page,
    "You keep the user's secure notes; use your tools when asked.",
  );
  await attachAgentResource(page, "connection", CONNECTION);
  await publishAgentAndWaitReady(page);

  // ── 5. chat: discovery turn, then the broker-delivered tool call ───────────
  // Connection tools ride eve's `connection_search` dynamic tool on 0.31; a
  // turn settles when its working block collapses to a "Worked for" summary.
  const workedSummaries = page.getByText(/Worked for \d+s/);
  const composer = page.getByRole("textbox", { name: "Message" });
  async function sendChatTurn(message: string, turn: number): Promise<void> {
    // fill() waits for editability — the composer is read-only mid-run.
    await composer.fill(message);
    await page.getByRole("button", { name: "Send message" }).click();
    await expect(workedSummaries).toHaveCount(turn, { timeout: RUN_TIMEOUT_MS });
  }

  await startChatAndSend(
    page,
    AGENT_NAME,
    `Call the connection_search tool with connection "${CONNECTION}" and keywords "save note".`,
  );
  await expect(workedSummaries).toHaveCount(1, { timeout: RUN_TIMEOUT_MS });

  // Discovery already exercised the token chain: the connection dial's
  // tools/list carried a broker-delivered bearer the stub AS validated. The
  // baseline is the PROBE's own authenticated list (step 3) — the agent has
  // to add one of its own, so a healthy probe can never satisfy this.
  await expect
    .poll(async () => authenticatedDials(await oauthRequests(), "tools/list"), {
      timeout: 30_000,
    })
    .toBeGreaterThan(authenticatedDials(afterProbe, "tools/list"));

  // The tool call: getToken → /internal/connections/token → central refresh
  // (30 s tokens are always inside both 60 s margins) → introspected bearer.
  const statsBeforeFirstCall = await asStats();
  const callsAtStart = (await stubCalls()).oauthCalls.length;
  await sendChatTurn(
    `Call the ${CONNECTION}__save_note tool with note "oauth-run-one".`,
    2,
  );
  await expect
    .poll(async () => (await stubCalls()).oauthCalls.length, { timeout: 30_000 })
    .toBe(callsAtStart + 1);
  const afterFirstCall = await stubCalls();
  expect(
    afterFirstCall.oauthRequests.some(
      (r) => r.rpcMethod === "tools/call" && r.authValid,
    ),
  ).toBe(true);
  const statsAfterFirstCall = await asStats();
  expect(statsAfterFirstCall.refreshTokenGrants).toBeGreaterThan(
    statsBeforeFirstCall.refreshTokenGrants,
  );

  // ── 6. force-expire every outstanding token → the next call still works ────
  const expired = await fetch(`${STUB_AS_URL}/__expire`, { method: "POST" });
  expect(expired.ok).toBe(true);

  const statsBeforeSecondCall = await asStats();
  await sendChatTurn(
    `Call the ${CONNECTION}__save_note tool with note "oauth-run-two".`,
    3,
  );
  await expect
    .poll(async () => (await stubCalls()).oauthCalls.length, { timeout: 30_000 })
    .toBe(callsAtStart + 2);
  // Every pre-expire token is introspection-dead, so this success is only
  // explainable by a fresh central refresh — and the AS counted it.
  const statsAfterSecondCall = await asStats();
  expect(statsAfterSecondCall.refreshTokenGrants).toBeGreaterThan(
    statsBeforeSecondCall.refreshTokenGrants,
  );

  // ── 7. invalid_grant: failed tool call (not a hang) + Reconnect ────────────
  await setAsMode("invalid_grant");
  await sendChatTurn(
    `Call the ${CONNECTION}__save_note tool with note "oauth-run-three".`,
    4,
  );
  // The emitted lib throws on the broker's 409, eve records a failed
  // action.result, and the turn runs to a normal finish — the error text is
  // the only auth signal on the wire (spike finding 34).
  await expect(
    page.getByText(/connection needs re-authorization/).first(),
  ).toBeVisible({ timeout: RUN_TIMEOUT_MS });
  expect((await stubCalls()).oauthCalls.length).toBe(callsAtStart + 2);

  // The dead grant surfaced on the connection: health auth_error on the
  // card, and the detail explains the expiry + offers Reconnect.
  await gotoSection(page, "Context");
  await expect(async () => {
    await page.reload();
    await expect(card).toBeVisible({ timeout: 4_000 });
    await expect(card.getByTitle("Auth error")).toBeVisible({ timeout: 4_000 });
  }).toPass({ timeout: 30_000 });
  await card.click();
  await expect(detail.getByText(/Authorization expired/)).toBeVisible();
  await expect(
    detail.getByRole("button", { name: "Reconnect", exact: true }),
  ).toBeVisible();

  // Leave the AS usable for any later consumer of the shared stub.
  await setAsMode("ok");
});
