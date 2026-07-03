import type { ReactNode } from "react";

import { Panel } from "./ui/Panel";

export interface SectionPageProps {
  title: string;
  /** Muted hint shown in the (still empty) list panel. */
  listHint: string;
  /** Optional control rendered in the list-panel header. */
  listAction?: ReactNode;
  /** Main-pane content (usually an EmptyState for now). */
  children: ReactNode;
}

/** Standard section layout: floating list panel + floating main pane. */
export function SectionPage({ title, listHint, listAction, children }: SectionPageProps) {
  return (
    <div className="flex h-full gap-5">
      <Panel
        aria-label={`${title} list`}
        className="panel-enter hidden w-72 shrink-0 flex-col md:flex"
      >
        <header className="flex items-center justify-between px-5 pb-3 pt-5">
          <h1 className="text-[17px]">{title}</h1>
          {listAction}
        </header>
        <div aria-hidden="true" className="mx-5 h-px bg-black/[0.06]" />
        <div className="flex flex-1 items-center justify-center px-6 py-8">
          <p className="text-center text-[13px] leading-relaxed text-ink-4">
            {listHint}
          </p>
        </div>
      </Panel>
      <Panel className="panel-enter min-w-0 flex-1 overflow-hidden">
        {children}
      </Panel>
    </div>
  );
}
