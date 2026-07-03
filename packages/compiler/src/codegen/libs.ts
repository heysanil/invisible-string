/**
 * Generated `agent/lib/*` modules. Generated projects CANNOT depend on
 * workspace packages, so platform contracts (JWT claims, TriggerEvent) are
 * inlined here as standalone code; the source-of-truth shapes live in
 * packages/shared and the values below must stay in lockstep with the
 * control-plane dispatcher (compile-time constants, asserted by compiler
 * tests).
 */
import { PLATFORM_JWT_AUDIENCE, PLATFORM_JWT_ISSUER } from "../platform";
import { tsString } from "./strings";

export function emitPlatformAuthLib(dev: boolean): string {
  const localDevImport = dev ? "\n  localDev," : "";
  const chain = dev ? "[platformJwt(), localDev()]" : "[platformJwt()]";
  const devNote = dev
    ? `\n * DEV BUILD: localDev() admits loopback traffic so local tooling can
 * reach the agent. Production artifacts omit it (spike/REPORT.md finding 16).`
    : "";
  return `import {
  extractBearerToken,${localDevImport}
  verifyJwtHmac,
  type AuthFn,
} from "eve/channels/auth";

/**
 * Platform route auth: an HS256 JWT signed with the shared
 * PLATFORM_JWT_SECRET, minted by the control-plane dispatcher. Claim
 * constants mirror the platform contract (packages/shared).${devNote}
 */
export const PLATFORM_JWT_ISSUER = ${tsString(PLATFORM_JWT_ISSUER)};
export const PLATFORM_JWT_AUDIENCE = ${tsString(PLATFORM_JWT_AUDIENCE)};

export function platformJwt(): AuthFn<Request> {
  return async (request) => {
    const secret = process.env.PLATFORM_JWT_SECRET;
    if (secret === undefined || secret.length === 0) return null;
    const token = extractBearerToken(request.headers.get("authorization"));
    const result = await verifyJwtHmac(token, {
      algorithm: "HS256",
      audiences: [PLATFORM_JWT_AUDIENCE],
      issuer: PLATFORM_JWT_ISSUER,
      secret,
    });
    return result.ok ? result.sessionAuth : null;
  };
}

/** Ordered route-auth chain for every platform-facing channel route. */
export function platformAuth(): AuthFn<Request>[] {
  return ${chain};
}
`;
}

export function emitEnvLib(): string {
  return `/** Read a REQUIRED env var (secrets are injected by the worker supervisor). */
export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.length === 0) {
    throw new Error(\`Missing required environment variable \${name}\`);
  }
  return value;
}
`;
}

export function emitTriggerEventLib(): string {
  return `/**
 * TriggerEvent — the platform's normalized trigger envelope, inlined from
 * packages/shared/src/trigger-event.ts (generated projects cannot depend on
 * workspace packages). The control-plane dispatcher POSTs this shape to the
 * trigger channel with a platform JWT.
 */
export interface TriggerPrincipal {
  readonly workspaceId: string;
  readonly userId?: string;
  readonly source: string;
}

export interface TriggerFile {
  readonly name: string;
  readonly mediaType: string;
  /** Inline base64 (small payloads) or an object-store URL string. */
  readonly data: string;
}

export interface TriggerEvent {
  readonly workflowId: string;
  readonly triggerType: string;
  readonly message: string;
  /** Structured fields that {{trigger.*}} markers resolve against. */
  readonly data: Record<string, unknown>;
  readonly files?: readonly TriggerFile[];
  readonly principal: TriggerPrincipal;
  /** Maps threaded/conversational triggers onto an existing session. */
  readonly continuationToken?: string;
  /** Extra platform context blocks folded into the model message. */
  readonly context?: readonly string[];
}

export type ParseTriggerEventResult =
  | { readonly ok: true; readonly event: TriggerEvent }
  | { readonly ok: false; readonly error: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

export function parseTriggerEvent(body: unknown): ParseTriggerEventResult {
  if (!isRecord(body)) return { ok: false, error: "body must be a JSON object" };
  if (typeof body.workflowId !== "string" || body.workflowId.length === 0) {
    return { ok: false, error: "workflowId (non-empty string) is required" };
  }
  if (typeof body.triggerType !== "string" || body.triggerType.length === 0) {
    return { ok: false, error: "triggerType (non-empty string) is required" };
  }
  if (typeof body.message !== "string") {
    return { ok: false, error: "message (string) is required" };
  }
  if (!isRecord(body.data)) {
    return { ok: false, error: "data (object) is required" };
  }
  const principal = body.principal;
  if (
    !isRecord(principal) ||
    typeof principal.workspaceId !== "string" ||
    principal.workspaceId.length === 0 ||
    typeof principal.source !== "string" ||
    principal.source.length === 0 ||
    (principal.userId !== undefined && typeof principal.userId !== "string")
  ) {
    return { ok: false, error: "principal { workspaceId, source, userId? } is required" };
  }
  if (
    body.continuationToken !== undefined &&
    (typeof body.continuationToken !== "string" || body.continuationToken.length === 0)
  ) {
    return { ok: false, error: "continuationToken must be a non-empty string" };
  }
  if (body.context !== undefined && !isStringArray(body.context)) {
    return { ok: false, error: "context must be an array of strings" };
  }
  if (body.files !== undefined) {
    if (
      !Array.isArray(body.files) ||
      !body.files.every(
        (file) =>
          isRecord(file) &&
          typeof file.name === "string" &&
          typeof file.mediaType === "string" &&
          typeof file.data === "string",
      )
    ) {
      return { ok: false, error: "files must be an array of { name, mediaType, data }" };
    }
  }
  return { ok: true, event: body as unknown as TriggerEvent };
}

/** Resolve a dot path (e.g. "customer.email") against TriggerEvent.data. */
export function resolveTriggerPath(
  data: Record<string, unknown>,
  path: string,
): unknown {
  let current: unknown = data;
  for (const segment of path.split(".")) {
    if (!isRecord(current)) return undefined;
    current = current[segment];
  }
  return current;
}

function formatTriggerValue(value: unknown): string {
  if (value === undefined) return "(not provided)";
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

/**
 * Fold platform context blocks + resolved {{trigger.*}} marker values into
 * the model message (custom channels fold context into the message; only the
 * default eve channel has an onMessage context hook).
 */
export function buildTriggerMessage(
  event: TriggerEvent,
  refPaths: readonly string[],
): string {
  const blocks: string[] = [...(event.context ?? [])];
  for (const path of refPaths) {
    const value = resolveTriggerPath(event.data, path);
    blocks.push(\`trigger.\${path}: \${formatTriggerValue(value)}\`);
  }
  if (blocks.length === 0) return event.message;
  return \`<trigger-context>\\n\${blocks.join("\\n")}\\n</trigger-context>\\n\\n\${event.message}\`;
}
`;
}
