/**
 * The editor's three save states (spec D3) and new-agent auto-numbering
 * (spec D1's web half) — both pure, both easy to get subtly wrong.
 */
import { expect, test } from "bun:test";
import type { AgentDefinition } from "@invisible-string/shared";

import {
  agentLifecycleState,
  canonicalJson,
  definitionsEquivalent,
  publishedAgentName,
  renamedSincePublish,
} from "../lib/agents/lifecycle";
import { nextUntitledAgentName } from "../lib/agents/naming";

const SAVED: AgentDefinition = {
  persona: "Be helpful.",
  model: { preset: "balanced", modelId: "deepseek/deepseek-v4-pro" },
  context: {
    mcpConnectionIds: ["cn_aaaaaaaaaaaaaaaa", "cn_bbbbbbbbbbbbbbbb"],
    skillIds: [],
  },
};

// ── the three states ────────────────────────────────────────────────────────

test("an unsaved edit outranks everything else", () => {
  expect(
    agentLifecycleState({
      hasUnsavedChanges: true,
      savedDefinition: SAVED,
      publishedDefinition: SAVED,
    }),
  ).toBe("unsaved");

  // …including on a never-published agent.
  expect(
    agentLifecycleState({
      hasUnsavedChanges: true,
      savedDefinition: SAVED,
      publishedDefinition: null,
    }),
  ).toBe("unsaved");
});

test("a NEVER-published agent reads Draft, never 'unpublished changes'", () => {
  expect(
    agentLifecycleState({
      hasUnsavedChanges: false,
      savedDefinition: SAVED,
      publishedDefinition: null,
    }),
  ).toBe("draft");
});

test("saved and matching the published version reads Published", () => {
  expect(
    agentLifecycleState({
      hasUnsavedChanges: false,
      savedDefinition: SAVED,
      publishedDefinition: SAVED,
    }),
  ).toBe("published");
});

test("saved but AHEAD of the published version reads Unpublished changes", () => {
  expect(
    agentLifecycleState({
      hasUnsavedChanges: false,
      savedDefinition: SAVED,
      publishedDefinition: { ...SAVED, persona: "An older persona." },
    }),
  ).toBe("unpublished");

  // A context change counts too — this is the state that used to be invisible.
  expect(
    agentLifecycleState({
      hasUnsavedChanges: false,
      savedDefinition: SAVED,
      publishedDefinition: {
        ...SAVED,
        context: { mcpConnectionIds: [], skillIds: [] },
      },
    }),
  ).toBe("unpublished");
});

test("key ORDER does not fake a publish gap", () => {
  // The published definition comes back from postgres jsonb, the saved one
  // from the reducer — the two producers order keys differently, so a plain
  // JSON.stringify comparison would report drift on identical content, on
  // every render, forever.
  const reordered = {
    context: SAVED.context,
    model: { modelId: SAVED.model.modelId, preset: SAVED.model.preset },
    persona: SAVED.persona,
  };
  expect(
    agentLifecycleState({
      hasUnsavedChanges: false,
      savedDefinition: SAVED,
      publishedDefinition: reordered,
    }),
  ).toBe("published");
});

test("array order still counts — reordering connections IS a change", () => {
  expect(
    agentLifecycleState({
      hasUnsavedChanges: false,
      savedDefinition: SAVED,
      publishedDefinition: {
        ...SAVED,
        context: {
          mcpConnectionIds: ["cn_bbbbbbbbbbbbbbbb", "cn_aaaaaaaaaaaaaaaa"],
          skillIds: [],
        },
      },
    }),
  ).toBe("unpublished");
});

test("an UNPARSEABLE published definition never cries 'unpublished'", () => {
  // Written by a newer server than this client understands: it proves nothing
  // about drift, so the honest answer is the resting state.
  expect(
    agentLifecycleState({
      hasUnsavedChanges: false,
      savedDefinition: SAVED,
      publishedDefinition: { persona: 42 },
    }),
  ).toBe("published");
});

// ── the name is a publish input too (D1 kept agentSlug in the hash) ─────────

