/**
 * Agent port pool — the supervisor owns an inclusive port range and hands one
 * port to each running agent process. The pool tracks OUR allocations only;
 * the agent manager additionally bind-probes each allocated port before
 * spawning (agents.ts allocatePort) so a stale foreign listener burns the
 * port instead of silently answering the new agent's health checks.
 */

export class PortPoolExhaustedError extends Error {
  override readonly name = "PortPoolExhaustedError";
  constructor(min: number, max: number) {
    super(
      `agent port pool exhausted (${max - min + 1} port(s) in ${min}-${max} all allocated)`,
    );
  }
}

export interface PortPool {
  readonly min: number;
  readonly max: number;
  readonly size: number;
  allocatedCount(): number;
  /** Throws {@link PortPoolExhaustedError} when every port is taken. */
  allocate(): number;
  release(port: number): void;
}

export function createPortPool(min: number, max: number): PortPool {
  if (!Number.isInteger(min) || !Number.isInteger(max) || min > max) {
    throw new Error(`invalid port pool range ${min}-${max}`);
  }
  const allocated = new Set<number>();
  return {
    min,
    max,
    size: max - min + 1,
    allocatedCount: () => allocated.size,
    allocate(): number {
      for (let port = min; port <= max; port++) {
        if (!allocated.has(port)) {
          allocated.add(port);
          return port;
        }
      }
      throw new PortPoolExhaustedError(min, max);
    },
    release(port: number): void {
      allocated.delete(port);
    },
  };
}
