import { useEffect, useState } from "react";

// Returns `value` delayed by `delayMs` of inactivity. Each new `value`
// resets the timer; the returned value updates only after `delayMs` of
// no further changes. Used by ConversationSearch to throttle the search
// API call while the merchant types.
export function useDebouncedValue<T>(value: T, delayMs: number): T {
  const [debounced, setDebounced] = useState<T>(value);

  useEffect(() => {
    const handle = setTimeout(() => setDebounced(value), delayMs);
    return () => clearTimeout(handle);
  }, [value, delayMs]);

  return debounced;
}
