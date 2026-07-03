import type { ReactNode } from "react";

import { LogoMark } from "../LogoMark";

export interface AuthCardProps {
  title: string;
  subtitle: string;
  children: ReactNode;
}

/** Centered floating glass card over the wash — frame for login/signup. */
export function AuthCard({ title, subtitle, children }: AuthCardProps) {
  return (
    <main className="flex min-h-dvh items-center justify-center p-6">
      <div className="glass-panel panel-enter w-full max-w-sm px-8 py-9">
        <div className="mb-7 flex flex-col items-center gap-4 text-center">
          <div
            aria-hidden="true"
            className="flex size-11 items-center justify-center rounded-full bg-ink text-white shadow-[0_4px_16px_rgba(0,0,0,0.25)]"
          >
            <LogoMark size={17} />
          </div>
          <div className="flex flex-col gap-1">
            <h1 className="text-xl">{title}</h1>
            <p className="text-sm text-ink-3">{subtitle}</p>
          </div>
        </div>
        {children}
      </div>
    </main>
  );
}
