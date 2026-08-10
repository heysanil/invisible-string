/**
 * "Add connection" dialog (connectors redesign spec §10, v1 scope — no OAuth
 * lane, no health dot). Three lanes over ONE unified `POST /connections`:
 *
 *  1. Curated catalog (default): featured row + category-grouped tiles from
 *     the checked-in connector catalog — zero network calls to render.
 *     `{type:"none"}` recipes install on click; secret recipes collect
 *     credentials once via {@link CatalogSecretForm}.
 *  2. Community search: one search field pins catalog matches above results
 *     from the control plane's Meilisearch mirror. `search_unavailable`
 *     renders an inline degraded note — the catalog stays fully usable
 *     (spec §5 degradation).
 *  3. Custom server: bring-your-own URL via {@link CustomConnectionForm}.
 *
 * Closing resets to the browse step so a reopened dialog never leaks the
 * previous connector's half-filled secret form.
 */
import { ArrowLeft, BadgeCheck, Blocks, Globe, Lock, Search } from "lucide-react";
import { useState } from "react";
import type {
  ConnectorCatalogEntry,
  ConnectorCategory,
  CreateConnectionRequest,
  McpAuthWrite,
  RegistryRemote,
  RegistrySearchResult,
} from "@invisible-string/shared";
import { parseConnectorCatalog } from "@invisible-string/shared";
import rawCatalog from "@invisible-string/shared/connector-catalog.json";

import { useConnections, useCreateConnection } from "../../lib/queries/connections";
import type { ScopeRef } from "../../lib/queries/keys";
import { isSearchUnavailable, useRegistrySearch } from "../../lib/queries/registry";
import { useDebouncedValue } from "../../lib/use-debounced-value";
import { errorMessage } from "../../lib/forms";
import { Chip } from "../ui/Chip";
import { EmptyState } from "../ui/EmptyState";
import { ErrorState } from "../ui/ErrorState";
import { Input } from "../ui/Input";
import { Modal } from "../ui/Modal";
import { Spinner } from "../ui/Spinner";
import { useToast } from "../ui/Toast";
import { CatalogSecretForm, type SecretFormField } from "./CatalogSecretForm";
import { CatalogTile } from "./CatalogTile";
import { CustomConnectionForm } from "./CustomConnectionForm";

// Catalog-as-code: parsed once at module load — a broken catalog fails the
// build/test run, mirroring the control plane's fail-fast boot loader.
const CATALOG = parseConnectorCatalog(rawCatalog);
const FEATURED = CATALOG.filter((entry) => entry.featured === true);

const CATEGORY_LABELS: Record<ConnectorCategory, string> = {
  productivity: "Productivity",
  "project-management": "Project management",
  "dev-tools": "Developer tools",
  data: "Data",
  communication: "Communication",
  commerce: "Commerce",
  other: "Other",
};
const CATEGORY_ORDER = Object.keys(CATEGORY_LABELS) as ConnectorCategory[];

export interface AddConnectionDialogProps {
  open: boolean;
  onClose: () => void;
  scope: ScopeRef;
  scopeLabel: string;
}

type View =
  | { kind: "browse" }
  | { kind: "catalog-auth"; entry: ConnectorCatalogEntry }
  | { kind: "registry-auth"; result: RegistrySearchResult; remote: RegistryRemote }
  | { kind: "custom" };

/** The secret form's field list for a catalog recipe. */
function catalogFields(entry: ConnectorCatalogEntry): SecretFormField[] {
  const recipe = entry.auth;
  if (recipe.type === "bearer") {
    return [
      {
        key: "token",
        label: recipe.tokenLabel,
        hint: recipe.tokenHint,
        secret: true,
        required: true,
      },
    ];
  }
  if (recipe.type === "headers") {
    return recipe.headers.map((header) => ({
      key: header.name,
      label: header.name,
      hint: header.description,
      secret: header.isSecret,
      // The create route 422s without every secret header (spec §4).
      required: header.isSecret,
    }));
  }
  return [];
}

/** The secret form's field list for a community remote's declarations. */
function remoteFields(remote: RegistryRemote): SecretFormField[] {
  return (remote.headers ?? []).map((declaration) => ({
    key: declaration.name,
    label: declaration.name,
    hint: declaration.description,
    secret: declaration.isSecret,
    required: declaration.isRequired,
  }));
}

