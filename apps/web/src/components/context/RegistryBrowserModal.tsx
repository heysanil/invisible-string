/**
 * "Add connection" modal. Two tabs:
 *  - Registry: search-as-you-type against the control-plane registry proxy,
 *    result cards, then a per-server install form (secrets collected once).
 *  - Custom: name + URL + auth.
 * Closing resets to the search step so a reopened modal never leaks the
 * previous server's half-filled secret form.
 */
import { Search } from "lucide-react";
import { useState } from "react";
import type {
  CreateMcpConnectionRequest,
  InstallMcpConnectionRequest,
  RegistryServerSummary,
} from "@invisible-string/shared";

import {
  useCreateMcpConnection,
  useInstallMcpConnection,
} from "../../lib/queries/mcp-connections";
import type { ScopeRef } from "../../lib/queries/keys";
import { useRegistrySearch } from "../../lib/queries/registry";
import { useDebouncedValue } from "../../lib/use-debounced-value";
import { Input } from "../ui/Input";
import { Modal } from "../ui/Modal";
import { SegmentedControl } from "../ui/SegmentedControl";
import { Spinner } from "../ui/Spinner";
import { ErrorState } from "../ui/ErrorState";
import { EmptyState } from "../ui/EmptyState";
import { Blocks } from "lucide-react";
import { useToast } from "../ui/Toast";
import { errorMessage } from "../../lib/forms";
import { CustomConnectionForm } from "./CustomConnectionForm";
import { InstallServerForm } from "./InstallServerForm";
import { RegistryResultCard } from "./RegistryResultCard";

export interface RegistryBrowserModalProps {
  open: boolean;
  onClose: () => void;
  scope: ScopeRef;
  scopeLabel: string;
}

type Tab = "registry" | "custom";

export function RegistryBrowserModal({
  open,
  onClose,
  scope,
  scopeLabel,
}: RegistryBrowserModalProps) {
  const [tab, setTab] = useState<Tab>("registry");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<RegistryServerSummary | null>(null);
  const debounced = useDebouncedValue(query, 250);
  const search = useRegistrySearch(debounced);
  const install = useInstallMcpConnection(scope);
  const create = useCreateMcpConnection(scope);
  const { toast } = useToast();

  function reset() {
    setTab("registry");
    setQuery("");
    setSelected(null);
    install.reset();
    create.reset();
  }

  function close() {
    reset();
    onClose();
  }

  async function handleInstall(input: InstallMcpConnectionRequest) {
    const result = await install.mutateAsync(input);
    toast({
      variant: "success",
      message: `${result.connection.name} connected.`,
    });
    close();
  }

  async function handleCreate(input: CreateMcpConnectionRequest) {
    const result = await create.mutateAsync(input);
    toast({
      variant: "success",
      message: `${result.connection.name} connected.`,
    });
    close();
  }

  const description = selected
    ? undefined
    : `Add an MCP server to ${scopeLabel} context.`;

  return (
    <Modal
      open={open}
      onClose={close}
      title={selected ? "Configure server" : "Add connection"}
      description={description}
      maxWidthClassName="max-w-xl"
    >
      {selected ? (
        <InstallServerForm
          server={selected}
          onBack={() => {
            setSelected(null);
            install.reset();
          }}
          onInstall={handleInstall}
          installing={install.isPending}
          error={install.error}
        />
      ) : (
        <div className="flex flex-col gap-4 pb-1">
          <SegmentedControl<Tab>
            ariaLabel="Connection source"
            size="sm"
            value={tab}
            onChange={setTab}
            options={[
              { value: "registry", label: "Registry" },
              { value: "custom", label: "Custom URL" },
            ]}
          />

          {tab === "registry" ? (
            <div className="flex flex-col gap-3">
              <div className="relative">
                <Search
                  size={15}
                  aria-hidden="true"
                  className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-4"
                />
                <Input
                  label=""
                  aria-label="Search the MCP registry"
                  placeholder="Search servers — GitHub, Linear, Postgres…"
                  autoFocus
                  value={query}
                  onChange={(event) => setQuery(event.currentTarget.value)}
                  className="pl-9"
                />
              </div>

              <div className="min-h-[16rem]">
                <RegistryResults
                  query={debounced}
                  isLoading={search.isFetching && search.data === undefined}
                  isError={search.isError}
                  errorText={errorMessage(search.error)}
                  onRetry={() => void search.refetch()}
                  servers={search.data ?? []}
                  onPick={setSelected}
                />
              </div>
            </div>
          ) : (
            <CustomConnectionForm
              onCreate={handleCreate}
              creating={create.isPending}
              error={create.error}
            />
          )}
        </div>
      )}
    </Modal>
  );
}

interface RegistryResultsProps {
  query: string;
  isLoading: boolean;
  isError: boolean;
  errorText: string;
  onRetry: () => void;
  servers: RegistryServerSummary[];
  onPick: (server: RegistryServerSummary) => void;
}

function RegistryResults({
  query,
  isLoading,
  isError,
  errorText,
  onRetry,
  servers,
  onPick,
}: RegistryResultsProps) {
  if (query.trim().length === 0) {
    return (
      <EmptyState
        icon={Search}
        title="Search the registry"
        description="Find a hosted MCP server by name and connect it in a couple of clicks."
      />
    );
  }
  if (isLoading) {
    return (
      <div
        role="status"
        aria-label="Searching"
        className="flex h-64 items-center justify-center"
      >
        <Spinner size={18} className="text-ink-4" />
      </div>
    );
  }
  if (isError) {
    return <ErrorState compact message={errorText} onRetry={onRetry} />;
  }
  if (servers.length === 0) {
    return (
      <EmptyState
        icon={Blocks}
        title="No servers found"
        description="No registry servers match that search. Try another name or add a custom URL."
      />
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {servers.map((server) => (
        <li key={`${server.name}@${server.version}`}>
          <RegistryResultCard server={server} onPick={() => onPick(server)} />
        </li>
      ))}
    </ul>
  );
}
