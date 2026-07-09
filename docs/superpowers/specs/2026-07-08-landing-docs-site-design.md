# Landing page + docs site (`apps/site`) — design

**Date:** 2026-07-08 · **Status:** approved · **Scope:** new workspace app `apps/site` (static, GitHub Pages) + `packages/design-tokens` extraction

## Context

invisible-string has no public face: `/` in the SPA redirects straight to
`/chat` → `/login`, `index.html` has no meta tags, and there's no favicon, OG
image, or marketing copy anywhere. The goal is a design-studio-quality landing
page that inherits the app's E1 design system (monochrome ink × liquid glass)
with beautiful animations and extreme polish, plus an E1-styled docs site
(placeholder content for now) linked from it.

## Decisions settled

- New workspace app `apps/site` (landing at `/`, docs at `/docs/*`) — the SPA
  stays untouched at its own origin.
- Custom E1 docs shell in the same Vite app, content as MDX (no
  Starlight/VitePress).
- Deploy: **GitHub Pages via GitHub Actions** (static — no Docker image, no
  prod-compose service, no nginx changes).
- Animations: **framer-motion** (the `motion` package, v12 line), scoped to
  `apps/site` only.

**Technical shape** (implementation, not design — see `apps/site/README.md`
and `AGENTS.md` for the operative contract): the E1 tokens live in
`packages/design-tokens/tokens.css`, imported by both `apps/web` and
`apps/site`; the site is a second Vite + React + TanStack Router app with an
MDX docs pipeline (`@mdx-js/rollup`), built and deployed to GitHub Pages by
`.github/workflows/site.yml`, decoupled entirely from the platform's
compose-based CI and production deploy.

---

## Part 1 — Creative design

### Brand concept: "the string becomes visible"

The repo has no written rationale for the name and no thread metaphor in the
UI. The landing page **introduces** the metaphor: a **1px hairline ink
thread** (SVG path, `pathLength` linked to scroll progress) draws itself down
the page, tying every section together — trigger → context → agent →
instructions → compiled agent → durable run. It's perfectly on-system
(hairlines are already E1 vocabulary) and it ends by **drawing the spool
logomark** in the footer — the string ties the knot.

The brand mark is a **spool of thread** (Lucide `spool` paths, filled +
round-stroked solid silhouette — see `apps/web/src/components/LogoMark.tsx`),
which strengthens the concept directly: the hairline thread literally
**unwinds from the spool** in the hero and **winds back into it** in the
footer. Everywhere below that says "triangle logomark" in earlier drafts, read
"spool" — the favicon is the spool too.

Everything monochrome ink over the warm wash; color appears **only as
meaning** (green ✓ running/succeeded, amber ⏸ parked, red error) — which
doubles as the animation's legibility system.

### Page structure (single landing page, top to bottom)

