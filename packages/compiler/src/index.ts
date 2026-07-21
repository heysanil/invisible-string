/**
 * @invisible-string/compiler — pure agent → eve-project code generation.
 *
 * `compile(definition, deps)` renders a complete, buildable eve agent
 * project (files map) plus the deterministic agent-version hash — the agent
 * is the compile unit; workflows carry no builds. The runtime version matrix
 * lives in `versions.json` (recorded by the Phase-0 spike — the ONLY source
 * for eve/ai/provider pins) and is re-exported here as `RUNTIME_VERSIONS`
 * for the control plane's build service.
 */
import versionsJson from "../versions.json";
import type { RuntimeVersions } from "./types";

export { compile } from "./compile";
export { CompileError, type CompileErrorCode } from "./errors";
export { canonicalJson, computeAgentHash } from "./hash";
export {
  PLATFORM_JWT_AUDIENCE,
  PLATFORM_JWT_ISSUER,
  platformJwtAudienceForHash,
} from "./platform";
export type {
  ApprovalRule,
  ApprovalSpec,
  CompileDeps,
  CompileOptions,
  CompileResult,
  ConnectionAuthSpec,
  ModelProvider,
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
