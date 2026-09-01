/**
 * TOOL step inspector: connection (with its probe health beside it) → a
 * searchable tool picker over the connection's CACHED `tools/list` → arg
 * fields, in the richest form the cache supports:
 *
 * - `inputSchema` cached  → schema-aware fields (type-expectant, described,
 *   required-first) walked from the trimmed JSON Schema's top level;
 * - names only (`params`) → one template field per advertised name;
 * - neither, or structured values → the raw-JSON toggle, which always exists
 *   as the escape hatch and round-trips through `templateValueSchema`-shaped
 *   parsing (invalid JSON never reaches the reducer).
 *
 * Every field accepts `@references` (see fields.tsx — the template codec).
 * Edits land as `patchStepParams` — the keystroke-level reducer action.
 */
import { useMemo, useState } from "react";
import { Search } from "lucide-react";
import type {
  ConnectionHealth,
  ConnectionTool,
  TemplateValue,
  ToolStep,
} from "@invisible-string/shared";

import type { ScopedConnection } from "../../../lib/builder/resources";
import type { StepParamsPatch } from "../../../lib/builder/model";
import type { ReferenceSources } from "../../../lib/builder/references";
import { cn } from "../../../lib/cn";
import { Input } from "../../ui/Input";
import { Select } from "../../ui/Select";
import { StatusChip, type StatusTone } from "../../ui/StatusChip";
import { Switch } from "../../ui/Switch";
import { Textarea } from "../../ui/Textarea";
import { TemplateValueField, type TemplateExpectation } from "./fields";

// ── Schema → field specs (pure; tested) ─────────────────────────────────────

export interface ArgFieldSpec {
  key: string;
  expect: TemplateExpectation;
  description?: string | undefined;
  required: boolean;
}

/**
 * Top-level fields of a trimmed MCP `inputSchema`, required-first. Null when
 * the schema has no walkable `properties` (consumers then degrade to the
 * name-keyed lane — the cache-widening contract).
 */
export function argFieldSpecs(
  inputSchema: Record<string, unknown> | undefined,
): ArgFieldSpec[] | null {
  if (inputSchema === undefined) return null;
  const properties = inputSchema["properties"];
  if (properties === null || typeof properties !== "object" || Array.isArray(properties)) {
    return null;
  }
  const required = new Set(
    Array.isArray(inputSchema["required"])
      ? (inputSchema["required"] as unknown[]).filter(
          (name): name is string => typeof name === "string",
        )
      : [],
  );
  const specs = Object.entries(properties as Record<string, unknown>).map(
    ([key, node]): ArgFieldSpec => {
      const spec: Record<string, unknown> =
        node !== null && typeof node === "object" && !Array.isArray(node)
          ? (node as Record<string, unknown>)
          : {};
      const type = typeof spec["type"] === "string" ? spec["type"] : "";
      const expect: TemplateExpectation =
        type === "number" || type === "integer"
          ? "number"
          : type === "boolean"
            ? "boolean"
            : type === "string"
              ? "string"
              : "any";
      const enumValues = Array.isArray(spec["enum"])
        ? (spec["enum"] as unknown[]).filter(
            (entry): entry is string => typeof entry === "string",
          )
        : [];
      const described =
        typeof spec["description"] === "string" ? spec["description"] : undefined;
      const description =
        enumValues.length > 0
          ? `${described !== undefined ? `${described} ` : ""}One of: ${enumValues.join(", ")}.`
          : described;
      return { key, expect, description, required: required.has(key) };
    },
  );
  specs.sort((a, b) =>
    a.required === b.required ? 0 : a.required ? -1 : 1,
  );
  return specs;
}

const HEALTH_TONE: Record<ConnectionHealth, StatusTone> = {
  unknown: "neutral",
  ok: "success",
  unreachable: "error",
  auth_required: "warning",
  auth_error: "error",
};

const HEALTH_LABEL: Record<ConnectionHealth, string> = {
  unknown: "Unchecked",
  ok: "Healthy",
  unreachable: "Unreachable",
  auth_required: "Needs auth",
  auth_error: "Auth error",
};

// ── Component ───────────────────────────────────────────────────────────────

