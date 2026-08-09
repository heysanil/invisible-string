-- HAND-ORDERED. drizzle-kit emitted five `ALTER TYPE … ADD VALUE` statements
-- here; they are replaced with a DROP TYPE + CREATE TYPE pair deliberately.
--
-- Drizzle runs ALL pending migrations inside ONE transaction, and Postgres
-- refuses to USE an enum value added by ALTER TYPE … ADD VALUE in the same
-- transaction that added it ("unsafe use of new value \"max\" of enum type
-- reasoning_effort"). That breaks the EXISTING-deploy path, where only this
-- migration is pending and the type was committed long ago — the ADD COLUMN …
-- DEFAULT 'high' below is exactly such a use. A type CREATEd inside the
-- transaction has no such restriction, so drop-and-recreate works on both the
-- fresh-deploy and the existing-deploy paths.
--
-- This is only safe because nothing referenced reasoning_effort before this
-- migration (the enum was defined for the db↔shared lockstep and carried no
-- column). If that ever stops being true, DROP TYPE errors loudly rather than
-- silently corrupting anything — which is the point of not using CASCADE.
DROP TYPE "public"."reasoning_effort";--> statement-breakpoint
CREATE TYPE "public"."reasoning_effort" AS ENUM('provider-default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max');--> statement-breakpoint
ALTER TABLE "model_presets" ADD COLUMN "reasoning" "reasoning_effort" DEFAULT 'high' NOT NULL;--> statement-breakpoint

-- ── Data migration: the new seeded model defaults ──────────────────────────
-- Presets move to moonshotai/kimi-k3 @ max (powerful) and
-- ~deepseek/deepseek-v4-flash-latest @ max/low (balanced/quick). The two
-- deepseek tiers are THE SAME MODEL at different efforts — which is why the
-- effort had to become part of the preset in the first place.

-- 1. Allowlist the two new model ids in every workspace, and RE-ENABLE an
--    existing row that was disabled. The re-enable is load-bearing, not
--    tidiness: step 2 re-points the presets at these ids unconditionally, and
--    resolveModel's preset branch requires an ENABLED allowlist row — so a
--    workspace that had allowlisted then disabled moonshotai/kimi-k3 (a legal
--    id shape before this change, unlike the tilde alias) would answer 422
--    model_not_allowlisted on EVERY publish through `powerful`. Overriding an
--    admin's disable is the same deliberate stance step 2 already takes, and
--    the alternative — leaving a preset pointing at a disabled model — bricks
--    publishing instead of merely overruling a preference.
--    The leading `~` is part of OpenRouter's id for its `-latest` aliases,
--    not a typo.
INSERT INTO "model_allowlist" ("organization_id", "provider", "model_id", "enabled")
SELECT "organization"."id", 'openrouter', "new_models"."model_id", true
FROM "organization"
CROSS JOIN (VALUES ('moonshotai/kimi-k3'), ('~deepseek/deepseek-v4-flash-latest')) AS "new_models"("model_id")
ON CONFLICT ("organization_id", "provider", "model_id")
DO UPDATE SET "enabled" = true, "updated_at" = now();--> statement-breakpoint

-- 2. Re-point every workspace's presets, UNCONDITIONALLY. This deliberately
--    overwrites admin customizations (including presets re-pointed at
--    Anthropic): "migrate every workspace" was the chosen option over "only
--    untouched presets". Existing PUBLISHED agents are unaffected — dispatch
--    reads the version's baked model, so a preset change only lands on the
--    next publish.
UPDATE "model_presets" SET "provider" = 'openrouter', "model_id" = 'moonshotai/kimi-k3', "reasoning" = 'max', "updated_at" = now() WHERE "slug" = 'powerful';--> statement-breakpoint
UPDATE "model_presets" SET "provider" = 'openrouter', "model_id" = '~deepseek/deepseek-v4-flash-latest', "reasoning" = 'max', "updated_at" = now() WHERE "slug" = 'balanced';--> statement-breakpoint
UPDATE "model_presets" SET "provider" = 'openrouter', "model_id" = '~deepseek/deepseek-v4-flash-latest', "reasoning" = 'low', "updated_at" = now() WHERE "slug" = 'quick';--> statement-breakpoint

-- 3. BEHAVIORAL MIGRATION, stated honestly: strip `medium` from agent drafts so
--    those agents inherit their preset's effort instead. None of the three new
--    models supports `medium` — it was only ever the old schema's *default*,
--    so a stored `medium` is indistinguishable from a deliberate user choice
--    and some explicit choices do become inheritance here. That is intended.
--    `#-` on a missing path is a no-op and agents.draft is jsonb, so drafts
--    without a model/reasoning key are untouched.
--    agent_versions.definition is NOT touched: published snapshots are
--    immutable, and their artifacts keep serving until republished.
UPDATE "agents" SET "draft" = "draft" #- '{model,reasoning}', "updated_at" = now() WHERE "draft"->'model'->>'reasoning' = 'medium';
