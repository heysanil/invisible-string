/**
 * Better Auth-managed tables (spec §9) — re-exported from the canonical
 * schema in `@invisible-string/db` (single source of truth; migrations live
 * there too). `session` holds LOGIN sessions, distinct from the product's
 * `agent_sessions`.
 */
import {
  account,
  invitation,
  member,
  organization,
  session,
  ssoProvider,
  user,
  verification,
} from "@invisible-string/db/schema";

export {
  account,
  invitation,
  member,
  organization,
  session,
  ssoProvider,
  user,
  verification,
};

export const authSchema = {
  user,
  session,
  account,
  verification,
  organization,
  member,
  invitation,
  ssoProvider,
};
