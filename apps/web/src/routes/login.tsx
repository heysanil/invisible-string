import { useQueryClient } from "@tanstack/react-query";
import {
  createFileRoute,
  Link,
  useNavigate,
  useRouter,
} from "@tanstack/react-router";
import { useState, type FormEvent } from "react";

import { AuthCard } from "../components/auth/AuthCard";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { useToast } from "../components/ui/Toast";
import { signIn } from "../lib/auth-client";
import { completeSignIn } from "../lib/auth/viewer";
import { safeRedirectPath } from "../lib/redirect";
import { isValidEmail } from "../lib/validate";

export const Route = createFileRoute("/login")({
  validateSearch: (search: Record<string, unknown>): { redirect?: string } => ({
    redirect: safeRedirectPath(search["redirect"]),
  }),
  component: LoginPage,
});

interface FieldErrors {
  email?: string;
  password?: string;
}

const FIELD_IDS = { email: "login-email", password: "login-password" } as const;
const FIELD_ORDER = ["email", "password"] as const;

/** Move focus to the first invalid field so keyboard/SR users get a cue. */
function focusFirstError(errors: FieldErrors) {
  const first = FIELD_ORDER.find((field) => errors[field]);
  if (first) document.getElementById(FIELD_IDS[first])?.focus();
}

function LoginPage() {
  const navigate = useNavigate();
  const router = useRouter();
  const queryClient = useQueryClient();
  const { redirect } = Route.useSearch();
  const { toast } = useToast();

  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function validate(): FieldErrors {
    const errors: FieldErrors = {};
    if (!email.trim()) errors.email = "Enter your email.";
    else if (!isValidEmail(email.trim())) errors.email = "Enter a valid email address.";
    if (!password) errors.password = "Enter your password.";
    setFieldErrors(errors);
    return errors;
  }

  function connectionFailed() {
    toast({
      variant: "error",
      title: "Can't reach the server",
      message: "Check that the API is running, then try again.",
    });
    setFormError("Connection failed — nothing was signed in.");
  }

  /**
   * A partial success: the credential call above already succeeded — the
   * session cookie is set and the user IS signed in — and only the
   * follow-up viewer read failed. Reusing `connectionFailed()` here would
   * claim "nothing was signed in", which is false and would leave the user
   * unsure whether it's safe to retry signing in.
   */
  function sessionLoadFailed() {
    toast({
      variant: "error",
      title: "Signed in, but the app couldn't load",
      message: "Reload the page to continue.",
    });
    setFormError("You're signed in — reload the page to continue.");
  }

  async function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setFormError(null);
    const errors = validate();
    if (Object.keys(errors).length > 0) {
      focusFirstError(errors);
      return;
    }
    setSubmitting(true);
    try {
      const { error } = await signIn.email({ email: email.trim(), password });
      if (!error) {
        // Read the session authoritatively BEFORE navigating. Better Auth
        // defers its own session signal by 10ms, so navigating first is how
        // the gate used to see a pre-login snapshot and bounce back here.
        // This also clears the previous principal's query cache.
        try {
          await completeSignIn(queryClient);
        } catch {
          // See sessionLoadFailed(): the credential call above already
          // succeeded, so this must not be reported as a failed sign-in.
          sessionLoadFailed();
          return;
        }
        // `redirect` is pre-validated to a same-app path; history.push keeps
        // the typed router happy with a runtime-known destination.
        if (redirect) router.history.push(redirect);
        else await navigate({ to: "/chat" });
      } else if (!error.status || error.status >= 500) {
        connectionFailed();
      } else {
        setFormError(error.message ?? "Sign-in failed. Check your email and password.");
      }
    } catch {
      connectionFailed();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthCard title="Welcome back" subtitle="Sign in to your workspace">
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        <Input
          id={FIELD_IDS.email}
          label="Email"
          type="email"
          name="email"
          autoComplete="email"
          placeholder="you@company.com"
          value={email}
          onChange={(e) => {
            setEmail(e.target.value);
            if (fieldErrors.email) setFieldErrors((f) => ({ ...f, email: undefined }));
          }}
          error={fieldErrors.email ?? null}
        />
        <Input
          id={FIELD_IDS.password}
          label="Password"
          type="password"
          name="password"
          autoComplete="current-password"
          placeholder="Your password"
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            if (fieldErrors.password)
              setFieldErrors((f) => ({ ...f, password: undefined }));
          }}
          error={fieldErrors.password ?? null}
        />
        {formError ? (
          <p role="alert" className="px-1 text-center text-[13px] text-err">
            {formError}
          </p>
        ) : null}
        <Button type="submit" loading={submitting} className="mt-1 w-full">
          {submitting ? "Signing in…" : "Sign in"}
        </Button>
      </form>
      <p className="mt-6 text-center text-[13px] text-ink-3">
        No account yet?{" "}
        <Link
          to="/signup"
          search={{ redirect }}
          className="font-medium text-ink underline-offset-4 hover:underline"
        >
          Create one
        </Link>
      </p>
    </AuthCard>
  );
}
