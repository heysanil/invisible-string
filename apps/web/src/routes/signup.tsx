import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useState, type FormEvent } from "react";

import { AuthCard } from "../components/auth/AuthCard";
import { Button } from "../components/ui/Button";
import { Input } from "../components/ui/Input";
import { useToast } from "../components/ui/Toast";
import { signUp } from "../lib/auth-client";
import { isValidEmail, PASSWORD_MIN_LENGTH } from "../lib/validate";

export const Route = createFileRoute("/signup")({ component: SignupPage });

interface FieldErrors {
  name?: string;
  email?: string;
  password?: string;
}

const FIELD_IDS = {
  name: "signup-name",
  email: "signup-email",
  password: "signup-password",
} as const;
const FIELD_ORDER = ["name", "email", "password"] as const;

/** Move focus to the first invalid field so keyboard/SR users get a cue. */
function focusFirstError(errors: FieldErrors) {
  const first = FIELD_ORDER.find((field) => errors[field]);
  if (first) document.getElementById(FIELD_IDS[first])?.focus();
}

function SignupPage() {
  const navigate = useNavigate();
  const { toast } = useToast();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [fieldErrors, setFieldErrors] = useState<FieldErrors>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function validate(): FieldErrors {
    const errors: FieldErrors = {};
    if (!name.trim()) errors.name = "Enter your name.";
    if (!email.trim()) errors.email = "Enter your email.";
    else if (!isValidEmail(email.trim())) errors.email = "Enter a valid email address.";
    if (!password) errors.password = "Choose a password.";
    else if (password.length < PASSWORD_MIN_LENGTH)
      errors.password = `Use at least ${PASSWORD_MIN_LENGTH} characters.`;
    setFieldErrors(errors);
    return errors;
  }

  function connectionFailed() {
    toast({
      variant: "error",
      title: "Can't reach the server",
      message: "Check that the API is running, then try again.",
    });
    setFormError("Connection failed — no account was created.");
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
      const { error } = await signUp.email({
        name: name.trim(),
        email: email.trim(),
        password,
      });
      if (!error) {
        await navigate({ to: "/chat" });
      } else if (!error.status || error.status >= 500) {
        connectionFailed();
      } else {
        setFormError(error.message ?? "Sign-up failed. Try a different email.");
      }
    } catch {
      connectionFailed();
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthCard title="Create your account" subtitle="A workspace for your agents">
      <form onSubmit={handleSubmit} noValidate className="flex flex-col gap-4">
        <Input
          id={FIELD_IDS.name}
          label="Name"
          type="text"
          name="name"
          autoComplete="name"
          placeholder="Ada Lovelace"
          value={name}
          onChange={(e) => {
            setName(e.target.value);
            if (fieldErrors.name) setFieldErrors((f) => ({ ...f, name: undefined }));
          }}
          error={fieldErrors.name ?? null}
        />
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
          autoComplete="new-password"
          placeholder={`At least ${PASSWORD_MIN_LENGTH} characters`}
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
          {submitting ? "Creating account…" : "Create account"}
        </Button>
      </form>
      <p className="mt-6 text-center text-[13px] text-ink-3">
        Already have an account?{" "}
        <Link
          to="/login"
          className="font-medium text-ink underline-offset-4 hover:underline"
        >
          Sign in
        </Link>
      </p>
    </AuthCard>
  );
}
