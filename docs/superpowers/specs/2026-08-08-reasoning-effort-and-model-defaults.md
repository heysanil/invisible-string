# Reasoning effort + new model defaults — approved design

**Date:** 2026-08-08
**Branch:** `feat/new-default-models`
**Status:** approved, implemented

---

## 1. Context

Two changes to the MODEL layer that turned out to be one change.

**New seed defaults.** The three workspace presets move to:

| Preset | Provider | Model | Effort | Context window |
|---|---|---|---|---|
| `powerful` | openrouter | `moonshotai/kimi-k3` | `max` | 1,048,576 |
| `balanced` | openrouter | `~deepseek/deepseek-v4-flash-latest` | `max` | 1,048,576 |
| `quick` | openrouter | `~deepseek/deepseek-v4-flash-latest` | `low` | 1,048,576 |

`balanced` and `quick` are **the same model at different efforts**. That is the
forcing constraint of the whole change: a preset used to be `(provider,
modelId)`, so those two tiers would have been byte-identical — same resolution,
same content hash, same artifact. **The effort has to be part of the preset.**

**Reasoning controls.** Effort existed only on the agent
(`low | medium | high`, schema-defaulted to `medium`), offered as a fixed
three-item list. Verifying that against the live OpenRouter catalog and the
pinned provider source found three defects:

1. **The effort was silently discarded on OpenRouter** — every agent's
   selection was a no-op, and all seeded presets are OpenRouter (§4).
2. **The vocabulary was wrong and model-specific.** OpenRouter publishes a
   per-model `reasoning.supported_efforts`; 269 of 400 catalog models carry
   one, across 21 distinct sets drawn from
   `none, minimal, low, medium, high, xhigh, max`. All three new models
   advertise exactly `[max, high, low]` — **none of them supports `medium`**,
   which was the platform default.
3. **`~deepseek/deepseek-v4-flash-latest` could not even be allowlisted.** The
   leading `~` is part of the id (OpenRouter's convention for its `-latest`
   floating aliases) and `modelIdShapeProblem` rejected it.

**Outcome:** presets carry an effort; agents inherit it and may override;
the selectors are populated from the live catalog; and the effort actually
reaches the wire.

## 2. Supersessions

This document **supersedes `INITIAL-SPEC.md` §2 and §7** on the model layer.
INITIAL-SPEC.md is a historical record and is deliberately **not edited** — read
the supersessions here:

| INITIAL-SPEC.md | Superseded by |
|---|---|
| §2 + §7 — *seed defaults powerful → `z-ai/glm-5.2`, balanced → `deepseek/deepseek-v4-pro`, quick → `deepseek/deepseek-v4-flash`* | the table in §1. §16's "previously open questions — do not re-ask" item 1, which locks those ids, is retired with it. |
| §2 + §7 — *"Each is a workspace-editable mapping `preset → { provider, modelId }`"* | `preset → { provider, modelId, reasoning }` — the effort is part of the mapping (§3). |
| §7 — the generated `agent/agent.ts` example's `reasoning: "medium"` | the effort is resolved at publish (§6) and, on OpenRouter, emitted as `extraBody` on the **model**, never as eve's `reasoning:` config (§4). The example's `openrouter.chat(...)` call style is separately superseded by spike REPORT finding 21. |
| §7 — *"Seed each workspace's allowlist with these three"* | two ids, not three: `balanced` and `quick` share a model. |
| §7 — resolution order *`agent.model_id override → workspace preset mapping → provider+modelId`* | unchanged for the model; the effort resolves alongside it, and the override branch falls to `provider-default` rather than the preset's effort (§3). |
| §9 — *`agents` … reasoning effort* | still stored on the agent, now **optional**: absent = inherit. |

Everything else in §7 stands unchanged and is load-bearing: the two providers,
platform-owned keys, compile-time allowlist rejection, and **dispatch-time
re-validation**.

Secondary: the seed sentence under "Data model" in
`docs/superpowers/specs/2026-07-02-invisible-string-design.md` names the old ids
for the same reason and is superseded identically. The 2026-07-10
agents-first spec's `model: {preset, modelId?, reasoning}` shape survives with
`reasoning` now **optional**.

## 3. Decisions

