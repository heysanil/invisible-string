import {
  createFileRoute,
  Navigate,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { useEffect, useState, type ReactNode } from "react";

import { AuthCard } from "../components/auth/AuthCard";
import { Button } from "../components/ui/Button";
import { Chip } from "../components/ui/Chip";
import { Spinner } from "../components/ui/Spinner";
import { useToast } from "../components/ui/Toast";
import { authClient, signOut } from "../lib/auth-client";

export const Route = createFileRoute("/accept-invitation/$invitationId")({
  component: AcceptInvitationPage,
});

/** Shape returned by GET /organization/get-invitation (Better Auth 1.6.23). */
interface InvitationDetails {
  id: string;
  email: string;
  role: string;
  status: string;
  organizationId: string;
  organizationName: string;
  inviterEmail: string;
}

type InviteView =
  | { kind: "loading" }
  | { kind: "ready"; invitation: InvitationDetails }
  | { kind: "declined"; organizationName: string }
  | { kind: "error"; variant: "not-found" | "wrong-account" | "connection" };

/**
 * Map Better Auth's get/accept invitation failures onto designed states.
 * The server collapses expired, revoked, and already-handled invitations
 * into one 400 ("Invitation not found!"), so the UI gets exactly two
 * distinguishable failure modes plus connection trouble.
 */
function variantFor(status?: number): "not-found" | "wrong-account" | "connection" {
  if (status === 403) return "wrong-account";
  if (status && status < 500) return "not-found";
  return "connection";
}

type SessionProbe = "checking" | "authenticated" | "unauthenticated";

function AcceptInvitationPage() {
  const { invitationId } = Route.useParams();
  const [sessionProbe, setSessionProbe] = useState<SessionProbe>("checking");
  const navigate = useNavigate();
  const router = useRouter();
  const { toast } = useToast();

  const [view, setView] = useState<InviteView>({ kind: "loading" });
  const [acting, setActing] = useState<"accept" | "decline" | null>(null);
  const [signingOut, setSigningOut] = useState(false);
  const [attempt, setAttempt] = useState(0);

  // The shared useSession() atom can hold a stale resolved-null snapshot
  // right after the login/signup round-trip (no subscriber lives on the auth
  // screens, and the remount refetch is deferred a macrotask), which bounced
  // fresh invitees straight back to /login. Probe the server directly and
  // gate the redirect on the answer instead of trusting the cached snapshot.
  useEffect(() => {
    let cancelled = false;
    setSessionProbe("checking");
    void authClient
      .getSession()
      .then(({ data }) => {
        if (cancelled) return;
        setSessionProbe(data ? "authenticated" : "unauthenticated");
      })
      .catch(() => {
        if (!cancelled) setSessionProbe("unauthenticated");
      });
    return () => {
      cancelled = true;
    };
  }, [invitationId]);

  useEffect(() => {
    if (sessionProbe !== "authenticated") return;
    let cancelled = false;
    setView({ kind: "loading" });
    void authClient.organization
      .getInvitation({ query: { id: invitationId } })
      .then(({ data, error }) => {
        if (cancelled) return;
        if (error || !data) {
          setView({ kind: "error", variant: variantFor(error?.status) });
        } else {
          setView({
            kind: "ready",
            invitation: data as unknown as InvitationDetails,
          });
        }
      })
      .catch(() => {
        if (!cancelled) setView({ kind: "error", variant: "connection" });
      });
    return () => {
      cancelled = true;
    };
  }, [sessionProbe, invitationId, attempt]);

  if (sessionProbe === "checking") {
    return (
      <InviteCard subtitle="Checking your session">
        <CenteredSpinner label="Loading invitation" />
      </InviteCard>
    );
  }

  if (sessionProbe === "unauthenticated") {
    return (
      <Navigate
        to="/login"
        search={{ redirect: `/accept-invitation/${invitationId}` }}
        replace
      />
    );
  }

  async function accept(invitation: InvitationDetails) {
    setActing("accept");
    try {
      const { error } = await authClient.organization.acceptInvitation({
        invitationId,
      });
      if (error) {
        setView({ kind: "error", variant: variantFor(error.status) });
        return;
      }
      await authClient.organization.setActive({
        organizationId: invitation.organizationId,
      });
      toast({
        variant: "success",
        message: `Joined ${invitation.organizationName}.`,
      });
      await navigate({ to: "/chat" });
    } catch {
      setView({ kind: "error", variant: "connection" });
    } finally {
      setActing(null);
    }
  }

  async function decline(invitation: InvitationDetails) {
    setActing("decline");
    try {
      const { error } = await authClient.organization.rejectInvitation({
        invitationId,
      });
      if (error) {
        setView({ kind: "error", variant: variantFor(error.status) });
        return;
      }
      setView({
        kind: "declined",
        organizationName: invitation.organizationName,
      });
    } catch {
      setView({ kind: "error", variant: "connection" });
    } finally {
      setActing(null);
    }
  }

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await signOut();
      // Round-trip back to this invitation once the right account signs in.
      router.history.push(
        `/login?redirect=${encodeURIComponent(`/accept-invitation/${invitationId}`)}`,
      );
    } catch {
      toast({ variant: "error", message: "Could not sign out. Try again." });
      setSigningOut(false);
    }
  }

  if (view.kind === "loading") {
    return (
      <InviteCard subtitle="Loading the invitation">
        <CenteredSpinner label="Loading invitation" />
      </InviteCard>
    );
  }

  if (view.kind === "ready") {
    const { invitation } = view;
    return (
      <AuthCard
        title={`Join ${invitation.organizationName}`}
        subtitle={`${invitation.inviterEmail} invited you to this workspace`}
      >
        <div className="flex items-center justify-between border-y border-black/[0.06] px-1 py-3">
          <span className="text-[13px] text-ink-3">You&rsquo;ll join as</span>
          <Chip>{invitation.role}</Chip>
        </div>
        <div className="mt-5 flex gap-2.5">
          <Button
            variant="ghost"
            className="flex-1"
            loading={acting === "decline"}
            disabled={acting !== null}
            onClick={() => void decline(invitation)}
          >
            Decline
          </Button>
          <Button
            className="flex-1"
            loading={acting === "accept"}
            disabled={acting !== null}
            onClick={() => void accept(invitation)}
          >
            Accept invitation
          </Button>
        </div>
      </AuthCard>
    );
  }

  if (view.kind === "declined") {
    return (
      <AuthCard
        title="Invitation declined"
        subtitle={`You won't be added to ${view.organizationName}`}
      >
        <Button className="w-full" onClick={() => void navigate({ to: "/chat" })}>
          Continue
        </Button>
      </AuthCard>
    );
  }

  if (view.variant === "wrong-account") {
    return (
      <AuthCard
        title="This invitation belongs to another account"
        subtitle="It was sent to a different email than the one you're signed in with"
      >
        <Button
          className="w-full"
          loading={signingOut}
          onClick={() => void handleSignOut()}
        >
          Sign out
        </Button>
      </AuthCard>
    );
  }

  if (view.variant === "not-found") {
    return (
      <AuthCard
        title="This invitation is no longer valid"
        subtitle="It may have expired, been revoked, or already been used"
      >
        <Button className="w-full" onClick={() => void navigate({ to: "/chat" })}>
          Go to the app
        </Button>
      </AuthCard>
    );
  }

  return (
    <AuthCard
      title="Can't load this invitation"
      subtitle="Check your connection, then try again"
    >
      <Button className="w-full" onClick={() => setAttempt((n) => n + 1)}>
        Try again
      </Button>
    </AuthCard>
  );
}

/** Neutral frame for the pre-content states (session check, loading). */
function InviteCard({
  subtitle,
  children,
}: {
  subtitle: string;
  children: ReactNode;
}) {
  return (
    <AuthCard title="Workspace invitation" subtitle={subtitle}>
      {children}
    </AuthCard>
  );
}

function CenteredSpinner({ label }: { label: string }) {
  return (
    <div
      role="status"
      aria-label={label}
      className="flex items-center justify-center py-2"
    >
      <Spinner size={18} className="text-ink-4" />
    </div>
  );
}
