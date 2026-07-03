import { defineSandbox } from "eve/sandbox";
import { docker } from "eve/sandbox/docker";

/**
 * Locked platform decision: docker() backend via the host Docker socket
 * (worker containers mount /var/run/docker.sock; sandbox containers run as
 * siblings). Default image ghcr.io/vercel/eve:latest.
 */
export default defineSandbox({
  backend: docker(),
});
