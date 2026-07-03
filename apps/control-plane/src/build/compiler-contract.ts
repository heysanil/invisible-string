/**
 * Compile contract between the control plane and packages/compiler.
 *
 * This file defines the injectable interface the build/publish paths consume
 * (tests inject stubs); the production implementation is the adapter over
 * @invisible-string/compiler in `compiler-adapter.ts`. The control plane
 * resolves preset→model and validates the allowlist BEFORE calling compile
 * (typed errors surface to the API), so the compiler receives an
 * already-resolved model.
 */
import type { WorkflowDefinition } from "@invisible-string/shared";

import type { ResolvedModel } from "../runtime/model-resolution";

/** One MCP connection, resolved from the context pillar's ids. */
export interface CompileConnection {
  id: string;
  name: string;
  /** MCP server URL. */
  url: string | null;
  /**
   * Env var the generated connection module reads its token from
   * (`process.env[envTokenVar]`); null when the connection has no auth.
   * Secrets NEVER appear in generated files.
   */
  envTokenVar: string | null;
  toolAllow: string[] | null;
  toolBlock: string[] | null;
  approvalPolicy: Record<string, unknown> | null;
}

/** One authored skill, resolved from the context pillar's ids. */
export interface CompileSkill {
  id: string;
  name: string;
  description: string | null;
  content: string;
}

export interface CompileRequest {
  definition: WorkflowDefinition;
  /** Publish-time resolved provider/model (allowlist-checked upstream). */
  model: ResolvedModel;
  connections: CompileConnection[];
  skills: CompileSkill[];
  /**
   * Human-readable identity baked into the generated project (package name,
   * instructions header). Lowercase kebab-case — the routes slugify the
   * organization slug / workflow name before compiling. Participates in the
   * content hash (renaming a workflow re-keys its artifact).
   */
  workspaceSlug: string;
  workflowSlug: string;
}

export interface CompileResult {
  /** Relative path → file content of the emitted eve project. */
  files: ReadonlyMap<string, string>;
  /** Content hash covering config + compiler version + eve version. */
  hash: string;
  compilerVersion: string;
  eveVersion: string;
}

/** One structured compile problem (builder UI renders these). */
export interface CompileIssue {
  path?: string;
  message: string;
}

/** Typed compile failure — publish/dry-run translate it to a 422. */
export class WorkflowCompileError extends Error {
  override readonly name = "WorkflowCompileError";
  constructor(public readonly issues: CompileIssue[]) {
    super(
      issues.map((issue) => (issue.path ? `${issue.path}: ${issue.message}` : issue.message)).join("; ") ||
        "workflow failed to compile",
    );
  }
}

export type CompileWorkflowFn = (request: CompileRequest) => CompileResult;
