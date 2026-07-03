import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";

import { AuthCard } from "../components/auth/AuthCard";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { useToast } from "../components/ui/Toast";
import { signIn } from "../lib/auth-client";
import { isValidEmail } from "../lib/validate";

export const Route = createFileRoute("/login")({ component: LoginPage });

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
        await navigate({ to: "/chat" });
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
          className="font-medium text-ink underline-offset-4 hover:underline"
        >
          Create one
        </Link>
      </p>
    </AuthCard>
  );
}
