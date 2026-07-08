# Screenshots

Real product captures of the web app (`apps/web`), taken from the live E2E
stack by `e2e/specs/screenshots.e2e.ts` — never hand-cropped mockups. Each
shot is a full 1600×1000 window at deviceScaleFactor 2 (3200×2000 retina
PNGs), light theme, and the spec asserts the photographed state actually
rendered before capturing it.

| File | What it shows |
|---|---|
| `onboarding.png` | The first-run **"Create your workspace"** glass card over the wash background, name already filled in — plus the invite-link hint ("Have an invite link? Open it to join an existing workspace instead.") and the "Wrong account? Sign out" escape, shown before any workspace exists. |
| `invite.png` | The invite **confirm panel** at `/accept-invitation/:id`: the workspace name in the "Join <workspace>" heading, the inviter's email as the subtitle, the invited role as a chip ("member"), and the Decline/Accept invitation controls — captured for a pending invite that is never accepted. |
| `chat.png` | A chat session with a **completed run**: the collapsed working block ("Worked for Ns · N steps"), the streamed assistant reply below it, and the session list on the left with the session's status dot. |
| `builder.png` | `/workflows/:id` with **all four pillar cards populated** — Form trigger (2 fields), Context (two connections + a skill), Agent (preset + resolved model chain), Instructions ("N lines · N @refs") — and the instructions editor focused in the center with resolved `@notes` / `@trigger.email` reference chips. |
| `copilot.png` | The builder with the **copilot rail open** mid-conversation: two applied suggestion receipts and one **un-applied** "Write instructions" card showing the inline instructions **diff preview** with its Apply/Dismiss controls, while the pillar rail reflects the already-applied trigger and connection. |
| `context.png` | `/context` with two MCP connection cards (one custom-URL, one registry-installed) and one authored skill (with an attachment count). |
| `settings.png` | `/settings` → **Models**: the three model-preset rows (Powerful / Balanced / Quick), each with its provider · model chip and repoint selects. The model **allowlist table** lives on the adjacent `/settings/allowlist` sub-route, visible in the settings nav. |

## Regenerating

The capture spec rides the self-managing Playwright harness (see
`e2e/README.md` — Docker, `mise`, and an installed Chromium are the only
prerequisites) and is env-gated so the normal E2E suite never runs it:

```bash
cd e2e && SCREENSHOTS=1 bunx playwright test screenshots --project=acceptance
```

That one command brings the full stack up (compose project `p2e2e`), signs up
a fresh workspace through first-run onboarding, sends and views a pending
invite from a second browser context, authors the skill/connections, builds +
publishes a workflow (real `eve build`), runs it from chat, drives the
scripted copilot, walks the seven routes, and tears everything down. Add
`E2E_REUSE=1` to keep the stack alive between iterations.

## Keep these current

Per the AGENTS.md documentation directive ("keep all documentation up to
date" — stale docs are bugs), **any UI change that visibly affects one of
these surfaces must regenerate the affected screenshots in the same PR** with
the command above. The spec fails rather than capturing a blank or half-loaded
pane, so a green run is the freshness check.
