/**
 * @invisible-string/compiler — pure workflow → eve-project code generation.
 *
 * `compile(definition, deps)` renders a complete, buildable eve agent
 * project (files map) plus the deterministic workflow-version hash. The
 * runtime version matrix lives in `versions.json` (recorded by the Phase-0
 * spike — the ONLY source for eve/ai/provider pins) and is re-exported here
 * as `RUNTIME_VERSIONS` for the control plane's build service.
 */
import versionsJson from "../versions.json";
import type { RuntimeVersions } from "./types";

export { compile } from "./compile";
export { CompileError, type CompileErrorCode } from "./errors";
export { canonicalJson, computeWorkflowHash } from "./hash";
export {
  PLATFORM_JWT_AUDIENCE,
  PLATFORM_JWT_ISSUER,
  PLATFORM_TRIGGER_ROUTE_PREFIX,
  triggerRoutePath,
} from "./platform";
export type {
  ApprovalRule,
  ApprovalSpec,
  CompileDeps,
  CompileOptions,
  CompileResult,
  ConnectionAuthSpec,
  ModelProvider,
  ResolvedAgentPreset,
  ResolvedMcpConnection,
  ResolvedModel,
  ResolvedSkill,
  RuntimeVersions,
  ToolFilterSpec,
} from "./types";
export { COMPILER_VERSION } from "./version";
export { connectionTokenEnvVar } from "./codegen/strings";

/** The pinned runtime version matrix (contents of versions.json). */
export const RUNTIME_VERSIONS: RuntimeVersions = versionsJson;
