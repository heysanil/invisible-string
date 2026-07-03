import { createFileRoute, Outlet } from "@tanstack/react-router";

import { SettingsNav } from "../components/settings/SettingsNav";

export const Route = createFileRoute("/_app/settings")({ component: SettingsLayout });

/** Settings shell: glass sub-nav + the active section pane. */
function SettingsLayout() {
  return (
    <div className="flex h-full gap-5">
      <SettingsNav />
      <div className="min-w-0 flex-1">
        <Outlet />
      </div>
    </div>
  );
}
