import { useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";

import { authClient } from "../../lib/auth-client";
import { completeSignOut, refetchViewer } from "../../lib/auth/viewer";
import { workspaceSlug } from "../../lib/slug";
import { AuthCard } from "../auth/AuthCard";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";
import { useToast } from "../ui/Toast";

const NAME_MAX = 64;
const FIELD_ID = "workspace-name";

/**
 * First-run onboarding: a signed-in user with no workspace names one and
 * lands in the shell. Creation MUST go through `authClient` — the server's
 * afterCreateOrganization hook seeds the locked workspace defaults.
 * `/organization/create` also activates the new organization server-side
 * (better-auth's crud-org.mjs), so there is no client-side `setActive` round
 * trip here — only a `refetchViewer` (viewer.ts), which is what flips the
 * `_app` gate into the shell.
 */
export function CreateWorkspaceScreen() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { toast } = useToast();

  const [name, setName] = useState("");
  const [fieldError, setFieldError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [signingOut, setSigningOut] = useState(false);

  function validate(): string | null {
    if (!name.trim()) return "Name your workspace.";
    if (name.trim().length > NAME_MAX)
      return `Use at most ${NAME_MAX} characters.`;
    return null;
  }

  function connectionFailed() {
    toast({
      variant: "error",
      title: "Can't reach the server",
      message: "Check that the API is running, then try again.",
    });
    setFormError("Connection failed — try again.");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    const invalid = validate();
    if (invalid) {
      setFieldError(invalid);
      document.getElementById(FIELD_ID)?.focus();
      return;
    }
    setSubmitting(true);
    try {
      const trimmed = name.trim();
      const created = await authClient.organization.create({
        name: trimmed,
        slug: workspaceSlug(trimmed),
      });
      if (created.error) {
        if (!created.error.status || created.error.status >= 500) {
          connectionFailed();
        } else {
          setFormError(
            created.error.message ?? "Could not create the workspace.",
          );
        }
        return;
      }
      // The server activates the new organization as part of /organization/create,
      // so no setActive round trip is needed — only a fresh read of the viewer.
      // No navigation either: the layout flips into the shell at this URL.
      //
      // The workspace EXISTS from here on. A refresh failure is a partial
      // success: never tell the user nothing was created, or they will create
      // a second one.
      try {
        await refetchViewer(queryClient);
        toast({ variant: "success", message: "Workspace created." });
      } catch {
        toast({
          variant: "error",
          title: "Workspace created",
          message: "Couldn't load it just yet — reload to continue.",
        });
      }
      return;
    } catch {
      connectionFailed();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await completeSignOut(queryClient);
      await navigate({ to: "/login" });
    } catch {
      toast({ variant: "error", message: "Could not sign out. Try again." });
      setSigningOut(false);
    }
  }

  return (
    <AuthCard
      title="Create your workspace"
      subtitle="Workflows, context, and members live in a workspace"
    >
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        <Input
          id={FIELD_ID}
          label="Workspace name"
          type="text"
          name="workspace"
          autoComplete="organization"
          placeholder="Acme Inc"
          autoFocus
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (fieldError) setFieldError(null);
          }}
          error={fieldError}
        />
        {formError ? (
          <p role="alert" className="px-1 text-center text-[13px] text-err">
            {formError}
          </p>
        ) : null}
        <Button type="submit" loading={submitting} className="mt-1 w-full">
          {submitting ? "Creating…" : "Create workspace"}
        </Button>
      </form>
      <p className="mt-6 text-center text-[13px] text-ink-3">
        Have an invite link? Open it to join an existing workspace instead.
      </p>
      <p className="mt-2 text-center text-[13px] text-ink-3">
        Wrong account?{" "}
        <button
          type="button"
          onClick={() => void handleSignOut()}
          disabled={signingOut}
          className="font-medium text-ink underline-offset-4 hover:underline disabled:opacity-55"
        >
          Sign out
        </button>
      </p>
    </AuthCard>
  );
}
