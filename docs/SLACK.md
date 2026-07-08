# Slack integration — platform app setup

How to create, wire up, and operate the **single platform-level Slack app**
(spec §2 locked: one app for the whole deployment, not per-workspace apps).
Slack workspaces connect to it via OAuth from Settings → Integrations; every
team's events arrive at one shared endpoint and are routed internally by
`team_id`.

The app is defined by a checked-in manifest:
[`infra/slack/manifest.template.json`](../infra/slack/manifest.template.json).
A drift test (`apps/control-plane/src/integrations/manifest.test.ts`) pins the
manifest to the code — scopes to `DEFAULT_SLACK_BOT_SCOPES`, event
subscriptions to the scopes, request/redirect URLs to the routes the control
plane actually serves. If you change any of those, the test tells you what to
update.

---

## 1. Create the app from the manifest

Render the manifest with your deployment's public origin substituted in:

```sh
bun run slack:manifest --url https://app.example.com | pbcopy
# or, with PUBLIC_APP_URL (or BETTER_AUTH_URL) already in .env:
bun run slack:manifest | pbcopy
```

Then at [api.slack.com/apps](https://api.slack.com/apps): **Create New App →
From a manifest** → pick the workspace that will own the app → paste the JSON
→ confirm. The name/description/colors under `display_information` are
cosmetic — rebrand freely; everything else is contractual.

What the manifest declares, and why:

| Manifest field | Value | Bound to |
|---|---|---|
| `settings.event_subscriptions.request_url` | `<origin>/integrations/slack/events` | The one shared events ingress (`apps/control-plane/src/integrations/routes.ts`); events route internally by `team_id` |
| `oauth_config.redirect_urls` | `<origin>/integrations/slack/callback` | `slackRedirectUri()` — the OAuth v2 callback |
| `oauth_config.scopes.bot` | `app_mentions:read chat:write im:history im:read channels:history groups:history` | `DEFAULT_SLACK_BOT_SCOPES` (`integrations/config.ts`) |
| `settings.event_subscriptions.bot_events` | `app_mention`, `message.channels`, `message.groups`, `message.im` | Exactly the events those scopes permit — Slack rejects a manifest subscribing to `message.<surface>` without `<surface>:history` |
| `socket_mode_enabled` / `interactivity` / `token_rotation_enabled` | all `false` | Events arrive over HTTP; no interactivity handler exists; stored bot tokens are static (rotation would break decrypt-at-dispatch) |

## 2. Wire the credentials

From the app's **Basic Information → App Credentials**, copy into the
control-plane environment (`.env` in dev; `.env.prod` values per
[DEPLOY.md](DEPLOY.md) §3 in prod — the prod compose forwards them):

```sh
SLACK_CLIENT_ID=…
SLACK_CLIENT_SECRET=…
SLACK_SIGNING_SECRET=…
```

All three or none: the Slack config only activates when every var is present
(`loadIntegrationsConfig`); otherwise the Slack endpoints answer
`503 integration_not_configured` while webhook/form ingress keeps working.
Restart the control plane after setting them.

## 3. Verify the events URL

Slack marks the Request URL **unverified** when the app is created from a
manifest — the app didn't exist yet when you booted the control plane, so the
verification handshake couldn't have succeeded. After step 2 (secret live,
control plane restarted), open **Event Subscriptions** in the app config and
hit **Retry**. Order matters: the ingress checks the request signature
*before* answering `url_verification`, so verification fails until the
running control plane has the signing secret.

## 4. Enable distribution (multi-workspace deployments)

By default a Slack app can only be installed to the workspace that owns it.
If other Slack workspaces will connect, open **Manage Distribution** in the
app config and activate public distribution. Installs still flow exclusively
through the platform's own install route (Settings → Integrations → Connect)
— never share the raw `oauth/v2/authorize` link; the callback requires a
signed-in **admin/owner** session of the workspace named in the signed,
single-use OAuth `state`.

## 5. Connect a workspace

In the SPA: **Settings → Integrations → Connect** (admin/owner only). That
kicks off OAuth (`GET /workspaces/:id/integrations/slack/install`), and the
callback stores the bot token AES-256-GCM-encrypted per Slack team
(`integrations` table, AAD-bound to the `team_id`). One Slack team can be
connected to exactly one workspace — reconnecting the same team from a
different workspace is rejected.

## 6. Bind a trigger

In the builder, set the workflow's TRIGGER pillar to **Slack** and pick the
connected integration. The binding offers:

- `channelId` — restrict to one channel (empty = any channel the bot is in);
- `mentionOnly` (default **true**) — only `@mentions` start new runs; thread
  replies always continue the run's session either way;
- `includeDirectMessages` (default **false**) — DMs to the bot start runs.

The bot only receives events from channels it's a **member** of — `/invite
@YourBot` in each channel that should fire the trigger. Replies post back to
the originating thread via `chat.postMessage` with the per-team bot token,
which the dispatcher injects into the compiled agent as `SLACK_BOT_TOKEN`.

## Local development

Slack must reach the events URL over public HTTPS, so local ingress needs a
tunnel (`cloudflared tunnel --url http://localhost:3000`, ngrok, …). Set
`PUBLIC_APP_URL` to the tunnel origin, re-render the manifest, and update the
app config (api.slack.com/apps → your app → **App Manifest** accepts a full
re-paste). Tests never need any of this: the suites stub the Slack Web API
via `SLACK_API_BASE_URL`/`SLACK_AUTHORIZE_URL` and sign synthetic events with
a test secret (`ingress.test.ts`).

## Changing scopes or events

`SLACK_BOT_SCOPES` overrides the requested install scopes, but the app config
in Slack must grant whatever is requested — keep the manifest template, the
code default, and any env override aligned (the drift test enforces the first
two). Adding an event class (e.g. group DMs: `message.mpim` + `mpim:history`)
means: update `DEFAULT_SLACK_BOT_SCOPES`, update the manifest template
(the drift test derives the required `bot_events` for you), re-paste the
manifest into the app config, and **reconnect each workspace** so the new
scopes land on their tokens.

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `503 integration_not_configured` on Slack endpoints | One of the three `SLACK_*` vars missing — set all three, restart |
| Request URL verification fails | Signing secret not live in the running control plane (step 3 order), or the origin isn't publicly reachable |
| `401` on events | Wrong `SLACK_SIGNING_SECRET`, a proxy mutating the raw body (signature is over exact bytes), or timestamp outside the 5-minute replay window (check host clock) |
| Mentions don't fire runs | Bot not invited to the channel; trigger disabled; `channelId` set to a different channel; workspace not connected |
| DMs don't fire runs | `includeDirectMessages` is off by default — enable it on the binding |
| Duplicate deliveries | Handled: Slack retries are acknowledged and deduped by `event_id`; an @mention's `app_mention`/`message` twin is suppressed |
