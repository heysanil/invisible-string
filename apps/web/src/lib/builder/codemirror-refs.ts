/**
 * CodeMirror 6 wiring for the instructions editor:
 * - `@` autocomplete sourced from the live draft (referenceOptions).
 * - inline decorations: resolved `@refs` render as ink-on-8%-black pills;
 *   unresolved refs get an amber underline (hover explains why).
 *
 * The reference sources change as the user edits other pillars, so both
 * facilities read from a `StateField` the React wrapper reconfigures via a
 * `StateEffect` — no editor teardown per keystroke.
 */
import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { RangeSetBuilder, StateEffect, StateField } from "@codemirror/state";
import {
  Decoration,
  EditorView,
  ViewPlugin,
  hoverTooltip,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import { parseReferences } from "@invisible-string/shared";

import {
  referenceOptions,
  referenceProblem,
  type ReferenceSources,
} from "./references";

// ── Live reference sources (StateField + reconfigure effect) ────────────────

const EMPTY_SOURCES: ReferenceSources = {
  trigger: { type: "manual" },
  connections: [],
  skills: [],
};

export const setReferenceSources = StateEffect.define<ReferenceSources>();

export const referenceSourcesField = StateField.define<ReferenceSources>({
  create: () => EMPTY_SOURCES,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (effect.is(setReferenceSources)) return effect.value;
    }
    return value;
  },
});

// ── @ autocomplete ──────────────────────────────────────────────────────────

/** Matches the `@…` token immediately left of the cursor (grammar-aligned). */
const AT_TOKEN = /@[A-Za-z][A-Za-z0-9_.-]*$|@$/;

function referenceCompletionSource(
  context: CompletionContext,
): CompletionResult | null {
  const match = context.matchBefore(AT_TOKEN);
  if (!match) return null;
  // Only auto-open once `@` is typed; explicit invoke (Ctrl-Space) also works.
  if (match.from === match.to && !context.explicit) return null;

  const sources = context.state.field(referenceSourcesField);
  const options: Completion[] = referenceOptions(sources).map((option) => ({
    label: option.label,
    detail: option.detail,
    info: option.info,
    type:
      option.kind === "trigger"
        ? "variable"
        : option.kind === "skill"
          ? "class"
          : "interface",
  }));

  if (options.length === 0) return null;
  return { from: match.from, options, validFor: /^@[A-Za-z0-9_.-]*$/ };
}

// ── Reference decorations (pills + amber underline) ─────────────────────────

const resolvedRefMark = Decoration.mark({ class: "cm-ref cm-ref-resolved" });
const unresolvedRefMark = Decoration.mark({
  class: "cm-ref cm-ref-unresolved",
});

function buildRefDecorations(view: EditorView): DecorationSet {
  const sources = view.state.field(referenceSourcesField);
  const text = view.state.doc.toString();
  const builder = new RangeSetBuilder<Decoration>();
  for (const ref of parseReferences(text)) {
    const unresolved = referenceProblem(ref, sources) !== null;
    builder.add(
      ref.start,
      ref.end,
      unresolved ? unresolvedRefMark : resolvedRefMark,
    );
  }
  return builder.finish();
}

const referenceDecorations = ViewPlugin.fromClass(
  class {
    decorations: DecorationSet;
    constructor(view: EditorView) {
      this.decorations = buildRefDecorations(view);
    }
    update(update: ViewUpdate) {
      if (
        update.docChanged ||
        update.startState.field(referenceSourcesField) !==
          update.state.field(referenceSourcesField)
      ) {
        this.decorations = buildRefDecorations(update.view);
      }
    }
  },
  { decorations: (plugin) => plugin.decorations },
);

// ── Hover tooltip for unresolved refs ───────────────────────────────────────

const referenceHover = hoverTooltip((view, pos) => {
  const sources = view.state.field(referenceSourcesField);
  const text = view.state.doc.toString();
  for (const ref of parseReferences(text)) {
    if (pos < ref.start || pos > ref.end) continue;
    const reason = referenceProblem(ref, sources);
    if (reason === null) return null;
    return {
      pos: ref.start,
      end: ref.end,
      above: true,
      create() {
        const dom = document.createElement("div");
        dom.className = "cm-ref-tooltip";
        dom.textContent = reason;
        return { dom };
      },
    };
  }
  return null;
});

/** The full `@reference` extension bundle for the instructions editor. */
export function referenceExtensions() {
  return [
    referenceSourcesField,
    autocompletion({ override: [referenceCompletionSource] }),
    referenceDecorations,
    referenceHover,
  ];
}