export function AddConnectionDialog({
  open,
  onClose,
  scope,
  scopeLabel,
}: AddConnectionDialogProps) {
  const [view, setView] = useState<View>({ kind: "browse" });
  const [query, setQuery] = useState("");
  const debounced = useDebouncedValue(query, 250);
  const search = useRegistrySearch(debounced);
  const connections = useConnections(scope);
  const create = useCreateConnection(scope);
  const { toast } = useToast();

  const addedSlugs = new Set(
    (connections.data ?? [])
      .map((connection) => connection.catalogSlug)
      .filter((slug): slug is string => slug !== null),
  );

  function reset() {
    setView({ kind: "browse" });
    setQuery("");
    create.reset();
  }

  function close() {
    reset();
    onClose();
  }

  /** Shared terminal for every lane: create → toast → reset + close. */
  async function install(input: CreateConnectionRequest): Promise<void> {
    const result = await create.mutateAsync(input);
    toast({ variant: "success", message: `${result.connection.name} connected.` });
    close();
  }

  function pickCatalogEntry(entry: ConnectorCatalogEntry) {
    if (entry.auth.type === "none") {
      if (create.isPending) return;
      void install({ source: "catalog", slug: entry.slug }).catch((error) => {
        toast({ variant: "error", message: errorMessage(error) });
      });
      return;
    }
    create.reset();
    setView({ kind: "catalog-auth", entry });
  }

  function pickSearchResult(result: RegistrySearchResult) {
    // Only installable servers enter the index, so a first remote always
    // exists; secret prompts ride the chosen remote's header declarations.
    const remote = result.remotes[0];
    if (!remote) return;
    if ((remote.headers ?? []).length > 0) {
      create.reset();
      setView({ kind: "registry-auth", result, remote });
      return;
    }
    if (create.isPending) return;
    void install({
      source: "registry",
      registryName: result.name,
      remoteUrl: remote.url,
    }).catch((error) => {
      toast({ variant: "error", message: errorMessage(error) });
    });
  }

  async function submitCatalogAuth(
    entry: ConnectorCatalogEntry,
    values: Record<string, string>,
  ) {
    const auth: McpAuthWrite =
      entry.auth.type === "bearer"
        ? { type: "bearer", values: { token: values["token"] ?? "" } }
        : { type: "headers", values };
    try {
      await install({ source: "catalog", slug: entry.slug, auth });
    } catch {
      // Surfaced inline via create.error on the secret form.
    }
  }

  async function submitRegistryAuth(
    result: RegistrySearchResult,
    remote: RegistryRemote,
    values: Record<string, string>,
  ) {
    const auth: McpAuthWrite | undefined =
      Object.keys(values).length > 0 ? { type: "headers", values } : undefined;
    try {
      await install({
        source: "registry",
        registryName: result.name,
        remoteUrl: remote.url,
        ...(auth ? { auth } : {}),
      });
    } catch {
      // Surfaced inline via create.error on the secret form.
    }
  }

  const title =
    view.kind === "catalog-auth"
      ? `Connect ${view.entry.title}`
      : view.kind === "registry-auth"
        ? "Configure server"
        : view.kind === "custom"
          ? "Add custom server"
          : "Add connection";
  const description =
    view.kind === "browse"
      ? `Add an MCP server to ${scopeLabel} context.`
      : undefined;

  return (
    <Modal
      open={open}
      onClose={close}
      title={title}
      description={description}
      maxWidthClassName="max-w-2xl"
    >
      {view.kind === "catalog-auth" ? (
        <CatalogSecretForm
          title={view.entry.title}
          description={view.entry.description}
          fields={catalogFields(view.entry)}
          onBack={() => {
            create.reset();
            setView({ kind: "browse" });
          }}
          onSubmit={(values) => submitCatalogAuth(view.entry, values)}
          submitting={create.isPending}
          error={create.error}
        />
      ) : view.kind === "registry-auth" ? (
        <CatalogSecretForm
          title={view.result.title ?? view.result.name}
          description={view.result.description || view.result.name}
          fields={remoteFields(view.remote)}
          onBack={() => {
            create.reset();
            setView({ kind: "browse" });
          }}
          onSubmit={(values) => submitRegistryAuth(view.result, view.remote, values)}
          submitting={create.isPending}
          error={create.error}
        />
      ) : view.kind === "custom" ? (
        <div className="flex flex-col gap-4 pb-1">
          <BackToBrowse onBack={() => setView({ kind: "browse" })} />
          <CustomConnectionForm
            onCreate={(input) =>
              install(input).catch((error) => {
                // Also surfaced inline via create.error under the form.
                void error;
              })
            }
            creating={create.isPending}
            error={create.error}
          />
        </div>
      ) : (
        <div className="flex min-h-[22rem] flex-col gap-4 pb-1">
          <div className="relative">
            <Search
              size={15}
              aria-hidden="true"
              className="pointer-events-none absolute left-3.5 top-1/2 -translate-y-1/2 text-ink-4"
            />
            <Input
              label="Search connectors"
              srOnlyLabel
              placeholder="Search connectors — Linear, Stripe, Postgres…"
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.currentTarget.value)}
              className="pl-9"
            />
          </div>

          {query.trim().length === 0 ? (
            <CatalogBrowse
              addedSlugs={addedSlugs}
              busy={create.isPending}
              onPick={pickCatalogEntry}
            />
          ) : (
            <SearchResults
              query={query.trim()}
              addedSlugs={addedSlugs}
              busy={create.isPending}
              onPickEntry={pickCatalogEntry}
              searchLoading={search.isFetching && search.data === undefined}
              searchUnavailable={search.isError && isSearchUnavailable(search.error)}
              searchError={
                search.isError && !isSearchUnavailable(search.error)
                  ? errorMessage(search.error)
                  : null
              }
              onRetry={() => void search.refetch()}
              results={search.data ?? []}
              onPickResult={pickSearchResult}
            />
          )}

          <button
            type="button"
            onClick={() => {
              create.reset();
              setView({ kind: "custom" });
            }}
            className="lift group mt-auto flex w-full items-center gap-3 rounded-card-lg border border-dashed border-black/15 bg-white/30 p-3 text-left hover:border-black/25 hover:bg-white/55"
          >
            <div className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-black/[0.04] text-ink-3">
              <Globe size={17} strokeWidth={1.9} aria-hidden="true" />
            </div>
            <div className="flex min-w-0 flex-1 flex-col">
              <span className="text-[13.5px] font-semibold text-ink">
                Add a custom server
              </span>
              <span className="truncate text-[12.5px] text-ink-3">
                Connect any MCP server by URL — name, endpoint, and auth.
              </span>
            </div>
          </button>
        </div>
      )}
    </Modal>
  );
}

