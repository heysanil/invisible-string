/**
 * The scripted fake-LLM conversation the copilot E2E specs drive
 * (COPILOT_FAKE_SCRIPT, keyed format — see control-plane
 * copilot/transport.ts `createKeyedScriptedTransport`).
 *
 * Scripts are keyed by a substring of the user message and are STATELESS on
 * the server (step = round-trips completed this turn, derived from the
 * conversation), so both specs — and repeated runs against a reused stack —
 * replay deterministically from this one env var.
 *
 * The `{{connectionId:<slug>}}` placeholder resolves against the workspace
 * inventory in the system prompt at call time (exactly what a real model
 * does), which is how the script can reference a connection the spec only
 * creates at runtime. `{{toolResults}}` in the closing step echoes the
 * accepted/rejected outcomes the model was told — the spec asserts on that
 * text to prove a dismissal really reached the model.
 */

/** Connection the scaffold spec seeds; the script attaches it by slug. */
export const SCAFFOLD_CONNECTION_NAME = "notes";

// ── scaffold-from-one-liner conversation ─────────────────────────────────────

export const SCAFFOLD_PROMPT = "Triage form submissions and draft replies";

export const SCAFFOLD_INSTRUCTIONS_MARKDOWN = [
  "Triage each form submission and draft a reply.",
  "",
  "1. Read the message from @trigger.message and note the sender @trigger.email.",
  "2. Check @notes for related past notes before answering.",
  "3. Draft a concise, friendly reply for review.",
].join("\n");

export const SCAFFOLD_CLOSING_TEXT =
  "Your workflow is scaffolded — trigger, context and instructions are in place. Publish when ready.";

const scaffoldScript = {
  match: "Triage form submissions",
  steps: [
    {
      text: "Let's scaffold this. First, a form trigger to collect submissions.",
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
          toolName: "addContext",
          input: {
            kind: "connection",
            id: `{{connectionId:${SCAFFOLD_CONNECTION_NAME}}}`,
            rationale: "Attach the notes connection for past context.",
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
            rationale: "Reference the form fields and the notes connection.",
          },
        },
      ],
    },
    { text: SCAFFOLD_CLOSING_TEXT },
  ],
};

// ── edit-an-existing-workflow conversation ───────────────────────────────────

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

/** COPILOT_FAKE_SCRIPT value for the E2E control-plane process. */
export const COPILOT_FAKE_SCRIPT_JSON = JSON.stringify([
  scaffoldScript,
  editScript,
]);