**A preset is `(provider, modelId, reasoning)`.** `model_presets.reasoning` is a
real NOT NULL column, not a definition-only value, so two tiers can share a
model.

**Precedence — preset default + optional agent override.**
`agentModelSchema.reasoning` becomes `.optional()`, `undefined` = *inherit*.
Deliberately **no `.default()`**: a default materializes an explicit effort on
every parse and permanently erases the inherit signal.

```
definition.model.reasoning ?? (modelId override ? "provider-default" : preset.reasoning)
```

**A specific-model override with no explicit effort resolves to
`provider-default`, not the preset's effort.** Inheriting `balanced`'s `max`
onto a deliberately-chosen cheap model is the wrong semantic; and the override
branch of `resolveModel` returns *before* the preset lookup, so reading the
preset there would invent a new `model_preset_not_found` failure for override
drafts that publish fine today.

**Vocabulary — eight values**, mirrored by pgEnum `reasoning_effort`,
`reasoningEffortSchema`, and `REASONING_LABEL`/`REASONING_ORDER` in the web app:

```
provider-default | none | minimal | low | medium | high | xhigh | max
```

- Seven of them are OpenRouter's own. No model supports all seven — the UI
  filters against the live catalog (§5).
- **`provider-default` is the platform's own eighth value** (the name is
  borrowed from the AI SDK's `CallSettings["reasoning"]` union). It means
  *omit the reasoning field from the request entirely*, and it is **distinct
  from `none`**, which explicitly disables reasoning on a model that has it.
  It exists because `ResolvedModel.reasoning` is **required**: without it every
  OpenRouter artifact would send a `reasoning` block, including on the ~131/400
  catalog models with no reasoning support, where OpenRouter's behavior is
  unverified. It is the escape hatch that stops a re-pointed preset from
  bricking every turn, and it is what an unset effort behind a modelId override
  resolves to.
- **`medium` is retained despite no seeded model supporting it.** Pre-existing
  drafts and — decisively — **immutable** `agent_versions.definition` snapshots
  carry it and must keep parsing and recompiling.

**Ids may carry a leading `~`.** `modelIdShapeProblem`'s OpenRouter regex gains
`^~?`. Nothing else needs special handling: ids are emitted as escaped string
literals, stored in text columns, and artifact/world/JWT identity is
hash-derived, never id-derived.

## 4. The finding this all rests on: the effort never reached OpenRouter

Recorded empirically as **`spike/REPORT.md` finding 29**. In
`@openrouter/ai-sdk-provider@3.0.0`:

- `OpenRouterChatLanguageModel.getArgs()` destructures its call options at
  `dist/index.js:3589-3602` and **`reasoning` is not among them** — the field
  is dropped on the floor.
- What *does* reach the body is `this.settings.reasoning`
  (`dist/index.js:3637`), `providerOptions.openrouter.*`, and
  `settings.extraBody` — which is spread **last** over the assembled body
  (`dist/index.js:3648`, after `config.extraBody`) and therefore wins over
  anything the provider derived.

eve's `defineAgent({ reasoning })` config is handed to ai@7 as the top-level
`LanguageModelV4CallOptions.reasoning` **call option**, i.e. exactly the route
`getArgs()` ignores. So **every OpenRouter agent built before
`COMPILER_VERSION` 4.0.0 ran at the provider's default effort regardless of
what its definition said.**

The provider's typed `reasoning` *setting* does reach the wire, but its effort
union is `'xhigh' | 'high' | 'medium' | 'low' | 'minimal' | 'none'`
(`dist/index.d.ts:394`) — it has **no `max`**, which is precisely the top effort
all three seeded models advertise. So the effort rides `extraBody`:

```ts
openrouter(MODEL_ID, { extraBody: { reasoning: { effort: "max" } } })
```

