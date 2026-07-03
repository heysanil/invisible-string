/**
 * Workspace seeds — INITIAL-SPEC.md §2/§7 locked defaults.
 *
 * `seedWorkspace(db, organizationId)` is idempotent and safe to call at
 * workspace-creation time and on every deploy: rows are upserted with
 * ON CONFLICT DO NOTHING so workspace admins' later edits are never
 * clobbered.
 *
 * CLI: DATABASE_URL=postgres://… [SEED_DEMO=1] bun run src/seed.ts
 *   - seeds every existing organization
 *   - SEED_DEMO=1 additionally creates a demo user + demo org (idempotent)
 */
import { createDb, type Db } from "./client";
import { member, organization, user } from "./schema/auth";
import { agents, modelAllowlist, modelPresets } from "./schema/product";

// ── Locked seed data (spec §2: do not relitigate) ───────────────────────────

export type ModelPresetSeed = {
  slug: "powerful" | "balanced" | "quick";
  provider: "anthropic" | "openrouter";
  modelId: string;
};

/** powerful/balanced/quick → OpenRouter models (spec §2, verified live). */
export const DEFAULT_MODEL_PRESETS: readonly ModelPresetSeed[] = [
  { slug: "powerful", provider: "openrouter", modelId: "z-ai/glm-5.2" },
  {
    slug: "balanced",
    provider: "openrouter",
    modelId: "deepseek/deepseek-v4-pro",
  },
  {
    slug: "quick",
    provider: "openrouter",
    modelId: "deepseek/deepseek-v4-flash",
  },
] as const;

export type AgentPresetSeed = {
  name: string;
  description: string;
  basePrompt: string;
  reasoningEffort: "low" | "medium" | "high";
  modelPreset: "powerful" | "balanced" | "quick";
};

/** Seed agent presets (spec §9): General Purpose / Software Engineer / Product Designer. */
export const DEFAULT_AGENT_PRESETS: readonly AgentPresetSeed[] = [
  {
    name: "General Purpose",
    description: "Versatile assistant for research, writing, and everyday tasks.",
    basePrompt: [
      "You are a capable, general-purpose assistant.",
      "Understand the task before acting; ask a clarifying question only when the request is genuinely ambiguous.",
      "Use the tools and context available to you rather than guessing, and say so plainly when you cannot verify something.",
      "Be concise and concrete: lead with the answer or result, then any essential caveats.",
    ].join("\n"),
    reasoningEffort: "medium",
    modelPreset: "balanced",
  },
  {
    name: "Software Engineer",
    description:
      "Writes, reviews, and debugs code with a bias for small, verified changes.",
    basePrompt: [
      "You are a pragmatic senior software engineer.",
      "Read the relevant code and error output before proposing changes; never invent APIs.",
      "Prefer the smallest change that solves the problem, keep the codebase's existing style, and consider edge cases and failure modes.",
      "Verify your work whenever possible (run tests, type checks, or the code itself) and report exactly what you verified.",
      "When you make a claim about behavior, back it with evidence from code you read or commands you ran.",
    ].join("\n"),
    reasoningEffort: "medium",
    modelPreset: "balanced",
  },
  {
    name: "Product Designer",
    description:
      "Product and UX design partner for flows, copy, and interface critique.",
    basePrompt: [
      "You are a thoughtful product designer.",
      "Start from the user's goal and context, not the feature: state the problem before proposing solutions.",
      "Propose concrete flows, states (empty, loading, error), and interface copy — not vague direction.",
      "Favor clarity and accessibility over decoration; call out trade-offs between options explicitly.",
      "When critiquing existing work, be specific about what to change and why it improves the user's outcome.",
    ].join("\n"),
    reasoningEffort: "medium",
    modelPreset: "balanced",
  },
] as const;

// ── Pure row builders (unit-testable, no DB) ────────────────────────────────

