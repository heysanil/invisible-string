/**
 * Registry-server install form. Collects a display name and any values the
 * server declares it needs (secret ones as password fields). Values are
 * gathered in local state, sent ONCE via the encrypted `auth` field, and
 * never read back — the returned connection carries only `hasCredentials`.
 */
import { ArrowLeft } from "lucide-react";
import { useMemo, useState } from "react";
import type {
  InstallMcpConnectionRequest,
  McpAuthWrite,
  RegistryEnvVarDeclaration,
  RegistryRemote,
  RegistryServerSummary,
} from "@invisible-string/shared";

import { errorMessage } from "../../lib/forms";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { Select } from "../ui/Select";

export interface InstallServerFormProps {
  server: RegistryServerSummary;
  onBack: () => void;
  onInstall: (input: InstallMcpConnectionRequest) => Promise<unknown>;
  installing: boolean;
  error?: unknown;
}

/** Merge the chosen remote's header declarations with package-level env vars. */
function collectDeclarations(
  server: RegistryServerSummary,
  remote: RegistryRemote | undefined,
): RegistryEnvVarDeclaration[] {
  const byName = new Map<string, RegistryEnvVarDeclaration>();
  for (const decl of remote?.headers ?? []) byName.set(decl.name, decl);
  for (const decl of server.envVarDeclarations) {
    if (!byName.has(decl.name)) byName.set(decl.name, decl);
  }
  return [...byName.values()];
}

export function InstallServerForm({
  server,
  onBack,
  onInstall,
  installing,
  error,
}: InstallServerFormProps) {
  const remotes = server.remotes;
  const [remoteUrl, setRemoteUrl] = useState(remotes[0]?.url ?? "");
  const selectedRemote = remotes.find((remote) => remote.url === remoteUrl);
  const declarations = useMemo(
    () => collectDeclarations(server, selectedRemote),
    [server, selectedRemote],
  );

  const [name, setName] = useState(server.title ?? server.name);
  const [values, setValues] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  function setValue(key: string, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
    setFieldErrors((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  function buildAuth(): McpAuthWrite | undefined {
    const entries = declarations
      .map((decl) => [decl.name, (values[decl.name] ?? decl.default ?? "").trim()] as const)
      .filter(([, value]) => value.length > 0);
    if (entries.length === 0) return undefined;
    return { type: "headers", values: Object.fromEntries(entries) };
  }

  async function submit() {
    const errors: Record<string, string> = {};
    if (name.trim().length === 0) errors["name"] = "Give this connection a name.";
    if (remoteUrl.length === 0) errors["remoteUrl"] = "Choose a server endpoint.";
    for (const decl of declarations) {
      const value = (values[decl.name] ?? decl.default ?? "").trim();
      if (decl.isRequired && value.length === 0) {
        errors[decl.name] = "Required.";
      }
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    await onInstall({
      registryName: server.name,
      version: server.version,
      remoteUrl,
      name: name.trim(),
      description: server.description || undefined,
      auth: buildAuth(),
    });
  }

  const topError = error ? errorMessage(error) : null;

  return (
    <div className="flex flex-col gap-4 pb-1">
      <button
        type="button"
        onClick={onBack}
        className="lift -ml-1 inline-flex w-fit items-center gap-1.5 rounded-capsule px-2 py-1 text-[13px] font-medium text-ink-3 hover:bg-black/[0.04] hover:text-ink"
      >
        <ArrowLeft size={14} aria-hidden="true" />
        All servers
      </button>

      <div className="flex flex-col gap-1">
        <h3 className="text-[15px] font-semibold text-ink">
          {server.title ?? server.name}
        </h3>
        {server.description ? (
          <p className="text-[13px] leading-relaxed text-ink-3">
            {server.description}
          </p>
        ) : null}
        <p className="text-[12px] text-ink-4">
          {server.name} · v{server.version}
        </p>
      </div>

      <Input
        label="Connection name"
        value={name}
        onChange={(event) => setName(event.currentTarget.value)}
        error={fieldErrors["name"]}
      />

      {remotes.length > 1 ? (
        <Select
          label="Endpoint"
          value={remoteUrl}
          onChange={(event) => setRemoteUrl(event.currentTarget.value)}
          error={fieldErrors["remoteUrl"]}
          options={remotes.map((remote) => ({
            value: remote.url,
            label: `${remote.type} · ${remote.url}`,
          }))}
        />
      ) : null}

      {declarations.length > 0 ? (
        <div className="flex flex-col gap-3 rounded-card-lg border border-black/[0.07] bg-white/40 p-4">
          <div className="flex flex-col gap-0.5">
            <p className="text-[13px] font-semibold text-ink">Server credentials</p>
            <p className="text-[12px] leading-relaxed text-ink-4">
              Stored encrypted and sent to the server on your behalf. You will
              not see these values again.
            </p>
          </div>
          {declarations.map((decl) => (
            <Input
              key={decl.name}
              label={`${decl.name}${decl.isRequired ? "" : " (optional)"}`}
              type={decl.isSecret ? "password" : "text"}
              autoComplete={decl.isSecret ? "new-password" : "off"}
              placeholder={decl.description}
              value={values[decl.name] ?? (decl.isSecret ? "" : decl.default ?? "")}
              onChange={(event) => setValue(decl.name, event.currentTarget.value)}
              error={fieldErrors[decl.name]}
            />
          ))}
        </div>
      ) : null}

      {topError ? (
        <p role="alert" className="text-[13px] text-err">
          {topError}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2.5 pt-1">
        <Button variant="ghost" size="sm" onClick={onBack} disabled={installing}>
          Back
        </Button>
        <Button size="sm" loading={installing} onClick={() => void submit()}>
          Install
        </Button>
      </div>
    </div>
  );
}