`provider-default` emits a bare `openrouter(MODEL_ID)` with no settings object
at all. **Anthropic keeps eve's `reasoning:` config** — `@ai-sdk/anthropic@4.0.36`
is spec-v4 and eve maps the effort onto a thinking budget — clamping `max` →
`xhigh` (the AI SDK union's ceiling; both mean "spend the most") and omitting
the line for `provider-default`.

Two losses, accepted and commented into the generated file so nobody "fixes"
them back: the **keyless/gateway** branch carries no effort (there is no model
object to hang settings on), and eve's agent-info introspection route, which
reports `config.reasoning`, no longer sees one for OpenRouter agents.

## 5. Catalog-driven capabilities

`resources/openrouter-catalog.ts` already had the right fetch/cache/timeout/
in-flight-dedupe/fail-open machinery for allowlist-add validation; it just threw
the metadata away. It now caches
`ReadonlyMap<string, {id, contextWindowTokens?, supportedEfforts, defaultEffort?}>`
and **parses** the upstream body with zod instead of trusting it — this is
third-party JSON that feeds a user-facing selector and, through the efforts, the
wire shape of every turn. Rows are validated individually so one malformed row
cannot void the catalog; a `default_effort` outside the supported set is
dropped; an upstream `provider-default` string (the platform's own value, which
no provider advertises) is dropped as a collision.

The DI field was **renamed** `ResourceDeps.openRouterModelIds` →
`openRouterCatalog`: the type and semantics changed, and reusing the name would
have hidden that.

New route, member-readable (editing agents is a member operation), under the
existing `/workspaces` prefix so `infra/nginx/web.conf` needs no change:

```
GET /workspaces/:workspaceId/model-capabilities
  → { models: [{provider, modelId, supportedEfforts, defaultEffort?, contextWindowTokens?}],
      catalogAvailable: boolean }
```

**`supportedEfforts` is nullable and null means UNKNOWN, not "supports
nothing"** — no catalog entry, an unreachable catalog, or a non-OpenRouter
provider (Anthropic publishes no such list). Clients offer the full vocabulary
on null and must never render an empty selector. The entry list itself is always
complete: an openrouter.ai outage degrades capabilities, never the model picker.

The whole path is **fail-open**, matching the allowlist-add precedent: an
unsupported effort is a warning in the editor, never a publish blocker, so
republishing an existing agent cannot hard-fail on catalog drift.

## 6. Resolution, hashing, and rollout

Effort resolves in `runtime/model-resolution.ts` alongside the model, and rides
into the compiler's `ResolvedModel` as a **required** field. `hash.ts` already
folds `deps.resolvedModel` into the content hash, so the resolved effort re-keys
the artifact, the world database `ag_v_<hash12>`, and the platform-JWT audience
for free — **two identical definitions inheriting different preset efforts must
never share an artifact**, and they don't.

`compile()` gates the effort against the schema's options (it is emitted
verbatim into generated code) and mirrors the `MODEL_MISMATCH` guard: an
explicit `definition.model.reasoning` must equal `deps.resolvedModel.reasoning`.

**`COMPILER_VERSION` 3.1.0 → 4.0.0** (major: changed generated-code semantics).
`BUILD_ENV_EPOCH` is deliberately untouched — the byte change is inside
`compile()`, which `COMPILER_VERSION` already re-keys.

**Rollout is republish-to-migrate**, the same pattern as the eve 0.31 upgrade:
every content hash changes, and already-published agent versions keep serving
their existing artifacts until their agent is republished. Dispatch reads the
model and effort **baked into the version**, never the live preset row — which
is why the Settings → Models panel now carries a line saying preset changes
apply on the next publish.

## 7. Migration `0007` (existing workspaces)

Four steps, in one hand-ordered file.

**Enum widening is a DROP + CREATE, not `ALTER TYPE … ADD VALUE`.** Drizzle runs
all pending migrations inside **one transaction**, and Postgres refuses to *use*
an enum value added by `ADD VALUE` in the transaction that added it (verified:
`ERROR: unsafe use of new value "max" of enum type reasoning_effort`). That
breaks the **existing-deploy** path — where only 0007 is pending and the type
was committed long ago — at the `ADD COLUMN … DEFAULT 'high'`; a fresh deploy
would not have caught it. A type CREATEd inside the transaction carries no such
restriction, so drop-and-recreate works on both paths. This is safe **only**
because nothing referenced `reasoning_effort` before this migration (it existed
purely for the db↔shared lockstep and had no column), and `DROP TYPE` without
`CASCADE` errors loudly rather than silently corrupting if that ever stops being
true. The real pgEnum is kept rather than falling back to `text`, preserving
DB-level integrity and drizzle's union typing.

