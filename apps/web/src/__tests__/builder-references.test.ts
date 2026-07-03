/**
 * @ autocomplete token source + unresolved-reference detection. Every emitted
 * option label must round-trip through the shared parseReferences grammar to
 * exactly one reference of the intended kind (the editor inserts these
 * verbatim, the compiler parses them at publish — they must agree).
 */
import { expect, test } from "bun:test";
import { parseReferences, type TriggerConfig } from "@invisible-string/shared";

import {
  referenceOptions,
  referenceProblem,
  slugifyName,
  unresolvedReferences,
  type ReferenceSources,
} from "../lib/builder/references";

const formTrigger: TriggerConfig = {
  type: "form",
  fields: [
    { key: "email", label: "Email", type: "text", required: true },
    { key: "topic", label: "Topic", type: "text", required: false },
  ],
};

const sources: ReferenceSources = {
  trigger: formTrigger,
  connections: [
    { name: "Linear", description: "Issue tracker" },
    { name: "Google Drive" },
  ],
  skills: [{ name: "Release Notes", description: "Draft notes" }],
};

test("referenceOptions emits trigger fields, connection slugs, skill slugs", () => {
  const options = referenceOptions(sources);
  const labels = options.map((o) => o.label);
  expect(labels).toEqual([
    "@trigger.email",
    "@trigger.topic",
    "@linear",
    "@google-drive",
    "@skill.release-notes",
  ]);
});

test("every emitted option parses back to one reference of its kind", () => {
  for (const option of referenceOptions(sources)) {
    const refs = parseReferences(option.label);
    expect(refs.length).toBe(1);
    expect(refs[0]!.kind).toBe(option.kind);
  }
});

test("connection slug matches the compiler's slugify (kebab, trimmed)", () => {
  expect(slugifyName("Google Drive")).toBe("google-drive");
  expect(slugifyName("  Weird__Name!! ")).toBe("weird-name");
  expect(slugifyName("linear")).toBe("linear");
});

test("manual triggers contribute no @trigger options (no dispatch data)", () => {
  const manual = referenceOptions({ ...sources, trigger: { type: "manual" } });
  expect(manual.some((o) => o.kind === "trigger")).toBe(false);
});

test("slack triggers offer the adapter's FIXED data keys", () => {
  const slack = referenceOptions({
    ...sources,
    trigger: {
      type: "slack",
      binding: { mentionOnly: true, includeDirectMessages: false },
    },
  });
  const labels = slack.filter((o) => o.kind === "trigger").map((o) => o.label);
  expect(labels).toEqual([
    "@trigger.text",
    "@trigger.user",
    "@trigger.channel",
    "@trigger.ts",
    "@trigger.thread_ts",
    "@trigger.team",
    "@trigger.eventType",
    "@trigger.channelType",
  ]);
  // Each parses back as a trigger reference (grammar agreement).
  for (const label of labels) {
    const refs = parseReferences(label);
    expect(refs.length).toBe(1);
    expect(refs[0]!.kind).toBe("trigger");
  }
});

test("webhook triggers offer the documented @trigger.message convention", () => {
  const webhook = referenceOptions({ ...sources, trigger: { type: "webhook" } });
  const labels = webhook.filter((o) => o.kind === "trigger").map((o) => o.label);
  expect(labels).toEqual(["@trigger.message"]);
});

test("resources whose names slugify to empty are omitted", () => {
  const options = referenceOptions({
    ...sources,
    connections: [{ name: "!!!" }, { name: "OK" }],
  });
  expect(options.filter((o) => o.kind === "connection").map((o) => o.label)).toEqual(
    ["@ok"],
  );
});

test("referenceProblem: resolved refs return null", () => {
  for (const raw of ["@trigger.email", "@linear", "@skill.release-notes"]) {
    const ref = parseReferences(raw)[0]!;
    expect(referenceProblem(ref, sources)).toBeNull();
  }
});

test("referenceProblem: unknown field / connection / skill / bare are flagged", () => {
  const unknownField = parseReferences("@trigger.nope")[0]!;
  expect(referenceProblem(unknownField, sources)).toContain('keyed "nope"');

  const bareTrigger = parseReferences("@trigger")[0]!;
  expect(referenceProblem(bareTrigger, sources)).toContain("Bare @trigger");

  const unknownConn = parseReferences("@github")[0]!;
  expect(referenceProblem(unknownConn, sources)).toContain("No attached connection");

  const unknownSkill = parseReferences("@skill.missing")[0]!;
  expect(referenceProblem(unknownSkill, sources)).toContain("No attached skill");
});

test("@trigger.* against a manual trigger is flagged (no dispatch data)", () => {
  const ref = parseReferences("@trigger.email")[0]!;
  expect(
    referenceProblem(ref, { ...sources, trigger: { type: "manual" } }),
  ).toContain("no dispatch data");
});

test("unresolvedReferences returns only the failing refs, in order", () => {
  const markdown = "Use @trigger.email and @github then @skill.release-notes.";
  const problems = unresolvedReferences(markdown, sources);
  expect(problems.map((p) => p.ref.raw)).toEqual(["@github"]);
});