export interface ToolStepFormProps {
  step: ToolStep;
  connections: readonly ScopedConnection[];
  sources: ReferenceSources;
  onPatch: (patch: StepParamsPatch) => void;
}

export function ToolStepForm({
  step,
  connections,
  sources,
  onPatch,
}: ToolStepFormProps) {
  const [toolQuery, setToolQuery] = useState("");
  const [rawJson, setRawJson] = useState(false);

  const connection =
    connections.find((candidate) => candidate.id === step.connectionId) ?? null;
  const tools = connection?.tools ?? null;
  const selectedTool =
    tools?.find((tool) => tool.name === step.tool) ?? null;
  const specs = useMemo(
    () => (selectedTool !== null ? argFieldSpecs(selectedTool.inputSchema) : null),
    [selectedTool],
  );

  const setArg = (key: string, value: TemplateValue) => {
    onPatch({ args: { ...step.args, [key]: value } });
  };
  const removeArg = (key: string) => {
    const { [key]: _removed, ...rest } = step.args;
    onPatch({ args: rest });
  };

  return (
    <div className="flex flex-col gap-4">
      {/* connection */}
      <div className="flex flex-col gap-1.5">
        <div className="flex items-end gap-2">
          <div className="min-w-0 flex-1">
            <Select
              label="Connection"
              value={step.connectionId}
              placeholder="Choose a connection…"
              options={connections.map((candidate) => ({
                value: candidate.id,
                label:
                  candidate.resourceScope === "user"
                    ? `${candidate.name} (personal)`
                    : candidate.name,
              }))}
              onChange={(event) => {
                const next = event.currentTarget.value;
                if (next === step.connectionId) return;
                // A different server lists different tools — the old name and
                // args would only mislead.
                onPatch({ connectionId: next, tool: "", args: {} });
                setToolQuery("");
              }}
            />
          </div>
          {connection !== null ? (
            <StatusChip
              tone={HEALTH_TONE[connection.health]}
              dot
              className="mb-2.5 shrink-0"
              title={connection.lastError ?? undefined}
            >
              {HEALTH_LABEL[connection.health]}
            </StatusChip>
          ) : null}
        </div>
        {connection !== null && !connection.enabled ? (
          <p className="px-1 text-[11.5px] text-warn-ink">
            This connection is disabled — enable it in Context before publishing.
          </p>
        ) : null}
      </div>

      {/* tool picker */}
      {connection !== null ? (
        tools !== null && tools.length > 0 ? (
          <div className="flex flex-col gap-1.5">
            <span className="px-1 text-[13px] font-medium text-ink-2">Tool</span>
            {selectedTool !== null ? (
              <div className="flex items-start justify-between gap-2 rounded-card border border-black/10 bg-white/50 px-3 py-2">
                <div className="min-w-0">
                  <p className="truncate font-mono text-[12.5px] font-medium text-ink">
                    {selectedTool.name}
                  </p>
                  {selectedTool.description !== "" ? (
                    <p className="line-clamp-2 text-[11.5px] leading-snug text-ink-3">
                      {selectedTool.description}
                    </p>
                  ) : null}
                </div>
                <button
                  type="button"
                  onClick={() => onPatch({ tool: "" })}
                  className="lift shrink-0 rounded-capsule border border-black/10 bg-white/60 px-2 py-0.5 text-[11px] font-medium text-ink-2 hover:text-ink"
                >
                  Change
                </button>
              </div>
            ) : (
              <ToolPicker
                tools={tools}
                query={toolQuery}
                onQuery={setToolQuery}
                onPick={(tool) => onPatch({ tool: tool.name })}
              />
            )}
            {step.tool !== "" && selectedTool === null ? (
              <p className="px-1 text-[11.5px] text-warn-ink">
                “{step.tool}” isn't in this connection's cached tool list — it
                may have been renamed. Pick again, or keep it if the server
                really has it.
              </p>
            ) : null}
          </div>
        ) : (
          <Input
            label="Tool name"
            placeholder="exact tool name, e.g. search_messages"
            value={step.tool}
            className="font-mono text-[12.5px]"
            onChange={(event) => onPatch({ tool: event.currentTarget.value })}
          />
        )
      ) : null}
      {connection !== null && tools !== null && tools.length === 0 ? (
        <p className="px-1 text-[11.5px] text-ink-4">
          The probe found no tools on this connection.
        </p>
      ) : null}

      {/* args */}
      {step.tool !== "" || Object.keys(step.args).length > 0 ? (
        <div className="flex flex-col gap-2.5">
          <div className="flex items-center justify-between px-1">
            <span className="text-[13px] font-medium text-ink-2">Arguments</span>
            <button
              type="button"
              onClick={() => setRawJson((mode) => !mode)}
              className="rounded-capsule px-2 py-0.5 text-[11px] font-medium text-ink-3 transition-colors duration-150 ease-out hover:bg-black/[0.04] hover:text-ink focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"
            >
              {rawJson ? "Edit as fields" : "Edit as JSON"}
            </button>
          </div>
          {rawJson ? (
            <ArgsJsonEditor
              args={step.args}
              onChange={(args) => onPatch({ args })}
            />
          ) : specs !== null ? (
            <SchemaArgFields
              specs={specs}
              args={step.args}
              sources={sources}
              onChange={setArg}
            />
          ) : (
            <NamedArgFields
              paramNames={selectedTool?.params ?? []}
              args={step.args}
              sources={sources}
              onChange={setArg}
              onRemove={removeArg}
            />
          )}
        </div>
      ) : null}

      {/* side-effect stance */}
      <label className="flex items-start justify-between gap-4 rounded-card border border-black/[0.07] bg-white/40 px-3.5 py-3">
        <span className="flex min-w-0 flex-col">
          <span className="text-[13px] font-medium text-ink">
            Never run twice
          </span>
          <span className="text-[11.5px] leading-snug text-ink-3">
            If a crash interrupts this call, fail instead of retrying — for
            side effects that must not double-post.
          </span>
        </span>
        <Switch
          label="Never run twice"
          checked={step.sideEffect === "at_most_once"}
          onChange={(checked) =>
            onPatch({ sideEffect: checked ? "at_most_once" : "at_least_once" })
          }
        />
      </label>
    </div>
  );
}