test("a RENAME of a published agent reads Unpublished changes", () => {
  // The definition did not move, so neither baseline did — but the display
  // name is still hashed (as its slug) and still lands in the emitted bytes,
  // so the live artifact introduces itself by the old name until republished.
  // Reading "Published" over that is exactly the lie D3 exists to end.
  expect(
    agentLifecycleState({
      hasUnsavedChanges: false,
      savedDefinition: SAVED,
      publishedDefinition: SAVED,
      currentName: "Inbox triage",
      publishedName: "Untitled agent",
    }),
  ).toBe("unpublished");

  // Same name ⇒ still Published.
  expect(
    agentLifecycleState({
      hasUnsavedChanges: false,
      savedDefinition: SAVED,
      publishedDefinition: SAVED,
      currentName: "Untitled agent",
      publishedName: "Untitled agent",
    }),
  ).toBe("published");
});

test("a rename the compiler cannot see is not drift", () => {
  // The hash carries the SLUG, so casing and punctuation that slugify the
  // same change no emitted byte — flagging them would nag about nothing.
  expect(renamedSincePublish("Inbox Triage!", "inbox-triage")).toBe(false);
  expect(renamedSincePublish("Inbox triage", "Inbox triages")).toBe(true);
  // Names that slugify to nothing both fall back to the compiler's "agent".
  expect(renamedSincePublish("!!!", "???")).toBe(false);
});

test("an UNKNOWN published name never claims drift", () => {
  // The server does not serve the baseline yet; absence is not evidence, and
  // an "Unpublished changes" chip that can never be cleared is worse than the
  // gap it would close.
  expect(renamedSincePublish("Inbox triage", undefined)).toBe(false);
  expect(renamedSincePublish("Inbox triage", null)).toBe(false);
  expect(renamedSincePublish(undefined, "Untitled agent")).toBe(false);
  expect(
    agentLifecycleState({
      hasUnsavedChanges: false,
      savedDefinition: SAVED,
      publishedDefinition: SAVED,
      currentName: "Inbox triage",
    }),
  ).toBe("published");
});

test("publishedAgentName reads the DTO field when it exists, undefined when it does not", () => {
  const agent = { id: "a1", name: "Inbox triage" } as unknown as Parameters<
    typeof publishedAgentName
  >[0];
  expect(publishedAgentName(agent)).toBeUndefined();
  expect(
    publishedAgentName({ ...agent, publishedName: "Untitled agent" } as never),
  ).toBe("Untitled agent");
});

test("canonicalJson sorts keys, drops undefined, and keeps arrays ordered", () => {
  expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  expect(canonicalJson({ a: 1, b: undefined })).toBe('{"a":1}');
  expect(canonicalJson([2, 1])).toBe("[2,1]");
  expect(canonicalJson(null)).toBe("null");
  expect(
    definitionsEquivalent(SAVED, { ...SAVED, model: { ...SAVED.model } }),
  ).toBe(true);
});

// ── auto-numbering ──────────────────────────────────────────────────────────

test("the first untitled agent takes the bare name", () => {
  expect(nextUntitledAgentName([])).toBe("Untitled agent");
  expect(nextUntitledAgentName([{ name: "Executive assistant" }])).toBe(
    "Untitled agent",
  );
});

test("subsequent untitled agents are numbered from the HIGHEST in use", () => {
  expect(nextUntitledAgentName([{ name: "Untitled agent" }])).toBe(
    "Untitled agent 2",
  );
  expect(
    nextUntitledAgentName([
      { name: "Untitled agent" },
      { name: "Untitled agent 2" },
      { name: "Untitled agent 3" },
    ]),
  ).toBe("Untitled agent 4");

  // Gaps are NOT filled: deleting #2 must not hand the next agent a name the
  // user just watched disappear.
  expect(
    nextUntitledAgentName([
      { name: "Untitled agent" },
      { name: "Untitled agent 3" },
    ]),
  ).toBe("Untitled agent 4");
});

test("numbering tolerates the casing and spacing a rename can introduce", () => {
  expect(
    nextUntitledAgentName([{ name: "  untitled   agent 7 " }]),
  ).toBe("Untitled agent 8");
  // Names that merely start with the base are not part of the series.
  expect(
    nextUntitledAgentName([{ name: "Untitled agent for billing" }]),
  ).toBe("Untitled agent");
});
