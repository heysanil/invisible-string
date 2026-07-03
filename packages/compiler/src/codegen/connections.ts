/**
 * Generated `agent/connections/<slug>.ts` — one `defineMcpClientConnection`
 * per resolved CONTEXT connection.
 *
 * - URL and description are literals; SECRETS NEVER ARE. Bearer auth reads
 *   `MCP_<SLUG_UPPER>_TOKEN` via a lazy `getToken`; header auth reads each
 *   named env var inside the lazy `headers` callback (module-scope reads
 *   would crash keyless `eve build`).
 * - tools carries exactly one of allow/block (validated at compile).
 * - approval: `never()` / `once()` / `always()` helpers, or a generated
 *   custom policy matching QUALIFIED tool names — eve surfaces connection
 *   tools to approval policies as `<connection>__<tool>`.
 */
import type { ApprovalSpec, ResolvedMcpConnection } from "../types";
import { connectionTokenEnvVar, tsString, tsStringArray } from "./strings";

function qualify(slug: string, tools: readonly string[]): string[] {
  return tools.map((tool) => `${slug}__${tool}`);
}

function customApprovalCode(
  slug: string,
  approval: Extract<ApprovalSpec, { mode: "custom" }>,
): { header: string; expression: string } {
  const byDecision = (decision: "ask" | "allow" | "deny") =>
    approval.rules
      .filter((rule) => rule.decision === decision)
      .map((rule) => rule.tool);
  const deny = qualify(slug, byDecision("deny"));
  const ask = qualify(slug, byDecision("ask"));
  const allow = qualify(slug, byDecision("allow"));
  const fallbackStatus =
    approval.fallback === "ask" ? `"user-approval"` : `"not-applicable"`;

  const lists: string[] = [];
  const checks: string[] = [];
  if (deny.length > 0) {
    lists.push(`const DENY_TOOLS: readonly string[] = ${tsStringArray(deny)};`);
    checks.push(`    if (DENY_TOOLS.includes(toolName)) return "denied";`);
  }
  if (ask.length > 0) {
    lists.push(`const ASK_TOOLS: readonly string[] = ${tsStringArray(ask)};`);
    checks.push(`    if (ASK_TOOLS.includes(toolName)) return "user-approval";`);
  }
  if (allow.length > 0) {
    lists.push(`const ALLOW_TOOLS: readonly string[] = ${tsStringArray(allow)};`);
    checks.push(
      `    if (ALLOW_TOOLS.includes(toolName)) return "not-applicable";`,
    );
  }
  const header = `/**
 * Per-tool approval policy. Connection tool names arrive QUALIFIED as
 * "${slug}__<tool>" (eve prefixes the connection slug), so the lists below
 * bake the qualified names at compile time.
 */
${lists.join("\n")}
`;
  const expression = `({ toolName }) => {
${checks.join("\n")}
    return ${fallbackStatus};
  }`;
  return { header, expression };
}

export function emitConnection(connection: ResolvedMcpConnection): string {
  const { slug, approval } = connection;

  let approvalImport = "";
  let approvalHeader = "";
  let approvalExpression: string;
  if (approval.mode === "custom") {
    const custom = customApprovalCode(slug, approval);
    approvalHeader = `\n${custom.header}`;
    approvalExpression = custom.expression;
  } else {
    approvalImport = `import { ${approval.mode} } from "eve/tools/approval";\n`;
    approvalExpression = `${approval.mode}()`;
  }

  let envImport = "";
  let authProperty = "";
  if (connection.auth.kind === "bearerToken") {
    envImport = `\nimport { requireEnv } from "../lib/env.js";\n`;
    authProperty = `
  auth: {
    // Lazy: probed per tool call, so keyless builds/boots never crash.
    getToken: async () => ({ token: requireEnv(${tsString(connectionTokenEnvVar(slug))}) }),
  },`;
  } else if (connection.auth.kind === "headers") {
    envImport = `\nimport { requireEnv } from "../lib/env.js";\n`;
    const entries = Object.entries(connection.auth.headers)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(
        ([header, envName]) =>
          `    ${tsString(header)}: requireEnv(${tsString(envName)}),`,
      );
    authProperty = `
  // Lazy callback: env vars are read per request, never at module load.
  headers: () => ({
${entries.join("\n")}
  }),`;
  }

  let toolsProperty = "";
  if (connection.tools !== undefined) {
    const filter =
      connection.tools.allow !== undefined
        ? `{ allow: ${tsStringArray(connection.tools.allow)} }`
        : `{ block: ${tsStringArray(connection.tools.block)} }`;
    toolsProperty = `\n  tools: ${filter},`;
  }

  return `${approvalImport}import { defineMcpClientConnection } from "eve/connections";
${envImport}${approvalHeader}
/** MCP connection "${slug}" (workflow CONTEXT pillar). */
export default defineMcpClientConnection({
  url: ${tsString(connection.url)},
  description: ${tsString(connection.description)},${authProperty}${toolsProperty}
  approval: ${approvalExpression},
});
`;
}
