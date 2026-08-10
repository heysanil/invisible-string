/**
 * Tool allow/block picker (connectors redesign spec §10, plan-2 Task 5): a
 * mode switch (All tools / allow / block) over the connection's CACHED tool
 * list. With a cache, tools render as a checkbox list (bare names,
 * descriptions as tooltips) plus a free-text escape row for names the cache
 * does not know; without one, the free-text input stands alone with a hint
 * to run Test connection. Emits the same `toolAllow`/`toolBlock` payloads
 * the API already accepts — bare names only (the compiler qualifies
 * `slug__tool` internally; qualified names never render here).
 *
 * Persistence is the owner's job: every interaction calls `onChange` with a
 * full filter patch (exactly one of allow/block non-null; empty lists become
 * null, matching the API's min(1) contract).
 */
import { useMemo, useState } from "react";
import type { ConnectionDto, UpdateConnectionRequest } from "@invisible-string/shared";

import { cn } from "../../lib/cn";
import { TagInput } from "../ui/TagInput";

export type ToolFilterMode = "none" | "allow" | "block";

/** The filter slice of a connection PATCH — what the picker emits. */
export type ToolFilterPatch = Pick<UpdateConnectionRequest, "toolAllow" | "toolBlock">;

export interface ToolPickerProps {
  connection: ConnectionDto;
  onChange: (patch: ToolFilterPatch) => void;
  readOnly?: boolean;
}

// Satisfies React's controlled-input contract; checkbox toggles ride onClick
// (the canonical checkbox interaction — fires once per activation in real
// browsers AND under happy-dom, where React's change plugin never emits).
function noopChange() {}

export function ToolPicker({ connection, onChange, readOnly = false }: ToolPickerProps) {
  const initialMode: ToolFilterMode =
    connection.toolAllow && connection.toolAllow.length > 0
      ? "allow"
      : connection.toolBlock && connection.toolBlock.length > 0
        ? "block"
        : "none";
  const [mode, setMode] = useState<ToolFilterMode>(initialMode);
  const [selected, setSelected] = useState<string[]>(
    initialMode === "allow"
      ? (connection.toolAllow ?? [])
      : initialMode === "block"
        ? (connection.toolBlock ?? [])
        : [],
  );

  const cached = connection.tools;
  const cachedNames = useMemo(
    () => new Set((cached ?? []).map((tool) => tool.name)),
    [cached],
  );
  /** Selected names the cache does not know — the free-text escape's chips. */
  const extras = selected.filter((name) => !cachedNames.has(name));

  function save(nextMode: ToolFilterMode, nextTools: string[]) {
    setMode(nextMode);
    setSelected(nextTools);
    onChange({
      toolAllow: nextMode === "allow" ? (nextTools.length ? nextTools : null) : null,
      toolBlock: nextMode === "block" ? (nextTools.length ? nextTools : null) : null,
    });
  }

  function toggle(name: string) {
    save(
      mode,
      selected.includes(name)
        ? selected.filter((value) => value !== name)
        : [...selected, name],
    );
  }

  /** Free-text names changed — merge with the checked cached names, deduped. */
  function replaceExtras(nextExtras: string[]) {
    const checked = selected.filter((name) => cachedNames.has(name));
    save(mode, [...new Set([...checked, ...nextExtras])]);
  }

  const listLabel = mode === "allow" ? "Allowed tools" : "Blocked tools";

  return (
    <div className="flex flex-col gap-3">
      <div className="flex gap-1.5">
        {(["none", "allow", "block"] as ToolFilterMode[]).map((option) => (
          <button
            key={option}
            type="button"
            disabled={readOnly}
            aria-pressed={option === mode}
            onClick={() => save(option, option === mode ? selected : [])}
            className={cn(
              "lift flex-1 rounded-capsule border px-2 py-1 text-[12px] font-medium capitalize",
              "disabled:pointer-events-none disabled:opacity-55",
              option === mode
                ? "border-ink bg-ink text-white"
                : "border-black/10 text-ink-3 hover:text-ink",
            )}
          >
            {option === "none" ? "All tools" : option}
          </button>
        ))}
      </div>

      {mode === "none" ? null : cached ? (
        <div className="flex flex-col gap-2">
          <span className="px-0.5 text-[12px] font-medium text-ink-2">
            {listLabel}
          </span>
          <ul className="thin-scroll flex max-h-52 flex-col gap-0.5 overflow-y-auto">
            {cached.map((tool) => (
              <li key={tool.name}>
                <label
                  title={tool.description || undefined}
                  className={cn(
                    "flex items-center gap-2 rounded-card px-1.5 py-1",
                    readOnly ? "opacity-70" : "cursor-pointer hover:bg-black/[0.03]",
                  )}
                >
                  <input
                    type="checkbox"
                    checked={selected.includes(tool.name)}
                    disabled={readOnly}
                    onChange={noopChange}
                    onClick={() => toggle(tool.name)}
                    className="size-3.5 shrink-0 accent-ink"
                  />
                  <span className="truncate font-mono text-[12px] text-ink">
                    {tool.name}
                  </span>
                </label>
              </li>
            ))}
          </ul>
          {readOnly ? (
            extras.length > 0 ? (
              <ExtraChips names={extras} />
            ) : null
          ) : (
            <TagInput
              label="Other tool names"
              values={extras}
              placeholder="not listed? type a name, then Enter"
              onChange={replaceExtras}
            />
          )}
        </div>
      ) : readOnly ? (
        <ExtraChips names={selected} />
      ) : (
        <div className="flex flex-col gap-1.5">
          <TagInput
            label={listLabel}
            values={selected}
            placeholder="tool name, then Enter"
            onChange={(next) => save(mode, next)}
          />
          <p className="px-0.5 text-[11.5px] leading-snug text-ink-4">
            Run Test connection to discover this server’s tools and pick from a
            list.
          </p>
        </div>
      )}
    </div>
  );
}

/** Read-only rendering of filter names (members see the list, not controls). */
function ExtraChips({ names }: { names: string[] }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {names.map((name) => (
        <span
          key={name}
          className="rounded-capsule bg-chip px-2 py-0.5 font-mono text-[11.5px] text-ink"
        >
          {name}
        </span>
      ))}
    </div>
  );
}
