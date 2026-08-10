/**
 * One curated-catalog connector tile (add-connection dialog, spec §10 v1):
 * E1 monogram (first letter of the title on an ink-scale capsule — no brand
 * assets in v1), title, one-line description, and an auth badge. A connector
 * already installed in the current scope renders as a disabled "Added" tile.
 */
import { Check } from "lucide-react";
import type { ConnectorCatalogEntry } from "@invisible-string/shared";

import { cn } from "../../lib/cn";
import { Chip } from "../ui/Chip";

export interface CatalogTileProps {
  entry: ConnectorCatalogEntry;
  /** A connection with this catalogSlug already exists in the scope. */
  added: boolean;
  /** An install for this entry is in flight. */
  busy?: boolean;
  onPick: () => void;
}

/** What the user will be asked for, at a glance. */
function authLabel(entry: ConnectorCatalogEntry): string {
  return entry.auth.type === "none" ? "No auth" : "API key";
}

export function CatalogTile({ entry, added, busy = false, onPick }: CatalogTileProps) {
  return (
    <button
      type="button"
      onClick={onPick}
      disabled={added || busy}
      aria-label={
        added ? `${entry.title} — already added` : `Add ${entry.title}`
      }
      className={cn(
        "lift group flex w-full items-center gap-3 rounded-card-lg border p-3 text-left",
        added
          ? "cursor-default border-black/[0.05] bg-white/30"
          : "border-black/[0.07] bg-white/45 hover:border-black/15 hover:bg-white/70",
        busy && "opacity-60",
      )}
    >
      <div
        aria-hidden="true"
        className={cn(
          "flex size-9 shrink-0 items-center justify-center rounded-[10px] text-[15px] font-semibold",
          added ? "bg-black/[0.04] text-ink-4" : "bg-black/[0.06] text-ink-2",
        )}
      >
        {entry.title.charAt(0).toUpperCase()}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              "truncate text-[13.5px] font-semibold",
              added ? "text-ink-3" : "text-ink",
            )}
          >
            {entry.title}
          </span>
          {added ? (
            <Chip tone="neutral" className="shrink-0">
              <Check size={11} aria-hidden="true" />
              Added
            </Chip>
          ) : (
            <span className="shrink-0 text-[11px] text-ink-4">{authLabel(entry)}</span>
          )}
        </div>
        <span className="truncate text-[12.5px] text-ink-3">{entry.description}</span>
      </div>
    </button>
  );
}
