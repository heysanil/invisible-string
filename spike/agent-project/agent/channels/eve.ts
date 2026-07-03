import { eveChannel } from "eve/channels/eve";

import { localDevUnlessDisabled, platformJwt } from "../lib/platform-auth.js";

/**
 * Default HTTP channel with the scaffolded auth (vercelOidc/localDev/
 * placeholderAuth) replaced by the platform's shared-secret JWT verifier.
 * localDev() stays as a dev-only fallback (suppressed in the spike's
 * fail-closed tests via SPIKE_DISABLE_LOCAL_DEV=1).
 */
export default eveChannel({
  auth: [platformJwt(), localDevUnlessDisabled()],
});
