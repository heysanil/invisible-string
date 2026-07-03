/**
 * Custom-URL MCP connection form: name + endpoint URL + auth (none / bearer /
 * headers). Secret values are sent once via the encrypted `auth` field.
 */
import { Plus, Trash2 } from "lucide-react";
import { useState } from "react";
import type {
  CreateMcpConnectionRequest,
  McpAuthWrite,
} from "@invisible-string/shared";
import { createMcpConnectionRequestSchema } from "@invisible-string/shared";

import { errorMessage, fieldErrorsFromZod } from "../../lib/forms";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { SegmentedControl } from "../ui/SegmentedControl";

export interface CustomConnectionFormProps {
  onCreate: (input: CreateMcpConnectionRequest) => Promise<unknown>;
  creating: boolean;
  error?: unknown;
}

type AuthKind = "none" | "bearer" | "headers";

interface HeaderRow {
  name: string;
  value: string;
}

export function CustomConnectionForm({
  onCreate,
  creating,
  error,
}: CustomConnectionFormProps) {
  const [name, setName] = useState("");
  const [url, setUrl] = useState("");
  const [description, setDescription] = useState("");
  const [authKind, setAuthKind] = useState<AuthKind>("none");
  const [token, setToken] = useState("");
  const [headers, setHeaders] = useState<HeaderRow[]>([{ name: "", value: "" }]);
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  function buildAuth(): McpAuthWrite | undefined {
    if (authKind === "none") return undefined;
    if (authKind === "bearer") {
      return { type: "bearer", values: { token: token.trim() } };
    }
    const values = Object.fromEntries(
      headers
        .map((row) => [row.name.trim(), row.value.trim()] as const)
        .filter(([key, value]) => key.length > 0 && value.length > 0),
    );
    return { type: "headers", values };
  }

  async function submit() {
    const errors: Record<string, string> = {};
    if (authKind === "bearer" && token.trim().length === 0) {
      errors["token"] = "Enter the bearer token.";
    }
    if (authKind === "headers") {
      const filled = headers.filter(
        (row) => row.name.trim().length > 0 && row.value.trim().length > 0,
      );
      if (filled.length === 0) errors["headers"] = "Add at least one header.";
    }

    const candidate = {
      name: name.trim(),
      url: url.trim(),
      description: description.trim() || undefined,
      auth: buildAuth(),
    } satisfies Partial<CreateMcpConnectionRequest>;

    const parsed = createMcpConnectionRequestSchema.safeParse(candidate);
    if (!parsed.success) {
      Object.assign(errors, fieldErrorsFromZod(parsed.error));
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0 || !parsed.success) return;

    await onCreate(parsed.data);
  }

  const topError = error ? errorMessage(error) : null;

  return (
    <div className="flex flex-col gap-4 pb-1">
      <Input
        label="Connection name"
        value={name}
        placeholder="e.g. Internal tools"
        onChange={(event) => setName(event.currentTarget.value)}
        error={fieldErrors["name"]}
      />
      <Input
        label="Server URL"
        value={url}
        placeholder="https://mcp.example.com/sse"
        onChange={(event) => setUrl(event.currentTarget.value)}
        error={fieldErrors["url"]}
      />
      <Input
        label="Description (optional)"
        value={description}
        placeholder="What this server is for — helps the agent find it."
        onChange={(event) => setDescription(event.currentTarget.value)}
        error={fieldErrors["description"]}
      />

      <div className="flex flex-col gap-2">
        <span className="px-1 text-[13px] font-medium text-ink-2">Authentication</span>
        <SegmentedControl<AuthKind>
          ariaLabel="Authentication type"
          size="sm"
          value={authKind}
          onChange={setAuthKind}
          options={[
            { value: "none", label: "None" },
            { value: "bearer", label: "Bearer" },
            { value: "headers", label: "Headers" },
          ]}
        />
      </div>

      {authKind === "bearer" ? (
        <Input
          label="Bearer token"
          type="password"
          autoComplete="new-password"
          value={token}
          onChange={(event) => setToken(event.currentTarget.value)}
          error={fieldErrors["token"]}
        />
      ) : null}

      {authKind === "headers" ? (
        <div className="flex flex-col gap-2">
          {headers.map((row, index) => (
            <div key={index} className="flex items-end gap-2">
              <div className="flex-1">
                <Input
                  label={index === 0 ? "Header" : ""}
                  aria-label="Header name"
                  placeholder="X-Api-Key"
                  value={row.name}
                  onChange={(event) =>
                    setHeaders((current) =>
                      current.map((item, i) =>
                        i === index
                          ? { ...item, name: event.currentTarget.value }
                          : item,
                      ),
                    )
                  }
                />
              </div>
              <div className="flex-1">
                <Input
                  label={index === 0 ? "Value" : ""}
                  aria-label="Header value"
                  type="password"
                  autoComplete="new-password"
                  value={row.value}
                  onChange={(event) =>
                    setHeaders((current) =>
                      current.map((item, i) =>
                        i === index
                          ? { ...item, value: event.currentTarget.value }
                          : item,
                      ),
                    )
                  }
                />
              </div>
              <button
                type="button"
                aria-label="Remove header"
                disabled={headers.length === 1}
                onClick={() =>
                  setHeaders((current) => current.filter((_, i) => i !== index))
                }
                className="lift mb-0.5 flex size-10 shrink-0 items-center justify-center rounded-capsule text-ink-4 hover:bg-black/[0.05] hover:text-ink disabled:opacity-40"
              >
                <Trash2 size={15} aria-hidden="true" />
              </button>
            </div>
          ))}
          {fieldErrors["headers"] ? (
            <p className="px-1 text-xs text-err">{fieldErrors["headers"]}</p>
          ) : null}
          <button
            type="button"
            onClick={() =>
              setHeaders((current) => [...current, { name: "", value: "" }])
            }
            className="lift inline-flex w-fit items-center gap-1.5 rounded-capsule px-2 py-1 text-[13px] font-medium text-ink-2 hover:bg-black/[0.04] hover:text-ink"
          >
            <Plus size={14} aria-hidden="true" />
            Add header
          </button>
        </div>
      ) : null}

      {topError ? (
        <p role="alert" className="text-[13px] text-err">
          {topError}
        </p>
      ) : null}

      <div className="flex items-center justify-end pt-1">
        <Button size="sm" loading={creating} onClick={() => void submit()}>
          Add connection
        </Button>
      </div>
    </div>
  );
}
