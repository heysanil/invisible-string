/**
 * Copilot surface adapter — the seam that lets ONE dock (components/copilot/
 * CopilotDock) serve two editors. The dock owns everything surface-agnostic
 * (socket lifecycle, thread, announcer, focus choreography); an adapter owns
 * everything surface-specific: which entity the frames are about, how to read
 * the live draft, how to apply an accepted proposal through the surface's
 * controller (single writer), and how a proposal is presented on its card.
 *
 * Factories: `workflowCopilotAdapter` (mutations.ts) and
 * `agentCopilotAdapter` (agent-mutations.ts).
 */
import type { ComponentType } from "react";
import type {
  CopilotAgentIdentity,
  CopilotProposal,
  CopilotSurface,
} from "@invisible-string/shared";

/** Frame routing — every `user_message` names the surface + entity it edits. */
export interface CopilotEntityRef {
  surface: CopilotSurface;
  /** Workflow or agent row id (per `surface`). */
  entityId: string;
}

/**
 * What applying a proposal produced.
 *
 * `void`/`true` — applied. `false` — it FAILED and the card must say so:
 * some proposals do not land in the editor reducer but in a network write
 * (the agent rename PATCHes `agents.name`), and a card that prints "Applied"
 * over a failed write is a receipt for something that never happened.
 * Promises are awaited before the card settles and before the server is told
 * the outcome.
 */
export type ApplyProposalResult =
  | void
  | boolean
  | Promise<void | boolean>;

/**
 * One suggestion card's presentation, precomputed by the adapter from a
 * proposal + the CURRENT draft. `diff` (full-text DiffView preview) wins over
 * the compact `before → after` row when both could apply.
 */
export interface ProposalDescription {
  /** Section badge icon (lucide component). */
  icon: ComponentType<{ size?: number }>;
  title: string;
  /** Compact before → after strings; both null = no compact preview. */
  before: string | null;
  after: string | null;
  /** Full-text diff preview (rendered with DiffView). */
  diff?: { before: string; after: string };
}

/** Empty-thread copy (icon + chips come from the dock / `promptChips`). */
export interface CopilotEmptyStateCopy {
  title: string;
  description: string;
}

export interface CopilotSurfaceAdapter<
  TDraft extends Record<string, unknown> = Record<string, unknown>,
> {
  entityRef: CopilotEntityRef;
  /** Read the LIVE draft (sent with every user message) — must never go stale. */
  getDraft: () => TDraft;
  /**
   * Read the LIVE row identity for surfaces that have one (the agent's name +
   * description are `agents` COLUMNS, not part of the compiled draft). Sent
   * alongside the draft on every user message so the copilot can answer "what
   * is this agent called?" and so the server's "you already proposed exactly
   * this" guards have a baseline — see `copilotAgentIdentitySchema`
   * (packages/shared) for the wire contract and its precedence rule.
   *
   * Absent on the workflow surface, which has no such columns.
   */
  getIdentity?: () => CopilotAgentIdentity | null;
  /**
   * Apply an accepted proposal through the surface controller's dispatch
   * (the same path manual edits take, so autosave/dirty state just work).
   * Off-surface proposals (a server bug) are ignored.
   *
   * See {@link ApplyProposalResult}: an adapter whose application can FAIL
   * must report it, and may resolve asynchronously.
   */
  applyProposal: (proposal: CopilotProposal) => ApplyProposalResult;
  /** Card presentation for a proposal against the CURRENT draft. */
  describeProposal: (proposal: CopilotProposal) => ProposalDescription;
  emptyStateCopy: CopilotEmptyStateCopy;
  /** Empty-state prompt chips, derived from the live draft (via `getDraft`). */
  promptChips: () => readonly string[];
}
