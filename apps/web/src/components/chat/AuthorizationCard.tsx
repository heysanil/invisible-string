/**
 * Inline card for a mid-run MCP consent challenge (`authorization.required`)
 * — the waiting-amber treatment ApprovalCard established (amber is E1's
 * "waiting on you"), resolving in place on `authorization.completed`.
 *
 * SECURITY (spec §13): the consent URL is SERVER-SUPPLIED content rendered
 * inside trusted chrome. The target host is therefore displayed prominently,
 * separate from the link itself, so the user sees where consent goes before
 * clicking — and the link opens in a new tab with `rel="noopener noreferrer"`.
 *
 * DORMANT on eve 0.31.3 for platform connections: a getToken-only connection
 * surfaces a mid-run 401 as a plain failed tool call and never emits
 * `authorization.required` (spike REPORT finding 34). Rendered defensively
 * against eve's declared wire types so an eve upgrade that starts emitting
 * them gets a consent card, not a dropped event.
 */
import { useEffect, useState } from "react";
import {
  Ban,
  Clock,
  ExternalLink,
  ShieldAlert,
  ShieldCheck,
  ShieldX,
  type LucideIcon,
} from "lucide-react";

import type { AuthorizationView } from "../../lib/chat/run-view";
import { cn } from "../../lib/cn";

/** Presentation for each resolved outcome — color only as meaning (E1). */
const OUTCOME_PRESENTATION: Record<
  Exclude<AuthorizationView["outcome"], null>,
  { icon: LucideIcon; label: string; iconClass: string }
> = {
  authorized: { icon: ShieldCheck, label: "Authorized", iconClass: "text-ok" },
  // Declining is a user decision, not an error — neutral ink, like Stop.
  declined: { icon: Ban, label: "Declined", iconClass: "text-ink-3" },
  failed: { icon: ShieldX, label: "Authorization failed", iconClass: "text-err" },
  "timed-out": { icon: Clock, label: "Timed out", iconClass: "text-ink-3" },
};

/** "4m 32s" / "32s"; null once past. */
function remainingLabel(expiresAt: string, now: number): string | null {
  const ms = Date.parse(expiresAt) - now;
  if (!Number.isFinite(ms) || ms <= 0) return null;
  const totalSeconds = Math.ceil(ms / 1000);
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes > 0 ? `${minutes}m ${seconds}s` : `${seconds}s`;
}

export interface AuthorizationCardProps {
  authorization: AuthorizationView;
}

export function AuthorizationCard({ authorization }: AuthorizationCardProps) {
  const pending = authorization.outcome === null;
  const hasCountdown = pending && authorization.expiresAt !== null;
  const [now, setNow] = useState(() => Date.now());

  // Tick the countdown once a second while it is live. A text update is not
  // motion, so no reduced-motion branch; the interval dies with the countdown
  // (expiry text settles at "Expired") and with the card resolving.
  useEffect(() => {
    if (!hasCountdown) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [hasCountdown]);

  const remaining = hasCountdown
    ? remainingLabel(authorization.expiresAt!, now)
    : null;

  if (!pending) {
    const { icon: OutcomeIcon, label, iconClass } =
      OUTCOME_PRESENTATION[authorization.outcome!];
    return (
      <div
        role="group"
        aria-label="Authorization resolved"
        data-authorization-outcome={authorization.outcome}
        className="my-2 flex items-start gap-2.5 rounded-card border border-black/[0.08] bg-black/[0.03] px-3.5 py-2.5"
      >
        <OutcomeIcon
          size={15}
          strokeWidth={2}
          aria-hidden="true"
          className={cn("mt-0.5 shrink-0", iconClass)}
        />
        <div className="min-w-0 text-[13px] leading-snug text-ink">
          <span className="font-medium">{label}</span>
          <span className="text-ink-2"> · {authorization.name}</span>
          {authorization.reason !== null ? (
            <p className="mt-0.5 text-[12px] text-ink-3">{authorization.reason}</p>
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div
      role="group"
      aria-label="Authorization required"
      data-authorization-outcome="pending"
      className="my-2 rounded-card border border-warn/45 bg-warn/[0.06] p-3.5"
    >
      <div className="flex items-start gap-2.5">
        <ShieldAlert
          size={15}
          strokeWidth={2}
          aria-hidden="true"
          className="mt-0.5 shrink-0 text-warn"
        />
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium uppercase tracking-[0.06em] text-ink-4">
            Authorization
          </p>
          <p className="mt-0.5 text-[13px] font-medium leading-snug text-ink">
            Connection “{authorization.name}” needs your authorization.
          </p>
          {authorization.description !== null ? (
            <p className="mt-0.5 text-[12px] text-ink-3">
              {authorization.description}
            </p>
          ) : null}

          {/* The target host, PROMINENT and outside the link (spec §13). */}
          {authorization.host !== null ? (
            <p className="mt-2 text-[12px] text-ink-3">
              Consent page host{" "}
              <span className="ml-1 rounded-capsule border border-black/10 bg-white/60 px-2 py-0.5 font-mono text-[12px] font-semibold text-ink">
                {authorization.host}
              </span>
            </p>
          ) : null}

          {authorization.instructions !== null ? (
            <p className="mt-2 text-[12.5px] leading-snug text-ink-2">
              {authorization.instructions}
            </p>
          ) : null}

          {authorization.userCode !== null ? (
            <p className="mt-2 text-[12px] text-ink-3">
              Your code{" "}
              <span className="ml-1 rounded-md border border-black/10 bg-white/70 px-2 py-0.5 font-mono text-[13px] font-semibold tracking-[0.08em] text-ink">
                {authorization.userCode}
              </span>
            </p>
          ) : null}

          {hasCountdown ? (
            <p className="mt-2 text-[12px] text-ink-3">
              {remaining !== null ? `Expires in ${remaining}` : "Expired"}
            </p>
          ) : null}

          {authorization.url !== null ? (
            <div className="mt-3">
              <a
                href={authorization.url}
                target="_blank"
                rel="noopener noreferrer"
                className="lift inline-flex h-8 items-center gap-1.5 rounded-capsule bg-ink px-4 text-[13px] font-medium text-white"
              >
                Authorize in browser
                <ExternalLink size={12} strokeWidth={2.2} aria-hidden="true" />
              </a>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
