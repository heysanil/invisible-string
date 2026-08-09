/**
 * Live resolved/unresolved status for `@reference` chips.
 *
 * The reference sources change while the editor stays mounted — the author
 * attaches a connection in Context, renames a form field, switches the trigger
 * type — so the sources cannot be a construction-time option. They live in
 * ProseMirror plugin state and arrive through a meta-only transaction, exactly
 * as the CodeMirror implementation this replaces used a `StateField` plus a
 * `StateEffect` (lib/builder/codemirror-refs.ts). No editor teardown, no lost
 * caret, no re-parse.
 *
 * The same state feeds the `@` menu (reference.ts reads it in `items`) and the
 * decorations below, so the two can never disagree about what resolves.
 */
import { parseReferences } from "@invisible-string/shared";
import type { Editor } from "@tiptap/core";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { Plugin, PluginKey, type EditorState } from "@tiptap/pm/state";
import { Decoration, DecorationSet } from "@tiptap/pm/view";

import { referenceProblem, type ReferenceSources } from "../builder/references";

/** Nothing attached, no dispatch data — every reference is unresolved. */
export const EMPTY_REFERENCE_SOURCES: ReferenceSources = {
  trigger: { type: "manual" },
  connections: [],
  skills: [],
};

interface ReferenceStatusState {
  sources: ReferenceSources;
  decorations: DecorationSet;
}

export const referenceStatusPluginKey = new PluginKey<ReferenceStatusState>(
  "referenceStatus",
);

/** The sources currently driving decorations and the `@` menu. */
export function referenceSourcesFrom(state: EditorState): ReferenceSources {
  return referenceStatusPluginKey.getState(state)?.sources ?? EMPTY_REFERENCE_SOURCES;
}

/**
 * Push new sources into a live editor. Meta-only and outside history: this is
 * not an edit, and an undo must never step back through a Context change.
 */
export function setReferenceSources(
  editor: Editor,
  sources: ReferenceSources,
): void {
  const { view } = editor;
  view.dispatch(
    view.state.tr
      .setMeta(referenceStatusPluginKey, sources)
      .setMeta("addToHistory", false),
  );
}

/**
 * Why a chip's token would fail to compile against `sources`, or null when it
 * resolves. Goes through `parseReferences` rather than reading `attrs.kind` so
 * the verdict comes from the same grammar the compiler uses — a chip whose raw
 * text no longer parses cleanly is itself the problem.
 */
export function referenceNodeProblem(
  raw: string,
  sources: ReferenceSources,
): string | null {
  const parsed = parseReferences(raw);
  const ref = parsed[0];
  if (parsed.length !== 1 || ref === undefined || ref.raw !== raw) {
    return `"${raw}" is not a reference — @name, @trigger.<path> or @skill.<slug>.`;
  }
  return referenceProblem(ref, sources);
}

function buildDecorations(
  doc: ProseMirrorNode,
  sources: ReferenceSources,
  nodeName: string,
): DecorationSet {
  const decorations: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== nodeName) return true;
    const raw = typeof node.attrs.raw === "string" ? node.attrs.raw : "";
    const reason = referenceNodeProblem(raw, sources);
    decorations.push(
      Decoration.node(
        pos,
        pos + node.nodeSize,
        reason === null
          ? { class: "tt-ref-resolved" }
          : // `title` stands in for the CodeMirror hover tooltip: the reason a
            // ref is amber must be reachable, and the amber alone is not it.
            { class: "tt-ref-unresolved", title: reason },
      ),
    );
    return false;
  });
  return DecorationSet.create(doc, decorations);
}

/**
 * The plugin. Decorations are cached in plugin state and rebuilt only when the
 * document or the sources actually change — `props.decorations` runs on every
 * transaction, including selection moves.
 */
export function referenceStatusPlugin({
  nodeName,
}: {
  nodeName: string;
}): Plugin<ReferenceStatusState> {
  return new Plugin<ReferenceStatusState>({
    key: referenceStatusPluginKey,
    state: {
      init: (_config, state) => ({
        sources: EMPTY_REFERENCE_SOURCES,
        decorations: buildDecorations(state.doc, EMPTY_REFERENCE_SOURCES, nodeName),
      }),
      apply: (tr, value, _oldState, newState) => {
        const pushed = tr.getMeta(referenceStatusPluginKey) as
          | ReferenceSources
          | undefined;
        if (pushed === undefined && !tr.docChanged) return value;
        const sources = pushed ?? value.sources;
        return {
          sources,
          decorations: buildDecorations(newState.doc, sources, nodeName),
        };
      },
    },
    props: {
      decorations: (state) => referenceStatusPluginKey.getState(state)?.decorations,
    },
  });
}
