/**
 * The scripted fake-LLM conversations the copilot E2E specs drive
 * (COPILOT_FAKE_SCRIPT, keyed format — see control-plane
 * copilot/transport.ts `createKeyedScriptedTransport`).
 *
 * Scripts are keyed by a substring of the user message and are STATELESS on
 * the server (step = round-trips completed this turn, derived from the
 * conversation), so every spec — and repeated runs against a reused stack —
 * replays deterministically from this one env var. The copilot is
 * surface-aware (workflow vs agent editor); the keyed fake needs no surface
 * plumbing because each conversation's match string is unique.
 *
 * Placeholders resolve against the inventory in the system prompt at call
 * time (exactly what a real model does): `{{agentId:<name>}}` for the
 * workflow surface's agent inventory (how the scaffold script can select the
 * seeded "General Purpose" agent whose id only exists at runtime), and
 * `{{connectionId:<slug>}}` / `{{skillId:<slug>}}` for the agent surface's
 * context inventory. `{{toolResults}}` in a closing step echoes the
 * accepted/rejected outcomes the model was told — the edit spec asserts on
 * that text to prove a dismissal really reached the model.
 */

/**
 * The seeded agent every workspace auto-publishes on creation — the scaffold
 * script delegates to it by name.
 */
export const SCAFFOLD_AGENT_NAME = "General Purpose";

// ── scaffold-from-one-liner conversation (workflow surface) ──────────────────

export const SCAFFOLD_PROMPT = "Triage form submissions and draft replies";

/**
 * References only `@trigger.*` paths — the seeded agent's published context
 * is empty, so `@connection`/`@skill` refs would fail the workflow validator.
 * The todo directive makes the scaffolded workflow's run drive a real
 * streamed tool step under eve's mock model.
 */
export const SCAFFOLD_INSTRUCTIONS_MARKDOWN = [
  "Triage each form submission and draft a reply.",
  "",
  "1. Read the message from @trigger.message and note the sender @trigger.email.",
  "2. Make a todo list of the triage steps, then summarize the plan.",
  "3. Draft a concise, friendly reply for review.",
].join("\n");

export const SCAFFOLD_CLOSING_TEXT =
  "Your workflow is scaffolded — trigger, agent and instructions are in place. Publish when ready.";

const scaffoldScript = {
  match: "Triage form submissions",
  steps: [
    {
      text: "Let's scaffold this delegation. First, a form trigger to collect submissions.",
      toolCalls: [
        {
          toolName: "setTrigger",
          input: {
            trigger: {
              type: "form",
              fields: [
                {
                  key: "email",
                  label: "Customer email",
                  type: "text",
                  required: true,
                },
                {
                  key: "message",
                  label: "Message",
                  type: "textarea",
                  required: true,
                },
              ],
            },
            rationale: "Collect each submission's sender and message.",
          },
        },
      ],
    },
    {
      toolCalls: [
        {
          toolName: "setAgent",
          input: {
            agentId: `{{agentId:${SCAFFOLD_AGENT_NAME}}}`,
            rationale: "Delegate the triage to the published General Purpose agent.",
          },
        },
      ],
    },
    {
      toolCalls: [
        {
          toolName: "setInstructions",
          input: {
            markdown: SCAFFOLD_INSTRUCTIONS_MARKDOWN,
            rationale: "Reference the form fields in the task instructions.",
          },
        },
      ],
    },
    { text: SCAFFOLD_CLOSING_TEXT },
  ],
};

// ── edit-an-existing-workflow conversation (workflow surface) ────────────────

export const EDIT_PROMPT =
  "Tighten the instructions and gate sends behind approval";

export const EDIT_BASE_INSTRUCTIONS =
  "Reply politely to every customer request.";

export const EDIT_INSTRUCTIONS_MARKDOWN = [
  EDIT_BASE_INSTRUCTIONS,
  "",
  "Always hold outbound sends for an explicit approval before they go out.",
].join("\n");

/** The dismissed proposal: a schedule trigger the user does NOT want. */
export const EDIT_DISMISSED_CRON = "0 9 * * 1";

export const EDIT_CLOSING_PREFIX = "Noted. Outcomes — ";

const editScript = {
  match: "gate sends behind approval",
  steps: [
    {
      text: "Two suggestions for this.",
      toolCalls: [
        {
          toolName: "setInstructions",
          input: {
            markdown: EDIT_INSTRUCTIONS_MARKDOWN,
            rationale: "Make the approval gate explicit in the instructions.",
          },
        },
        {
          toolName: "setTrigger",
          input: {
            trigger: { type: "schedule", cron: EDIT_DISMISSED_CRON },
            rationale: "Batch sends into a weekly reviewed schedule.",
          },
        },
      ],
    },
    { text: `${EDIT_CLOSING_PREFIX}{{toolResults}}` },
  ],
};

// ── persona conversation (agent surface) ─────────────────────────────────────

export const PERSONA_PROMPT = "Draft a persona for a support triage specialist";

export const PERSONA_MARKDOWN = [
  "You are a support triage specialist.",
  "",
  "- Read every inbound request carefully and classify its urgency.",
  "- Draft warm, concise replies in plain language.",
  "- Escalate anything irreversible to a human before acting.",
].join("\n");

export const PERSONA_CLOSING_TEXT =
  "Persona drafted — review the diff and apply it if it reads right.";

const personaScript = {
  match: "persona for a support triage specialist",
  steps: [
    {
      text: "Here's a first draft of who this agent is.",
      toolCalls: [
        {
          toolName: "setPersona",
          input: {
            markdown: PERSONA_MARKDOWN,
            rationale: "A focused triage identity with an escalation guardrail.",
          },
        },
      ],
    },
    { text: PERSONA_CLOSING_TEXT },
  ],
};

/** COPILOT_FAKE_SCRIPT value for the E2E control-plane process. */
export const COPILOT_FAKE_SCRIPT_JSON = JSON.stringify([
  scaffoldScript,
  editScript,
  personaScript,
]);
