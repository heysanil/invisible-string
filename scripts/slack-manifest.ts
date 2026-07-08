/**
 * Render the Slack app manifest for this deployment. Substitutes the public
 * origin into infra/slack/manifest.template.json and prints the result —
 * paste it into https://api.slack.com/apps → Create New App → From a manifest
 * (full walkthrough: docs/SLACK.md).
 *
 * Origin resolution mirrors the control plane's loadIntegrationsConfig:
 * --url flag → PUBLIC_APP_URL → BETTER_AUTH_URL → http://localhost:3000.
 * Run from the repo root (`bun run slack:manifest`) so Bun picks up .env.
 *
 *   bun run slack:manifest                       # origin from .env
 *   bun run slack:manifest --url https://app.example.com | pbcopy
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

const warn = (msg: string): void => console.error(`\x1b[33m⚠ ${msg}\x1b[0m`);

function resolveOrigin(): string {
  const flagIndex = process.argv.indexOf("--url");
  const fromFlag = flagIndex !== -1 ? process.argv[flagIndex + 1] : undefined;
  if (flagIndex !== -1 && !fromFlag) {
    console.error("✖ --url requires a value, e.g. --url https://app.example.com");
    process.exit(1);
  }
  const origin =
    fromFlag?.trim() ||
    process.env.PUBLIC_APP_URL?.trim() ||
    process.env.BETTER_AUTH_URL?.trim() ||
    "http://localhost:3000";
  return origin.replace(/\/+$/, "");
}

const origin = resolveOrigin();

// Slack must be able to reach the events endpoint and will only redirect
// OAuth to https — a localhost/http origin renders fine but won't verify.
if (/^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(origin)) {
  warn(`origin is ${origin} — Slack cannot reach it; use a tunnel or set PUBLIC_APP_URL (docs/SLACK.md §local dev)`);
} else if (!origin.startsWith("https://")) {
  warn(`origin is ${origin} — Slack requires https for OAuth redirects and event delivery`);
}

const templatePath = join(import.meta.dir, "..", "infra", "slack", "manifest.template.json");
const rendered = readFileSync(templatePath, "utf8").replaceAll("__PUBLIC_APP_URL__", origin);

// Round-trip through JSON.parse so a malformed template fails loudly here
// rather than as a cryptic error in Slack's manifest editor.
console.log(JSON.stringify(JSON.parse(rendered), null, 2));
