import { X } from "lucide-react";
import { useId, useState, type KeyboardEvent } from "react";

import { cn } from "../../lib/cn";

export interface TagInputProps {
  label: string;
  values: readonly string[];
  onChange: (values: string[]) => void;
  placeholder?: string;
  className?: string;
}

/**
 * Tag/token input (Enter or comma commits; Backspace on empty removes the
 * last). Used for MCP tool allow/block lists.
 */
export function TagInput({
  label,
  values,
  onChange,
  placeholder,
  className,
}: TagInputProps) {
  const id = useId();
  const [draft, setDraft] = useState("");

  function commit(raw: string) {
    const value = raw.trim();
    if (value === "" || values.includes(value)) {
      setDraft("");
      return;
    }
    onChange([...values, value]);
    setDraft("");
  }

  function onKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      commit(draft);
    } else if (event.key === "Backspace" && draft === "" && values.length > 0) {
      onChange(values.slice(0, -1));
    }
  }

  return (
    <div className="flex flex-col gap-1.5">
      <label htmlFor={id} className="px-1 text-[12px] font-medium text-ink-2">
        {label}
      </label>
      <div
        className={cn(
          "flex flex-wrap items-center gap-1.5 rounded-card border border-black/10 bg-white/60 px-2 py-1.5",
          className,
        )}
      >
        {values.map((value) => (
          <span
            key={value}
            className="inline-flex items-center gap-1 rounded-capsule bg-chip px-2 py-0.5 font-mono text-[11.5px] text-ink"
          >
            {value}
            <button
              type="button"
              aria-label={`Remove ${value}`}
              onClick={() => onChange(values.filter((v) => v !== value))}
              className="lift -mr-0.5 flex size-3.5 items-center justify-center rounded-full text-ink-3 hover:text-ink"
            >
              <X size={11} aria-hidden="true" />
            </button>
          </span>
        ))}
        <input
          id={id}
          value={draft}
          placeholder={values.length === 0 ? placeholder : undefined}
          onChange={(event) => setDraft(event.currentTarget.value)}
          onKeyDown={onKeyDown}
          onBlur={() => commit(draft)}
          className="min-w-24 flex-1 bg-transparent px-1 py-0.5 text-[13px] text-ink outline-none placeholder:text-ink-4"
        />
      </div>
    </div>
  );
}
