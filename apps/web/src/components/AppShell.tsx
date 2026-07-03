import { Link, useRouterState } from "@tanstack/react-router";
import { Blocks, MessageCircle, Settings, Zap } from "lucide-react";
import { useRef, type KeyboardEvent, type ReactNode } from "react";

import { cn } from "../lib/cn";
import { LogoMark } from "./LogoMark";
import { Tooltip } from "./ui/Tooltip";

export const NAV_ITEMS = [
  { to: "/chat", label: "Chat", icon: MessageCircle },
  { to: "/workflows", label: "Workflows", icon: Zap },
  { to: "/context", label: "Context", icon: Blocks },
  { to: "/settings", label: "Settings", icon: Settings },
] as const;

export function AppShell({ children }: { children: ReactNode }) {
  return (
    <div className="h-dvh">
      <Dock />
      <main className="h-full py-5 pl-24 pr-5">{children}</main>
    </div>
  );
}

/** Floating vertical glass dock: logo mark + primary sections. */
function Dock() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const linkRefs = useRef<Array<HTMLAnchorElement | null>>([]);

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    const links = linkRefs.current.filter(
      (el): el is HTMLAnchorElement => el !== null,
    );
    if (links.length === 0) return;
    event.preventDefault();

    const current = links.findIndex((el) => el === document.activeElement);
    let next: number;
    switch (event.key) {
      case "ArrowDown":
        next = current < 0 ? 0 : (current + 1) % links.length;
        break;
      case "ArrowUp":
        next = current < 0 ? links.length - 1 : (current - 1 + links.length) % links.length;
        break;
      case "End":
        next = links.length - 1;
        break;
      default:
        next = 0;
    }
    links[next]?.focus();
  }

  return (
    <nav
      aria-label="Primary"
      onKeyDown={onKeyDown}
      className="glass-dock fixed left-4 top-1/2 z-40 flex -translate-y-1/2 flex-col items-center gap-1 px-2 py-3"
    >
      <div
        aria-hidden="true"
        className="mb-1 flex size-10 items-center justify-center text-ink"
      >
        <LogoMark size={19} />
      </div>
      <div aria-hidden="true" className="mb-1.5 h-px w-5 bg-black/10" />
      {NAV_ITEMS.map((item, index) => {
        const isActive =
          pathname === item.to || pathname.startsWith(`${item.to}/`);
        const Icon = item.icon;
        return (
          <Tooltip key={item.to} label={item.label}>
            <Link
              ref={(el) => {
                linkRefs.current[index] = el;
              }}
              to={item.to}
              aria-label={item.label}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "lift flex size-10 items-center justify-center rounded-full",
                isActive
                  ? "bg-ink text-white shadow-[0_2px_10px_rgba(0,0,0,0.25)]"
                  : "text-ink-3 hover:bg-black/[0.05] hover:text-ink",
              )}
            >
              <Icon size={19} strokeWidth={isActive ? 2 : 1.75} aria-hidden="true" />
            </Link>
          </Tooltip>
        );
      })}
    </nav>
  );
}
