import { Blocks, ChevronRight, Lock } from "lucide-react";
import type { RegistryServerSummary } from "@invisible-string/shared";

export interface RegistryResultCardProps {
  server: RegistryServerSummary;
  onPick: () => void;
}

/** Count the secret declarations across the server + its remotes. */
function secretCount(server: RegistryServerSummary): number {
  const names = new Set<string>();
  for (const decl of server.envVarDeclarations) {
    if (decl.isSecret) names.add(decl.name);
  }
  for (const remote of server.remotes) {
    for (const header of remote.headers ?? []) {
      if (header.isSecret) names.add(header.name);
    }
  }
  return names.size;
}

export function RegistryResultCard({ server, onPick }: RegistryResultCardProps) {
  const installable = server.remotes.length > 0;
  const secrets = secretCount(server);

  return (
    <button
      type="button"
      onClick={onPick}
      disabled={!installable}
      className="lift group flex w-full items-center gap-3 rounded-card-lg border border-black/[0.07] bg-white/45 p-3 text-left hover:border-black/15 hover:bg-white/70 disabled:pointer-events-none disabled:opacity-55"
    >
      <div className="flex size-9 shrink-0 items-center justify-center rounded-[10px] bg-black/[0.05] text-ink-2">
        <Blocks size={17} strokeWidth={1.9} aria-hidden="true" />
      </div>
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2">
          <span className="truncate text-[13.5px] font-semibold text-ink">
            {server.title ?? server.name}
          </span>
          <span className="shrink-0 text-[11px] text-ink-4">v{server.version}</span>
          {secrets > 0 ? (
            <span
              title={`${secrets} credential${secrets === 1 ? "" : "s"} required`}
              className="text-ink-4"
            >
              <Lock size={12} aria-label="Credentials required" />
            </span>
          ) : null}
        </div>
        <span className="truncate text-[12.5px] text-ink-3">
          {installable
            ? server.description || server.name
            : "No hosted endpoint — not installable"}
        </span>
      </div>
      <ChevronRight
        size={16}
        aria-hidden="true"
        className="shrink-0 text-ink-4 transition-transform duration-150 group-hover:translate-x-0.5"
      />
    </button>
  );
}
