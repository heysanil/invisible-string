/**
 * PERSONA section: the card-grid one-liner (description) plus the persona /
 * root instructions in a real markdown editor — this document IS the agent,
 * so it gets CodeMirror rather than a bare textarea.
 */
import { Input } from "../ui/Input";
import { CodeMirrorMarkdown } from "../CodeMirrorMarkdown";

/** Hard server cap on the persona document. */
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
        placeholder="One line about what this agent is for."
        onChange={(event) => onChangeDescription(event.currentTarget.value)}
      />
      <div className="flex flex-col gap-1.5">
        <span className="px-1 text-[13px] font-medium text-ink-2">Persona</span>
        <div className="h-72">
          <CodeMirrorMarkdown
            value={persona}
            onChange={onChangePersona}
            ariaLabel="Persona"
            placeholder="You are…"
          />
        </div>
        <p className="px-1 text-[12px] text-ink-3">
          {personaLength === 0
            ? `The persona prepended to every run. Aim for under ${PERSONA_ADVICE.toLocaleString()} characters.`
            : `${personaLength.toLocaleString()} / ${PERSONA_MAX.toLocaleString()} characters`}
        </p>
      </div>
    </div>
  );
}
