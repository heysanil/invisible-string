import { ChevronDown, Menu } from "lucide-react";
import { useState } from "react";

import type { SidebarSection } from "../../lib/sidebar";
import { DocSidebar } from "./DocSidebar";

export interface MobileDocNavProps {
  sections: SidebarSection[];
  currentSlug: string;
  currentTitle: string;
}

/**
 * Sub-`lg` docs navigation: a glass disclosure capsule that expands the full
 * `DocSidebar` inline. Controlled (not a native `<details>`) so choosing a link
 * collapses it. Hidden at `lg+`, where the persistent rail takes over.
 */
export function MobileDocNav({ sections, currentSlug, currentTitle }: MobileDocNavProps) {
  const [open, setOpen] = useState(false);

  return (
    <div className="lg:hidden">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="lift glass-panel flex w-full items-center gap-3 rounded-panel-sm px-4 py-3 text-left text-sm"
      >
        <Menu size={16} strokeWidth={1.75} className="shrink-0 text-ink-3" aria-hidden="true" />
        <span className="min-w-0 flex-1 truncate">
          <span className="text-ink-4">Docs / </span>
          <span className="font-medium text-ink">{currentTitle}</span>
        </span>
        <ChevronDown
          size={16}
          strokeWidth={1.75}
          aria-hidden="true"
          className={`shrink-0 text-ink-3 transition-transform duration-200 ${open ? "rotate-180" : ""}`}
        />
      </button>
      {open ? (
        <div className="glass-panel panel-enter mt-2 rounded-panel-sm p-4">
          <DocSidebar
            sections={sections}
            currentSlug={currentSlug}
            onNavigate={() => setOpen(false)}
          />
        </div>
      ) : null}
    </div>
  );
}
