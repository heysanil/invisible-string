import { useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";

import { authClient, signOut } from "../../lib/auth-client";
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
 * afterCreateOrganization hook seeds the locked workspace defaults, and the
 * client's $listOrg store refetches on create so the `_app` gate flips
 * without a reload or navigation.
 */
export function CreateWorkspaceScreen() {
  const navigate = useNavigate();
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
    setFormError("Connection failed — nothing was created.");
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
      await authClient.organization.setActive({
        organizationId: created.data.id,
      });
      toast({ variant: "success", message: "Workspace created." });
      // No navigation: the org-list store refetched on create, so the
      // `_app` gate re-renders into the shell at the current URL.
    } catch {
      connectionFailed();
    } finally {
      setSubmitting(false);
    }
  }

  async function handleSignOut() {
    setSigningOut(true);
    try {
      await signOut();
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
