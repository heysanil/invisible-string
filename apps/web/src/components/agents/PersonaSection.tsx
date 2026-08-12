/**
 * PERSONA section: the card-grid one-liner (description) plus the persona /
 * root instructions in a real markdown editor — this document IS the agent,
 * so it gets the rich editor rather than a bare textarea.
 *
 * The description stays a plain `Input` on purpose: it is routing metadata
 * rendered raw in the agents grid and the chat's agent picker, so markdown
 * there would leak literal asterisks into list views. It is also the field
 * the copilot's `setDescription` tool writes (spec D7.4) — the ceiling below
 * is the copilot's, deliberately, so a human and the copilot cannot disagree
 * about how long "one line" is.
 */
import { COPILOT_MAX_DESCRIPTION_CHARS } from "@invisible-string/shared";

import { Input } from "../ui/Input";
import { DOCUMENT_EXTENSIONS } from "../../lib/editor/profiles";
import { MarkdownDocumentEditor } from "../editor/MarkdownDocumentEditor";

/**
 * Advisory ceiling shown in the counter. NOT enforced anywhere — there is no
 * `.max()` on `agentDefinitionSchema.persona`, no column limit (it lives in a
 * jsonb draft) and no server check. The only real bounds are the copilot's
 * `COPILOT_MAX_DRAFT_CHARS` (131 072, on the serialized draft) and the 8 MiB
 * request-body cap.
 */
export const PERSONA_MAX = 50_000;
/** Soft advice threshold — personas read best under this. */
export const PERSONA_ADVICE = 1_500;

export interface PersonaSectionProps {
  description: string | null;
  persona: string;
  onChangeDescription: (description: string) => void;
  onChangePersona: (markdown: string) => void;
}

export function PersonaSection({
  description,
  persona,
  onChangeDescription,
  onChangePersona,
}: PersonaSectionProps) {
  const personaLength = persona.length;
  return (
    <div className="flex flex-col gap-4">
      <Input
        label="Description"
        value={description ?? ""}
        maxLength={COPILOT_MAX_DESCRIPTION_CHARS}
        placeholder="One line about what this agent is for."
        onChange={(event) => onChangeDescription(event.currentTarget.value)}
      />
      <div className="flex flex-col gap-1.5">
        <span className="px-1 text-[13px] font-medium text-ink-2">Persona</span>
        <MarkdownDocumentEditor
          value={persona}
          onChange={onChangePersona}
          extensions={DOCUMENT_EXTENSIONS}
          ariaLabel="Persona"
          placeholder="You are…"
          className="h-72"
          footer={
            <p className="px-1 text-[12px] text-ink-3">
              {personaLength === 0
                ? `The persona prepended to every run. Aim for under ${PERSONA_ADVICE.toLocaleString()} characters.`
                : `${personaLength.toLocaleString()} / ${PERSONA_MAX.toLocaleString()} characters`}
            </p>
          }
        />
      </div>
    </div>
  );
}