// ── Browse (no query): featured row + category groups ───────────────────────

function CatalogBrowse({
  addedSlugs,
  busy,
  onPick,
}: {
  addedSlugs: Set<string>;
  busy: boolean;
  onPick: (entry: ConnectorCatalogEntry) => void;
}) {
  // Featured entries lead; the category groups list the rest (no repeats).
  const grouped = CATEGORY_ORDER.map((category) => ({
    category,
    entries: CATALOG.filter(
      (entry) => entry.category === category && entry.featured !== true,
    ),
  })).filter((group) => group.entries.length > 0);

  return (
    <div className="flex flex-col gap-5">
      {FEATURED.length > 0 ? (
        <TileGroup
          label="Featured"
          entries={FEATURED}
          addedSlugs={addedSlugs}
          busy={busy}
          onPick={onPick}
        />
      ) : null}
      {grouped.map((group) => (
        <TileGroup
          key={group.category}
          label={CATEGORY_LABELS[group.category]}
          entries={group.entries}
          addedSlugs={addedSlugs}
          busy={busy}
          onPick={onPick}
        />
      ))}
    </div>
  );
}

function TileGroup({
  label,
  entries,
  addedSlugs,
  busy,
  onPick,
}: {
  label: string;
  entries: ConnectorCatalogEntry[];
  addedSlugs: Set<string>;
  busy: boolean;
  onPick: (entry: ConnectorCatalogEntry) => void;
}) {
  return (
    <section className="flex flex-col gap-2">
      <h3 className="px-0.5 text-[12px] font-semibold uppercase tracking-wide text-ink-4">
        {label}
      </h3>
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        {entries.map((entry) => (
          <CatalogTile
            key={entry.slug}
            entry={entry}
            added={addedSlugs.has(entry.slug)}
            busy={busy}
            onPick={() => onPick(entry)}
          />
        ))}
      </div>
    </section>
  );
}

