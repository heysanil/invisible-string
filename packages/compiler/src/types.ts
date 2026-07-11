/**
 * Inputs and outputs of the pure `compile()` function.
 *
 * The control plane resolves everything referenced by UUID in the
 * AgentDefinition (MCP connections, skills) and the model
 * (preset → allowlist → provider+id) BEFORE calling compile. compile()
 * receives only plain data, performs no I/O, and is deterministic:
 * identical inputs always produce identical `files` and `hash`.
 *
 * SECRETS DISCIPLINE: nothing in these inputs may carry a secret VALUE.
 * Connections name the ENV VARS the generated code reads at runtime
 * (`MCP_<SLUG>_TOKEN`, header env names); the worker supervisor injects the
 * decrypted values at spawn.
 */

/**
 * Exact runtime version matrix — the shape of `packages/compiler/versions.json`
 * (the ONLY source for eve/ai/provider pins; recorded by the Phase-0 spike).
 * Extra fields (generatedAt, notes) are allowed and participate in the hash.
 */
export interface RuntimeVersions {
  readonly eve: string;
  readonly ai: string;
  readonly worldPostgres: string;
  readonly openrouterProvider: string;
  readonly anthropicProvider: string;
  readonly zod: string;
  readonly typescript: string;
  readonly typesNode: string;
  readonly node: string;
  readonly [extra: string]: unknown;
}

/** Model provider routes the compiler can emit. */
export type ModelProvider = "openrouter" | "anthropic";

/**
 * The model the control plane resolved (preset/override → allowlist check →
 * provider + native model id). For `openrouter` the id is a gateway-style
 * slug (`deepseek/deepseek-v4-flash`); for `anthropic` it is the provider's
 * native hyphenated id (`claude-opus-4-8`).
 */
export interface ResolvedModel {
  readonly provider: ModelProvider;
  readonly modelId: string;
}

/**
 * How the generated connection authenticates against the MCP server. Values
 * name ENV VARS, never secrets:
 * - `bearerToken`: `auth.getToken` reads `MCP_<SLUG_UPPER>_TOKEN`.
 * - `headers`: each header reads the named env var lazily per request.
 */
export type ConnectionAuthSpec =
  | { readonly kind: "none" }
  | { readonly kind: "bearerToken" }
  | {
      readonly kind: "headers";
      /** header name → ENV VAR NAME holding its value. */
      readonly headers: Readonly<Record<string, string>>;
    };

/** Per-tool decision inside a custom approval policy. */
export interface ApprovalRule {
  /** BARE remote tool name — the policy matches the QUALIFIED `<slug>__<tool>`. */
  readonly tool: string;
  readonly decision: "ask" | "allow" | "deny";
}

/**
 * Approval gate for a connection's tools. `never`/`once`/`always` map to the
 * `eve/tools/approval` helpers; `custom` compiles to a per-tool policy
 * matching QUALIFIED tool names (`<connection>__<tool>`).
 */
export type ApprovalSpec =
  | { readonly mode: "never" }
  | { readonly mode: "once" }
  | { readonly mode: "always" }
  | {
      readonly mode: "custom";
      readonly rules: readonly ApprovalRule[];
      /** Decision for tools no rule names. */
      readonly fallback: "allow" | "ask";
    };

/** Exactly one of allow/block — enforced at compile. */
export type ToolFilterSpec =
  | { readonly allow: readonly string[]; readonly block?: undefined }
  | { readonly block: readonly string[]; readonly allow?: undefined };

/** One `mcp_connections` row resolved for this agent's context. */
export interface ResolvedMcpConnection {
  /** Matches an entry of `definition.context.mcpConnectionIds`. */
  readonly id: string;
  /** Filename + eve runtime connection name (`agent/connections/<slug>.ts`). */
  readonly slug: string;
  /** MCP server URL (streamable HTTP / SSE) — a literal in generated code. */
  readonly url: string;
  /** Model-facing summary (drives `connection_search`). */
  readonly description: string;
  readonly auth: ConnectionAuthSpec;
  readonly tools?: ToolFilterSpec;
  readonly approval: ApprovalSpec;
}

/** One `skills` row resolved for this agent's context. */
export interface ResolvedSkill {
  /** Matches an entry of `definition.context.skillIds`. */
  readonly id: string;
  /** `agent/skills/<slug>.md` (flat) or `agent/skills/<slug>/SKILL.md`. */
  readonly slug: string;
  /** Routing hint eve advertises to the model. */
  readonly description: string;
  readonly markdown: string;
  /** Extra files → packaged-skill directory (relative path → content). */
  readonly files?: Readonly<Record<string, string>>;
}

export interface CompileOptions {
  /**
   * Dev builds append `localDev()` to every channel auth chain so loopback
   * tooling can reach the agent. NEVER set for production artifacts
   * (spike/REPORT.md finding 16) — the flag participates in the hash so a
   * dev artifact can never be cache-hit for a production deploy.
   */
  readonly dev?: boolean;
}

/** Everything compile() needs beyond the AgentDefinition. */
export interface CompileDeps {
  readonly versions: RuntimeVersions;
  readonly resolvedModel: ResolvedModel;
  /**
   * Participates in the hash DELIBERATELY (tenant isolation): identical
   * agent configs in two workspaces must never share an artifact, world
   * database, or JWT audience.
   */
  readonly workspaceSlug: string;
  readonly agentSlug: string;
  readonly connections: readonly ResolvedMcpConnection[];
  readonly skills: readonly ResolvedSkill[];
  readonly options?: CompileOptions;
  /**
   * Caller's build-ENVIRONMENT epoch (the control plane passes
   * build/steps.ts BUILD_ENV_EPOCH). The compiler hash covers the compile
   * INPUT; this covers the build steps that turn the emitted files into an
   * artifact — `eve build` bakes env-dependent state (model routing) into
   * artifact bytes, so a build-env change must re-key cached artifacts.
   * Participates in computeAgentHash; MUST flow through compile() (not be
   * appended afterwards) because the emitted platform-auth lib bakes the JWT
   * audience `agent-version:<hash>` — an outward hash that differs from the
   * baked one would 401 every platform-minted token. `undefined` keeps
   * historical hashes.
   */
  readonly buildEnvEpoch?: number;
}

export interface CompileResult {
  /** Project-root-relative path → file content (the full eve project). */
  readonly files: Map<string, string>;
  /** sha256 hex over the canonicalized compile input — see hash.ts. */
  readonly hash: string;
}