1. **Allowlist** `moonshotai/kimi-k3` and `~deepseek/deepseek-v4-flash-latest`
   for every organization — `ON CONFLICT (organization_id, provider, model_id)
   DO UPDATE SET enabled = true`, i.e. an existing row that an admin had
   **disabled** is re-enabled. This is not tidiness: step 2 re-points the
   presets at these ids unconditionally, and `resolveModel`'s preset branch
   requires an **enabled** allowlist row — so leaving a disabled row alone
   would answer 422 `model_not_allowlisted` on *every* publish through that
   preset. (Only `moonshotai/kimi-k3` can pre-exist: the tilde id was
   un-allowlistable before the id-shape regex changed.) Overriding the disable
   is the same deliberate stance as step 2, and the alternative bricks
   publishing rather than merely overruling a preference.
2. **Re-point every workspace's presets, unconditionally.** This **deliberately
   overwrites admin customizations**, including presets an admin re-pointed at
   Anthropic. "Migrate every workspace" was chosen over "only untouched
   presets": the alternative leaves customized workspaces on models the new
   effort vocabulary does not fit, and there is no honest way to tell a
   customization from a stale default. Published agents are unaffected until
   republished (§6).
3. **Strip `medium` from agent drafts** so those agents inherit instead:
   `UPDATE agents SET draft = draft #- '{model,reasoning}' WHERE draft->'model'->>'reasoning' = 'medium'`.
   **This is a behavioral migration and is labeled as one.** Because the old
   schema *defaulted* a missing effort to `medium`, a stored `medium` is
   indistinguishable from a deliberate user choice — so some explicit choices
   become inheritance here. That is intended: none of the three new models
   supports `medium`, and inheritance lands them on a supported effort.
   `#-` on a missing path is a no-op and `agents.draft` is jsonb, so drafts
   without the key are untouched.
4. **`agent_versions.definition` is NOT touched.** Published snapshots are
   immutable; their artifacts keep serving until republished.

`buildAllowlistRows()` in `src/seed.ts` **dedupes by (provider, modelId)** —
`balanced` and `quick` are the same model, and `ON CONFLICT DO NOTHING` is not a
guard against two conflicting rows inside one statement. The seeded agent drafts
drop `reasoning` entirely: starter agents inherit.

## 8. Surfaces

**Agent editor (`ModelSection`).** The effort select gains an `__inherit__`
sentinel mirroring the existing `NO_OVERRIDE` one, labeled
"Inherit from preset (Max)" — or "Inherit (model default)" when a modelId
override is active. Options come from the effective model's `supportedEfforts`,
sorted through `REASONING_ORDER` (**mandatory, not cosmetic**: the catalog
returns the set *descending*, so an unsorted selector renders backwards relative
to the fallback list) — **always led by `provider-default`**, which no catalog
advertises (the parser strips it: it is the platform's value, not a provider
capability) yet is legal on every model. That is `offeredReasoningEfforts()` in
`lib/labels.ts`, shared with Settings → Models, and it is what keeps a model
whose catalog row carries an **empty** supported set — listed, but no reasoning
support, roughly a third of the catalog — from rendering a selector with nothing
usable in it. `supportedEfforts: []` is a definite "no efforts" and must never
be collapsed into `null` ("unknown"). An explicit effort the model does not
advertise stays selectable with an advisory warning; the advisory is computed
off the **effective** effort, so an inherited level on an effort-less model is
flagged too (pointing at "Model default"), and `provider-default` is never
flagged. `resolvedModelLine()` — reused by the rail — names the effective effort
and whether it was inherited.

Two web-side blockers that would have silently defeated inheritance were fixed
first: `emptyAgentDefinition()` hardcoded `reasoning: "medium"`, and `withModel`
merged `patch.reasoning ?? current.reasoning`, which made clearing the override
a no-op that still typechecked.

**Settings → Models.** A third control (`sm:grid-cols-3`) for the effort,
filtered per model through the same `offeredReasoningEfforts()`, snapping to the
catalog's `defaultEffort` (or `provider-default`) when a model change makes the
current effort unsupported — except a stored `provider-default`, which is legal
everywhere and therefore never snapped onto a level. A model with an empty
supported set gets an advisory line naming "Model default" as the safe choice.
The effort appears on the preset card chip; and the panel states that preset
changes apply on the next publish.