// ── Search mode: pinned catalog matches over community results ──────────────

function SearchResults({
  query,
  addedSlugs,
  busy,
  onPickEntry,
  searchLoading,
  searchUnavailable,
  searchError,
  onRetry,
  results,
  onPickResult,
}: {
  query: string;
  addedSlugs: Set<string>;
  busy: boolean;
  onPickEntry: (entry: ConnectorCatalogEntry) => void;
  searchLoading: boolean;
  searchUnavailable: boolean;
  searchError: string | null;
  onRetry: () => void;
  results: RegistrySearchResult[];
  onPickResult: (result: RegistrySearchResult) => void;
}) {
  const q = query.toLowerCase();
  const catalogMatches = CATALOG.filter(
    (entry) => entry.title.toLowerCase().includes(q) || entry.slug.includes(q),
  );

  const communityEmpty =
    !searchLoading && !searchUnavailable && searchError === null && results.length === 0;

  return (
    <div className="flex flex-col gap-4">
      {catalogMatches.length > 0 ? (
        <TileGroup
          label="Catalog"
          entries={catalogMatches}
          addedSlugs={addedSlugs}
          busy={busy}
          onPick={onPickEntry}
        />
      ) : null}

      <section className="flex flex-col gap-2">
        <h3 className="px-0.5 text-[12px] font-semibold uppercase tracking-wide text-ink-4">
          Community
        </h3>

        {searchUnavailable ? (
          <p className="rounded-card border border-black/[0.07] bg-white/40 px-3.5 py-3 text-[12.5px] leading-relaxed text-ink-3">
            Community search is unavailable right now. Curated connectors and
            custom servers still work.
          </p>
        ) : searchLoading ? (
          <div
            role="status"
            aria-label="Searching"
            className="flex h-28 items-center justify-center"
          >
            <Spinner size={18} className="text-ink-4" />
          </div>
        ) : searchError !== null ? (
          <ErrorState compact message={searchError} onRetry={onRetry} />
        ) : communityEmpty && catalogMatches.length === 0 ? (
          <EmptyState
            icon={Blocks}
            title="No connectors found"
            description="Nothing matches that search. Try another name or add a custom server."
          />
        ) : communityEmpty ? (
          <p className="px-1 py-2 text-[12.5px] text-ink-4">
            No community servers match that search.
          </p>
        ) : (
          <ul className="flex flex-col gap-2">
            {results.map((result) => (
              <li key={result.name}>
                <SearchResultRow
                  result={result}
                  onPick={() => onPickResult(result)}
                />
              </li>
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

function SearchResultRow({
  result,
  onPick,
}: {
  result: RegistrySearchResult;
  onPick: () => void;
}) {
  const needsSecrets = result.remotes.some((remote) =>
    (remote.headers ?? []).some((header) => header.isSecret),
  );

  return (
    <button
      type="button"
      onClick={onPick}
      className="lift group flex w-full items-center gap-3 rounded-card-lg border border-black/[0.07] bg-white/45 p-3 text-left hover:border-black/15 hover:bg-white/70"
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-black/[0.05] text-ink-2">
        <Blocks size={17} strokeWidth={1.9} aria-hidden="true" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13.5px] font-semibold text-ink">
            {result.title ?? result.name}
          </span>
          {result.verified ? (
            <Chip tone="neutral" className="shrink-0">
              <BadgeCheck size={11} aria-hidden="true" />
              Verified
            </Chip>
          ) : null}
          {needsSecrets ? (
            <span title="Credentials required" className="shrink-0 text-ink-4">
              <Lock size={12} aria-label="Credentials required" />
            </span>
          ) : null}
        </div>
        <span className="truncate text-[12.5px] text-ink-3">
          {result.description || result.name}
        </span>
      </div>
    </button>
  );
}

// ── bits ────────────────────────────────────────────────────────────────────

function BackToBrowse({ onBack }: { onBack: () => void }) {
  return (
    <button
      type="button"
      onClick={onBack}
      className="lift -ml-1 inline-flex w-fit items-center gap-1.5 rounded-capsule px-2 py-1 text-[13px] font-medium text-ink-3 hover:bg-black/[0.04] hover:text-ink"
    >
      <ArrowLeft size={14} aria-hidden="true" />
      All connectors
    </button>
  );
}
