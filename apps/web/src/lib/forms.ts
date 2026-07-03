/**
 * Tiny form helpers shared by auth pages and the Phase-2 resource forms.
 * (Email/password primitives live in lib/validate.ts; this module maps zod
 * and API failures onto per-field inline errors.)
 */
import { z } from "zod";

import { ApiError } from "./api-client";

/** Key for errors that belong to the whole form, not one field. */
export const FORM_ERROR_KEY = "_form";

/** Dotted field path → first error message for that field. */
export type FieldErrors = Record<string, string>;

/** Flatten a zod error into per-field messages (first issue per path wins). */
export function fieldErrorsFromZod(error: z.ZodError): FieldErrors {
  const errors: FieldErrors = {};
  for (const issue of error.issues) {
    const path = issue.path.length > 0 ? issue.path.join(".") : FORM_ERROR_KEY;
    if (!(path in errors)) errors[path] = issue.message;
  }
  return errors;
}

/** One-call client-side validation for submit handlers. */
export function validateForm<T>(
  schema: z.ZodType<T>,
  values: unknown,
): { ok: true; data: T } | { ok: false; fieldErrors: FieldErrors } {
  const parsed = schema.safeParse(values);
  return parsed.success
    ? { ok: true, data: parsed.data }
    : { ok: false, fieldErrors: fieldErrorsFromZod(parsed.error) };
}

/** Serialized zod-ish issue carried in 422 error envelopes (`details`). */
const wireIssueSchema = z.looseObject({
  message: z.string(),
  path: z.array(z.union([z.string(), z.number()])).optional(),
});

/**
 * Map a server-side validation failure (422 envelope with zod-style issue
 * details, e.g. `draft_invalid`) onto field errors; null when the error is
 * not field-shaped (render {@link errorMessage} instead).
 */
export function fieldErrorsFromApiError(error: unknown): FieldErrors | null {
  if (!(error instanceof ApiError)) return null;
  const issues = z.array(wireIssueSchema).safeParse(error.details);
  if (!issues.success || issues.data.length === 0) return null;
  const errors: FieldErrors = {};
  for (const issue of issues.data) {
    const path =
      issue.path !== undefined && issue.path.length > 0
        ? issue.path.join(".")
        : FORM_ERROR_KEY;
    if (!(path in errors)) errors[path] = issue.message;
  }
  return errors;
}

/** Human-readable message for any thrown error (ApiError-aware). */
export function errorMessage(
  error: unknown,
  fallback = "Something went wrong. Try again.",
): string {
  if (error instanceof ApiError && error.message) return error.message;
  if (error instanceof Error && error.message) return error.message;
  return fallback;
}
