import type { ReactNode } from "react";

import { Panel } from "../ui/Panel";

export interface SettingsSectionProps {
  title: string;
  description?: string;
  /** Optional control in the header (e.g. an "Add" button). */
  action?: ReactNode;
  children: ReactNode;
}

/** The main-pane container for one settings sub-section. */
export function SettingsSection({
  title,
  description,
  action,
  children,
}: SettingsSectionProps) {
  return (
    <Panel className="panel-enter flex h-full min-w-0 flex-col overflow-hidden">
      <header className="flex items-start justify-between gap-3 px-6 pb-4 pt-5">
        <div className="flex min-w-0 flex-col gap-0.5">
          <h1 className="text-[17px]">{title}</h1>
          {description ? (
            <p className="text-[13px] leading-relaxed text-ink-3">{description}</p>
          ) : null}
        </div>
        {action ? <div className="shrink-0">{action}</div> : null}
      </header>
      <div aria-hidden="true" className="mx-6 h-px bg-black/[0.06]" />
      <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>
    </Panel>
  );
}
