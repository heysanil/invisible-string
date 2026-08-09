/**
 * The glass capsule toolbar for the document-tier editors.
 *
 * Markdown input rules stay on underneath, so the toolbar is for discovery,
 * not for speed — someone who knows `## ` never needs it. Active-mark state
 * comes from `useEditorState` with a selector so a keystroke only re-renders
 * this row when a mark or block type actually flips, rather than on every
 * transaction.
 */
import { useEditorState, type Editor } from "@tiptap/react";
import {
  Bold,
  Code,
  Heading2,
  Italic,
  Link2,
  List,
  ListOrdered,
  Quote,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { cn } from "../../lib/cn";

interface ToolbarAction {
  key: string;
  icon: LucideIcon;
  label: string;
  run: (editor: Editor) => void;
  isActive: (editor: Editor) => boolean;
}

const ACTIONS: readonly ToolbarAction[][] = [
  [
    {
      key: "bold",
      icon: Bold,
      label: "Bold",
      run: (e) => e.chain().focus().toggleBold().run(),
      isActive: (e) => e.isActive("bold"),
    },
    {
      key: "italic",
      icon: Italic,
      label: "Italic",
      run: (e) => e.chain().focus().toggleItalic().run(),
      isActive: (e) => e.isActive("italic"),
    },
    {
      key: "code",
      icon: Code,
      label: "Inline code",
      run: (e) => e.chain().focus().toggleCode().run(),
      isActive: (e) => e.isActive("code"),
    },
  ],
  [
    {
      key: "heading",
      icon: Heading2,
      label: "Heading",
      run: (e) => e.chain().focus().toggleHeading({ level: 2 }).run(),
      isActive: (e) => e.isActive("heading", { level: 2 }),
    },
    {
      key: "bulletList",
      icon: List,
      label: "Bullet list",
      run: (e) => e.chain().focus().toggleBulletList().run(),
      isActive: (e) => e.isActive("bulletList"),
    },
    {
      key: "orderedList",
      icon: ListOrdered,
      label: "Numbered list",
      run: (e) => e.chain().focus().toggleOrderedList().run(),
      isActive: (e) => e.isActive("orderedList"),
    },
  ],
  [
    {
      key: "blockquote",
      icon: Quote,
      label: "Quote",
      run: (e) => e.chain().focus().toggleBlockquote().run(),
      isActive: (e) => e.isActive("blockquote"),
    },
    {
      key: "codeBlock",
      icon: Link2,
      label: "Code block",
      run: (e) => e.chain().focus().toggleCodeBlock().run(),
      isActive: (e) => e.isActive("codeBlock"),
    },
  ],
];

const FLAT = ACTIONS.flat();

export interface EditorToolbarProps {
  editor: Editor;
  /** Rendered at the trailing edge — the Rich/Markdown toggle slot. */
  trailing?: React.ReactNode;
}

export function EditorToolbar({ editor, trailing }: EditorToolbarProps) {
  const active = useEditorState({
    editor,
    selector: ({ editor: instance }) =>
      FLAT.map((action) => action.isActive(instance)).join(","),
  });
  const activeFlags = (active ?? "").split(",");

  return (
    <div className="tt-toolbar" role="toolbar" aria-label="Formatting">
      {ACTIONS.map((group, groupIndex) => (
        <div className="tt-toolbar-group" key={group[0]?.key ?? groupIndex}>
          {group.map((action) => {
            const Icon = action.icon;
            const isActive = activeFlags[FLAT.indexOf(action)] === "true";
            return (
              <button
                key={action.key}
                type="button"
                // Keeps focus in the document so the command applies to the
                // live selection instead of a collapsed one.
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => action.run(editor)}
                aria-label={action.label}
                aria-pressed={isActive}
                title={action.label}
                className={cn("tt-toolbar-button", isActive && "is-active")}
              >
                <Icon size={15} aria-hidden="true" />
              </button>
            );
          })}
        </div>
      ))}
      {trailing ? <div className="tt-toolbar-trailing">{trailing}</div> : null}
    </div>
  );
}