export function buildModelPresetRows(organizationId: string) {
  return DEFAULT_MODEL_PRESETS.map((preset) => ({
    organizationId,
    slug: preset.slug,
    provider: preset.provider,
    modelId: preset.modelId,
  }));
}

/** Allowlist rows for the three seeded preset models (spec §7). */
export function buildAllowlistRows(organizationId: string) {
  return DEFAULT_MODEL_PRESETS.map((preset) => ({
    organizationId,
    provider: preset.provider,
    modelId: preset.modelId,
    enabled: true,
  }));
}

export function buildAgentPresetRows(organizationId: string) {
  return DEFAULT_AGENT_PRESETS.map((preset) => ({
    organizationId,
    name: preset.name,
    description: preset.description,
    basePrompt: preset.basePrompt,
    reasoningEffort: preset.reasoningEffort,
    modelPreset: preset.modelPreset,
  }));
}

// ── Runtime seeding ─────────────────────────────────────────────────────────

/**
 * Idempotently seed a workspace (= Better Auth organization) with the locked
 * model presets, their allowlist entries, and the default agent presets.
 * Existing rows (including admin-edited ones) are left untouched.
 */
export async function seedWorkspace(
  db: Db,
  organizationId: string,
): Promise<void> {
  await db
    .insert(modelPresets)
    .values(buildModelPresetRows(organizationId))
    .onConflictDoNothing({
      target: [modelPresets.organizationId, modelPresets.slug],
    });

  await db
    .insert(modelAllowlist)
    .values(buildAllowlistRows(organizationId))
    .onConflictDoNothing({
      target: [
        modelAllowlist.organizationId,
        modelAllowlist.provider,
        modelAllowlist.modelId,
      ],
    });

  await db
    .insert(agents)
    .values(buildAgentPresetRows(organizationId))
    .onConflictDoNothing({ target: [agents.organizationId, agents.name] });
}

// ── Demo user/org (dev + integration-test convenience) ─────────────────────

export const DEMO_USER = {
  id: "demo-user",
  name: "Demo User",
  email: "demo@invisible-string.local",
} as const;

export const DEMO_ORG = {
  id: "demo-org",
  name: "Demo Workspace",
  slug: "demo",
} as const;

/**
 * Idempotently create the demo user + demo workspace (owner membership) and
 * seed the workspace. Login credentials for the demo user are provisioned by
 * the auth layer (Better Auth), not here — this only guarantees the rows the
 * product schema references.
 */
export async function seedDemo(db: Db): Promise<string> {
  await db
    .insert(user)
    .values({
      id: DEMO_USER.id,
      name: DEMO_USER.name,
      email: DEMO_USER.email,
      emailVerified: true,
    })
    .onConflictDoNothing({ target: user.id });

  await db
    .insert(organization)
    .values({
      id: DEMO_ORG.id,
      name: DEMO_ORG.name,
      slug: DEMO_ORG.slug,
      createdAt: new Date(),
    })
    .onConflictDoNothing({ target: organization.id });

  await db
    .insert(member)
    .values({
      id: "demo-member",
      organizationId: DEMO_ORG.id,
      userId: DEMO_USER.id,
      role: "owner",
      createdAt: new Date(),
    })
    .onConflictDoNothing({ target: member.id });

  await seedWorkspace(db, DEMO_ORG.id);
  return DEMO_ORG.id;
}

if (import.meta.main) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL must be set to run the seed script");
    process.exit(1);
  }
  const db = createDb(url, { max: 1 });
  try {
    if (process.env.SEED_DEMO === "1") {
      await seedDemo(db);
      console.log(`seeded demo user/org (${DEMO_ORG.id})`);
    }
    const orgs = await db.select({ id: organization.id }).from(organization);
    for (const org of orgs) {
      await seedWorkspace(db, org.id);
    }
    console.log(`seeded ${orgs.length} workspace(s)`);
  } finally {
    await db.$client.end();
  }
}
