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
 * time (exactly what a real model does): `{{connectionId:<slug>}}` /
 * `{{skillId:<slug>}}` / `{{agentId:<name>}}` in tool inputs, and
 * `{{toolResults}}` in a closing step's text — it echoes the
 * accepted/rejected outcomes the model was fed, which is how the edit spec
 * proves a dismissal really reached the model.
 *
 * WORKFLOW SURFACE (pipelines redesign): the toolset is `setTrigger` plus the
 * granular step mutations (`addStep`/`updateStep`/`removeStep`/`moveStep`)
 * and the two read tools (`searchConnectionTools`/`getConnectionTool`). Step
 * ids are minted SERVER-SIDE — scripts never carry an `id`, and a script
 * cannot reference a step it just added (the minted id only exists in the
 * tool result's text), so multi-step scaffolds insert each proposal at the
 * HEAD (`position: {after: null}`) in REVERSE execution order.
 */

// ── scaffold-a-pipeline conversation (workflow surface) ──────────────────────

/**
 * The custom stub-MCP connection the scaffold's tool step calls. The spec
 * creates it (support/authoring.ts `addCustomConnection`) and waits for its
 * probe before opening the copilot, so `{{connectionId:notes}}` resolves in
 * the prompt inventory and the proposed `save_note` call is verifiable.
 */
export const SCAFFOLD_CONNECTION = "notes";

export const SCAFFOLD_PROMPT = "Triage form submissions and save a note";

/** The tool step the scaffold proposes (the stub server's single MCP tool). */
export const SCAFFOLD_TOOL_STEP_NAME = "Save note";
/** The state step it proposes (persists the last sender across runs). */
export const SCAFFOLD_STATE_STEP_NAME = "Remember sender";

export const SCAFFOLD_CLOSING_TEXT =
  "Your pipeline is in place — a form trigger, the save_note call, and a state cursor. Publish when ready.";

const scaffoldScript = {
  match: "Triage form submissions",
  steps: [
    // 1) the trigger: a form collecting sender + message.
    {
      text: "Let's build this pipeline. First, a form trigger to collect submissions.",
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
    // 2) the doctrine's hard rule: search the tool catalog before proposing a
    //    tool step (server-executed READ tool — no proposal, no park).
    {
      toolCalls: [
        {
          toolName: "searchConnectionTools",
          input: { query: "note" },
        },
      ],
    },
    // 3+4) the steps, HEAD-inserted in reverse execution order (see module
    //      doc): final pipeline = [Save note (tool), Remember sender (state)].
    {
      toolCalls: [
        {
          toolName: "addStep",
          input: {
            step: {
              kind: "state",
              slug: "remember",
              name: "Remember sender",
              set: { last_email: { $ref: "trigger.email" } },
            },
            position: { after: null },
            rationale: "Persist the last sender so later runs can dedupe.",
          },
        },
      ],
    },
    {
      toolCalls: [
        {
          toolName: "addStep",
          input: {
            step: {
              kind: "tool",
              slug: "save",
              name: "Save note",
              connectionId: `{{connectionId:${SCAFFOLD_CONNECTION}}}`,
              tool: "save_note",
              args: { note: { $tpl: "Triage @trigger.email: @trigger.message" } },
              sideEffect: "at_least_once",
            },
            position: { after: null },
            rationale: "Deterministically save the rendered submission as a note.",
          },
        },
      ],
    },
    { text: SCAFFOLD_CLOSING_TEXT },
  ],
};

// ── edit-an-existing-pipeline conversation (workflow surface) ────────────────

export const EDIT_PROMPT =
  "Tighten the pipeline and gate sends behind approval";

/** The applied proposal: a new state step marking the approval gate. */
export const EDIT_ADDED_STEP_NAME = "Approval gate";

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
          toolName: "addStep",
          input: {
            step: {
              kind: "state",
              slug: "approval-gate",
              name: "Approval gate",
              // A literal write — no references, so it validates against any
              // trigger (the edit spec's base pipeline keeps Manual).
              set: { approved_only: true },
            },
            position: { after: null },
            rationale: "Record the approval stance where every run can read it.",
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