**Copilot.** `setModelParams.reasoning` becomes `nullable().optional()` — three
valued, because the model must be able to say "go back to inheriting" as an
*action*: absent = leave alone, `null` = clear the override, a value = set it.
The inventory renders each preset's effort and each allowlisted model's
supported set (the catalog had to be threaded into the copilot deps — it
previously reached only `ResourceDeps`), and `validate.ts` rejects an
unsupported effort **only when the catalog is available**.

## 9. Verification

Ordered, because the golden digest must be regenerated before any full lane:

1. `bun run typecheck` + the shared/db/web suites (`golden.test.ts` is red by
   design until step 2).
2. `UPDATE_GOLDEN=1 bun test packages/compiler/src/golden.test.ts`, then **read
   the regenerated `agent/agent.ts` fixtures** before accepting them.
3. `bun test` — the digest/`COMPILER_VERSION` pairing proves the ritual.
4. `SPIKE_EVE_BUILD=1` compiler build test — the only check that typechecks
   `openrouter(MODEL_ID, {extraBody: …})` and the Anthropic `xhigh` clamp
   against real eve 0.31.3 types.
5. **Migration against a pre-existing schema** — the case that fails if the enum
   is mishandled. A DB at 0006, then `bun run --cwd packages/db migrate`; a
   fresh-schema run alone would not catch it.
6. **Wire-level proof through the generated code** (DONE — the wire probe,
   `packages/compiler/src/wire-probe.mjs`, run by the gated
   `eve-build.test.ts`). Not a hand-written request: the emitted
   `agent/agent.ts` is imported for real, its `OPENROUTER_BASE_URL` branch is
   pointed at a capturing stub gateway, and the captured **body** is asserted —
   `reasoning: {effort: "max"}` for the inheriting fixture, **no** `reasoning`
   key for the `provider-default` one, and a byte-identical body when
   `reasoning` is passed as a call option (eve's own route), which is §4's
   drop proven empirically rather than read out of the provider dist. It
   deliberately does not boot eve's tool loop — that needs a world DB and a
   platform JWT, and eve's only contribution to the effort is the call option
   the third assertion shows is discarded.
7. Keyed lanes (real key, cents) — **RUN 2026-08-08, both green**
   (`keyed-acceptance` 5/5, copilot `keyed.test.ts` 1/1), which also retires
   the `AGENTS.md` residual that the `@openrouter/ai-sdk-provider@3.0.0` keyed
   round-trip was unproven. The two upstream questions this design rested on
   are now **ANSWERED against the live API**, not assumed:
   - *Does OpenRouter accept `effort: "max"` on `moonshotai/kimi-k3`?* **Yes,
     and it changes behavior** — 200 with 116 reasoning tokens at `max` vs 20
     at `low` on the same prompt (5.8×). The effort is not merely tolerated;
     it is honoured.
   - *Does it tolerate a `reasoning` block on a model advertising no reasoning
     support — ignore, or 400?* **It ignores it.** `inclusionai/ling-2.6-flash`
     and `mistralai/mistral-nemo` (both `reasoning: null` in the catalog) each
     answered 200 with `reasoning_tokens: 0`, byte-comparable to the same
     request with no `reasoning` key at all.
   So `provider-default` correctly stays an *offered* value rather than the
   forced resolution for effort-less models: sending an effort to one is inert,
   not fatal. Had this 400'd, §3's resolution rules would have needed to snap
   such models to `provider-default` automatically.
8. Tilde round-trip: allowlist → preset → publish → dispatch.
9. Phase-1 + phase-3 acceptance and Playwright (`a11y.e2e.ts` at zero
   serious/critical with the new controls).

## 10. Documentation (same commit, per the repo contract)

This spec (+ its row in `AGENTS.md`'s living-documents table) ·
`AGENTS.md` constraints (the passthrough rule, the `~` id shape) ·
`spike/REPORT.md` finding 29 (append, never rewrite) ·
`docs/runtime-worker-contract.md` (effort baked at publish) ·
`packages/compiler/README.md` (the per-provider emission table) ·
`README.md` · `docs/PLAN.md`. `INITIAL-SPEC.md` is **not** edited — see §2.