1. **Nav** — horizontal glass dock (capsule, `blur(28px)`, raised shadow — the
   app's `.glass-dock` rotated horizontal), fixed top-center. Spool logomark +
   wordmark, links: Product · How it works · Docs · GitHub. Ink capsule CTA
   "Open the app" (shown only when `VITE_APP_URL` is set). Tightens subtly on
   scroll.
2. **Hero** — oversized display type (system SF stack, weight 650–700,
   tighter tracking at display size via the site's own scale in `apps/site/src/styles/site.css`).
   Headline: **"Agent workflows, compiled."** Subline (repo's own copy):
   *"Describe a workflow in four pillars. It compiles into a real,
   self-hosted agent on a durable worker pool — fired from chat, webhooks,
   forms, or Slack."* CTAs: ink capsule **Read the docs** → `/docs`, ghost
   **View on GitHub**. Entrance: staggered line-rise with a subtle
   blur-to-sharp "ink settles" effect.
   **Hero centerpiece:** an animated product vignette hand-built from E1
   primitives (not screenshots — vector-sharp, animatable): a glass builder
   window where the four pillar cards fill in one by one (StatusChips flip to
   ✓), "Publish" presses itself → "Published and built." → a chat panel
   streams a working block that folds to *"Worked for 6s · 4 steps"*. Runs as
   a slow autonomous loop. The thread begins beneath it, unwinding from the
   spool mark in the nav.
3. **Four pillars** — "Four pillars. One workflow." The thread weaves through
   four glass cards (⚡ Trigger · 🧩 Context · 🤖 Agent · 📝 Instructions —
   lucide `Zap/Plug/Bot/FileText`, matching the app), each a miniature of the
   app's real pillar card with its real one-liner copy. Staggered rise-in on
   scroll; `.lift` on hover.
4. **Compile** — "Publish builds a real agent." Monospace glass terminal
   panel with a type-on build sequence (compile → `eve build` → tarball →
   content hash), ending in the app's real microcopy *"Published and built."*
   with a green status dot. The thread exits as a version chip
   (`ws_v_a1b2c3`). Copy angle: not orchestration glue — an actual standalone,
   version-pinned agent artifact.
5. **Durability theater** — "Kill a worker mid-run. The run survives."
   Scroll-triggered sequence: run streams on worker A (pulsing dot) → worker A
   dies (card desaturates, chip flips amber "parked") → the thread reroutes to
   worker B → stream resumes → green ✓. Dramatizes Postgres-backed durability
   / any-worker resume, the platform's hardest-won feature.
6. **Triggers** — "Fired from anywhere." Five capsule chips (Chat · Webhook ·
   Form · Slack · Schedule) emitting pulses that travel along hairlines into
   a workflow node; sublabels reuse the trigger editor's real microcopy.
7. **Copilot** — "A copilot in the builder." Chat vignette: user asks for a
   Slack trigger; copilot replies with a typed-mutation card (`setTrigger ·
   slack`) with Apply/Dismiss capsules; Apply presses itself; the pillar card
   flashes (the app's real `pillar-flash` keyframe).
8. **Feature grid** — six compact glass cards: Workspaces & SSO ·
   Envelope-encrypted secrets (AES-256-GCM) · Version pinning (sessions keep
   their compiled agent) · Human-in-the-loop (approvals park runs durably) ·
   Model presets (powerful / balanced / quick + allowlist) · Self-hostable
   (one compose stack).
9. **Final CTA band + footer** — "Assemble. Compile. Run." big glass panel
   with docs CTA; the thread's terminus draws the spool logomark back
   together; hairline footer with links.

### Motion principles (hold implementation to these)

- One easing everywhere: `cubic-bezier(0.22, 0.61, 0.36, 1)`.
  Micro-interactions 150ms; entrances 240–400ms (landing scale); vignette
  loops slow and calm.
- Scroll-linked: thread `pathLength` via `useScroll` + `motion.path`; wash
  blobs get gentle parallax. Entrances via `whileInView` + `viewport={{ once:
  true }}`, stagger 60–80ms.
- Transform/opacity only (never animate blur/backdrop-filter);
  `MotionConfig reducedMotion="user"` + tokens.css's global reduced-motion
  clamp; vignettes render their final state statically under reduced motion.
- Ship the E1 fallbacks verbatim: no-`backdrop-filter` → solid `#f7f7f7`,
  `prefers-reduced-transparency` kills blur + blobs.

### Docs shell (`/docs`)

- Layout: left glass sidebar (sections/order from MDX frontmatter) · frosted
  content panel with hand-written E1 prose styles (`.doc-prose`: headings
  650/-0.02em, hairline rules, mono inline-code chips on `bg-black/[0.04]`) ·
  right "On this page" TOC rail (from rendered heading ids). Prev/next
  pagination from sidebar order. Sidebar collapses to a drawer on mobile. No
  search yet (a dead search box is worse than none — future work).
- Placeholder content: ~12 MDX stubs matching the repo's natural IA —
  **Getting started** (Overview, Quickstart, Deploy your own) · **Concepts**
  (The four pillars, Workflows & versions, Sessions & runs, Workspaces) ·
  **Building** (The builder, Copilot, Triggers, Context & MCP, Models) ·
  **Platform** (Architecture, Durability, Security). Each: real title + 1–2
  real intro paragraphs (vocabulary already exists in README/spec) + a
  designed EmptyState-style "under construction" block — never a blank page.

### Assets

`public/favicon.svg` (the spool mark), `public/og.png` (1200×630, wash +
wordmark; authored as SVG, converted once, PNG committed), full SEO/OG
`<head>` in `index.html`.

---

## Superseded: messaging pivot (2026-07-09)

The **copy and section arc** below are superseded by the messaging pivot
(`docs/superpowers/specs/…` sibling / plan `can-we-build-a-lovely-stream.md`).
The E1 design system, animation machinery, thread metaphor, and docs shell
described above are **unchanged** — this was a messaging pivot, not a visual
redesign. What changed:

- **Aim**: every landing section now sells the *user outcome* (describe work in
  plain language → it runs from where you work → you stay in control), not the
  backend machinery (eve build / compile / worker pool / Postgres), which now
  lives only in the docs and one sanctioned "Under the hood → architecture"
  pointer strip beneath the control grid.
- **Headline**: "Agent workflows, compiled." → **"Describe the work, consider
  it done."** Tagline "Assemble. Compile. Run." → **"Describe. Publish. Done."**
- **Section order** (`src/routes/index.tsx`): Hero → **Use cases** (new
  `UseCases.tsx`, replaces `Compile.tsx`, wraps `id="product"`) → Pillars →
  Copilot → Triggers → Reliability (`Durability.tsx`) under `id="how"` →
  Control grid (`FeatureGrid.tsx`) → FinalCTA. Nav label "Product" → "Use
  cases"; hash ids unchanged.
- **Copy source of truth** is now the landing components themselves (all copy
  inline, no shared constants) — read those files, not this spec's Part 1
  copy, for current strings.
