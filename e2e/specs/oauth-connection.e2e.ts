/**
 * THE FULL OAUTH SPINE (connectors redesign spec §6, plan-3 Task 11) against
 * the real stack — every hop of the broker chain, end to end:
 *
 *   1. CREATE a custom connection on the stub's OAuth-protected endpoint
 *      (`/mcp-oauth`) with `auth:{type:"oauth"}` → row + pending grant. The
 *      custom-URL dialog has no OAuth lane (catalog recipes own the UI entry
 *      point), so the create rides the same unified `POST /connections` the
 *      dialog posts, from the browser session; everything after is UI.
 *   2. CONNECT from the detail panel: the popup runs the control plane's REAL
 *      discovery (401 → `WWW-Authenticate` PRM pointer → stub AS metadata) →
 *      DCR (localhost base URL is never CIMD-usable) → PKCE consent on the
 *      stub AS's interstitial (Playwright clicks Approve) → callback page
 *      closes the popup → the panel flips to Connected and the post-connect
 *      probe lands `ok` with the discovered tool.
 *   3. ATTACH → PUBLISH (real eve build: oauth codegen emits `getToken` via
 *      the platform token broker) → CHAT. Connection tools are not advertised
 *      directly on eve 0.31 — the mock-model choreography is a
 *      `connection_search` discovery turn, then explicit
 *      `<slug>__save_note` turns (spike finding 34).
 *   4. The tool call proves the DELIVERY CHAIN: the compiled agent's
 *      `getToken` self-mints a version-bound platform JWT, hits
 *      `POST /internal/connections/token`, the broker refreshes centrally
 *      (the stub AS issues 30 s tokens — below both 60 s expiry margins, so
 *      every read refreshes), and the stub MCP server's `tools/call` accepts
 *      only a bearer the stub AS says is active (introspection).
 *   5. `POST /__expire` force-expires every outstanding access token — the
 *      next tool call STILL succeeds, which only a freshly-refreshed token
 *      can explain (the AS's refresh-grant counter increments again).
 *   6. The AS flips to `invalid_grant`: the broker lands the grant `expired`
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
  oauthRequests: { rpcMethod: string; authValid: boolean }[];
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
    connection: { id: string; oauthStatus: string | null };
    oauthStartPath?: string;
  };
  const connectionId = createdBody.connection.id;
  expect(connectionId).toMatch(/^cn_[0-9a-z]{16}$/);
  expect(createdBody.connection.oauthStatus).toBe("pending");
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

  // ── 3. post-connect probe lands ok with the discovered tool ────────────────
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
  // tools/list carried a broker-delivered bearer the stub AS validated.
  await expect
    .poll(
      async () =>
        (await stubCalls()).oauthRequests.filter(
          (r) => r.rpcMethod === "tools/list" && r.authValid,
        ).length,
      { timeout: 30_000 },
    )
    .toBeGreaterThanOrEqual(1);

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