// ── Pieces ──────────────────────────────────────────────────────────────────

function ToolPicker({
  tools,
  query,
  onQuery,
  onPick,
}: {
  tools: readonly ConnectionTool[];
  query: string;
  onQuery: (query: string) => void;
  onPick: (tool: ConnectionTool) => void;
}) {
  const needle = query.trim().toLowerCase();
  const filtered =
    needle === ""
      ? tools
      : tools.filter(
          (tool) =>
            tool.name.toLowerCase().includes(needle) ||
            tool.description.toLowerCase().includes(needle),
        );
  return (
    <div className="flex flex-col gap-1.5">
      <div className="relative">
        <Search
          size={13}
          aria-hidden="true"
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-ink-4"
        />
        <Input
          label="Search tools"
          srOnlyLabel
          placeholder={`Search ${tools.length} tool${tools.length === 1 ? "" : "s"}…`}
          value={query}
          className="h-9 pl-8 text-[13px]"
          onChange={(event) => onQuery(event.currentTarget.value)}
        />
      </div>
      <div
        role="listbox"
        aria-label="Tools"
        className="flex max-h-56 flex-col gap-0.5 overflow-y-auto rounded-card border border-black/[0.07] bg-white/40 p-1"
      >
        {filtered.length === 0 ? (
          <p className="px-2.5 py-2 text-[12px] text-ink-4">
            No tool matches “{query.trim()}”.
          </p>
        ) : (
          filtered.map((tool) => (
            <button
              key={tool.name}
              type="button"
              role="option"
              aria-selected={false}
              onClick={() => onPick(tool)}
              className="flex flex-col items-start gap-0.5 rounded-card px-2.5 py-1.5 text-left transition-colors duration-150 ease-out hover:bg-black/[0.05] focus-visible:outline focus-visible:outline-2 focus-visible:outline-ink"
            >
              <span className="font-mono text-[12.5px] font-medium text-ink">
                {tool.name}
              </span>
              {tool.description !== "" ? (
                <span className="line-clamp-2 text-[11.5px] leading-snug text-ink-3">
                  {tool.description}
                </span>
              ) : null}
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function SchemaArgFields({
  specs,
  args,
  sources,
  onChange,
}: {
  specs: readonly ArgFieldSpec[];
  args: Record<string, TemplateValue>;
  sources: ReferenceSources;
  onChange: (key: string, value: TemplateValue) => void;
}) {
  // Args the schema doesn't declare still render (they exist in the draft —
  // hiding them would hide what the runner will send).
  const extraKeys = Object.keys(args).filter(
    (key) => !specs.some((spec) => spec.key === key),
  );
  return (
    <div className="flex flex-col gap-2.5">
      {specs.map((spec) => (
        <TemplateValueField
          key={spec.key}
          label={spec.key}
          value={args[spec.key] ?? ""}
          sources={sources}
          expect={spec.expect}
          hint={spec.description}
          required={spec.required}
          onChange={(value) => onChange(spec.key, value)}
        />
      ))}
      {extraKeys.map((key) => (
        <TemplateValueField
          key={key}
          label={key}
          value={args[key] ?? ""}
          sources={sources}
          hint="Not in the tool's schema."
          onChange={(value) => onChange(key, value)}
        />
      ))}
    </div>
  );
}

function NamedArgFields({
  paramNames,
  args,
  sources,
  onChange,
  onRemove,
}: {
  paramNames: readonly string[];
  args: Record<string, TemplateValue>;
  sources: ReferenceSources;
  onChange: (key: string, value: TemplateValue) => void;
  onRemove: (key: string) => void;
}) {
  const [newKey, setNewKey] = useState("");
  const keys = [
    ...paramNames,
    ...Object.keys(args).filter((key) => !paramNames.includes(key)),
  ];
  return (
    <div className="flex flex-col gap-2.5">
      {keys.map((key) => (
        <div key={key} className="flex items-end gap-1.5">
          <div className="min-w-0 flex-1">
            <TemplateValueField
              label={key}
              value={args[key] ?? ""}
              sources={sources}
              onChange={(value) => onChange(key, value)}
            />
          </div>
          {!paramNames.includes(key) ? (
            <button
              type="button"
              aria-label={`Remove argument ${key}`}
              onClick={() => onRemove(key)}
              className="lift mb-1 flex size-7 shrink-0 items-center justify-center rounded-full text-ink-4 hover:bg-err/10 hover:text-err"
            >
              ×
            </button>
          ) : null}
        </div>
      ))}
      <form
        className="flex items-center gap-1.5"
        onSubmit={(event) => {
          event.preventDefault();
          const key = newKey.trim();
          if (key === "" || key in args) return;
          onChange(key, "");
          setNewKey("");
        }}
      >
        <Input
          label="New argument name"
          srOnlyLabel
          placeholder="Add an argument…"
          value={newKey}
          className="h-8 font-mono text-[12px]"
          onChange={(event) => setNewKey(event.currentTarget.value)}
        />
        <button
          type="submit"
          className={cn(
            "lift shrink-0 rounded-capsule border border-black/10 bg-white/60 px-2.5 py-1 text-[11.5px] font-medium text-ink-2 hover:text-ink",
            "disabled:pointer-events-none disabled:opacity-40",
          )}
          disabled={newKey.trim() === ""}
        >
          Add
        </button>
      </form>
    </div>
  );
}

function ArgsJsonEditor({
  args,
  onChange,
}: {
  args: Record<string, TemplateValue>;
  onChange: (args: Record<string, TemplateValue>) => void;
}) {
  const [text, setText] = useState(() => JSON.stringify(args, null, 2));
  const [error, setError] = useState<string | null>(null);
  return (
    <Textarea
      label="Arguments (JSON)"
      srOnlyLabel
      value={text}
      rows={8}
      error={error}
      hint='Values may be {"$ref": "steps.search.result"} or {"$tpl": "…@state.cursor…"}.'
      className="font-mono text-[12px]"
      onChange={(event) => {
        const next = event.currentTarget.value;
        setText(next);
        try {
          const parsed: unknown = JSON.parse(next);
          if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
            setError("Arguments must be a JSON object.");
            return;
          }
          setError(null);
          onChange(parsed as Record<string, TemplateValue>);
        } catch {
          setError("Not valid JSON yet.");
        }
      }}
    />
  );
}
