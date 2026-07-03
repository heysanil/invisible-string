import { useEffect, useState } from "react";

/**
 * Debounce a fast-changing value (search-as-you-type inputs). The first
 * value is emitted immediately; subsequent changes settle after `delayMs`.
 */
export function useDebouncedValue<T>(value: T, delayMs = 250): T {
  const [debounced, setDebounced] = useState(value);

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(timer);
  }, [value, delayMs]);

  return debounced;
}
