/**
 * One-shot secret form for the add-connection dialog. Renders the fields a
 * recipe declares (catalog `bearer` token / catalog `headers` / a community
 * remote's header declarations), validates required values locally BEFORE any
 * request, and hands the values up exactly once — they are gathered in local
 * state, sent via the encrypted `auth` field, and never read back (the
 * created connection carries only `hasCredentials`).
 */
import { ArrowLeft } from "lucide-react";
import { useState } from "react";

import { errorMessage } from "../../lib/forms";
import { Button } from "../ui/Button";
import { Input } from "../ui/Input";

/** One value the recipe asks for. `key` is the auth-map key sent upstream. */
export interface SecretFormField {
  key: string;
  label: string;
  /** Where to find the value (rendered as placeholder). */
  hint?: string;
  /** Render as a password input and never as plain text. */
  secret: boolean;
  required: boolean;
}

export interface CatalogSecretFormProps {
  /** Connector heading — e.g. the catalog title or registry server name. */
  title: string;
  /** Supporting line under the heading (card copy / server description). */
  description?: string;
  fields: SecretFormField[];
  onBack: () => void;
  /** Called once with the trimmed, non-empty values keyed by field key. */
  onSubmit: (values: Record<string, string>) => Promise<unknown>;
  submitting: boolean;
  error?: unknown;
}

export function CatalogSecretForm({
  title,
  description,
  fields,
  onBack,
  onSubmit,
  submitting,
  error,
}: CatalogSecretFormProps) {
  const [values, setValues] = useState<Record<string, string>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});

  function setValue(key: string, value: string) {
    setValues((current) => ({ ...current, [key]: value }));
    setFieldErrors((current) => {
      if (!(key in current)) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  }

  async function submit() {
    const errors: Record<string, string> = {};
    for (const field of fields) {
      const value = (values[field.key] ?? "").trim();
      if (field.required && value.length === 0) {
        errors[field.key] = "Required.";
      }
    }
    setFieldErrors(errors);
    if (Object.keys(errors).length > 0) return;

    const entries = fields
      .map((field) => [field.key, (values[field.key] ?? "").trim()] as const)
      .filter(([, value]) => value.length > 0);
    await onSubmit(Object.fromEntries(entries));
  }

  const topError = error ? errorMessage(error) : null;

  return (
    <div className="flex flex-col gap-4 pb-1">
      <button
        type="button"
        onClick={onBack}
        className="lift -ml-1 inline-flex w-fit items-center gap-1.5 rounded-capsule px-2 py-1 text-[13px] font-medium text-ink-3 hover:bg-black/[0.04] hover:text-ink"
      >
        <ArrowLeft size={14} aria-hidden="true" />
        All connectors
      </button>

      <div className="flex flex-col gap-1">
        <h3 className="text-[15px] font-semibold text-ink">{title}</h3>
        {description ? (
          <p className="text-[13px] leading-relaxed text-ink-3">{description}</p>
        ) : null}
      </div>

      <div className="flex flex-col gap-3 rounded-card-lg border border-black/[0.07] bg-white/40 p-4">
        <div className="flex flex-col gap-0.5">
          <p className="text-[13px] font-semibold text-ink">Credentials</p>
          <p className="text-[12px] leading-relaxed text-ink-4">
            Stored encrypted and sent to the server on your behalf. You will
            not see these values again.
          </p>
        </div>
        {fields.map((field) => (
          <Input
            key={field.key}
            label={`${field.label}${field.required ? "" : " (optional)"}`}
            type={field.secret ? "password" : "text"}
            autoComplete={field.secret ? "new-password" : "off"}
            placeholder={field.hint}
            value={values[field.key] ?? ""}
            onChange={(event) => setValue(field.key, event.currentTarget.value)}
            error={fieldErrors[field.key]}
          />
        ))}
      </div>

      {topError ? (
        <p role="alert" className="text-[13px] text-err">
          {topError}
        </p>
      ) : null}

      <div className="flex items-center justify-end gap-2.5 pt-1">
        <Button variant="ghost" size="sm" onClick={onBack} disabled={submitting}>
          Back
        </Button>
        <Button size="sm" loading={submitting} onClick={() => void submit()}>
          Connect
        </Button>
      </div>
    </div>
  );
}
