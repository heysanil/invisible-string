import { Link, useRouterState } from "@tanstack/react-router";
import { Building2, Cpu, ListChecks, Plug, Users } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import { cn } from "../../lib/cn";
import { Panel } from "../ui/Panel";

interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

const ITEMS: NavItem[] = [
  { to: "/settings/models", label: "Models", icon: Cpu },
  { to: "/settings/allowlist", label: "Allowlist", icon: ListChecks },
  { to: "/settings/integrations", label: "Integrations", icon: Plug },
  { to: "/settings/members", label: "Members", icon: Users },
  { to: "/settings/workspace", label: "Workspace", icon: Building2 },
];

/** Glass sub-nav for the settings section. */
export function SettingsNav() {
  const pathname = useRouterState({ select: (state) => state.location.pathname });

  return (
    <Panel
      aria-label="Settings sections"
      className="panel-enter hidden w-56 shrink-0 flex-col md:flex"
    >
      <header className="px-5 pb-3 pt-5">
        <h1 className="text-[17px]">Settings</h1>
      </header>
      <div aria-hidden="true" className="mx-5 h-px bg-black/[0.06]" />
      <nav aria-label="Settings" className="flex flex-col gap-0.5 p-3">
        {ITEMS.map((item) => {
          const active = pathname === item.to || pathname.startsWith(`${item.to}/`);
          const Icon = item.icon;
          return (
            <Link
              key={item.to}
              to={item.to}
              aria-current={active ? "page" : undefined}
              className={cn(
                "lift flex items-center gap-2.5 rounded-capsule px-3 py-2 text-[13.5px] font-medium",
                active
                  ? "bg-ink text-white shadow-[0_1px_6px_rgba(0,0,0,0.18)]"
                  : "text-ink-2 hover:bg-black/[0.05] hover:text-ink",
              )}
            >
              <Icon size={16} strokeWidth={active ? 2 : 1.8} aria-hidden="true" />
              {item.label}
            </Link>
          );
        })}
      </nav>
    </Panel>
  );
}
