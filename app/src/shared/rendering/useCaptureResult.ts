import { useCallback, useMemo, useRef } from "react";

/** Loading, device-loss and readback failures can race; settle a request once. */
export function useCaptureResult<T extends unknown[]>(key: string, callback: (...args: T) => void) {
  const gate = useMemo(() => ({ done: false }), [key]);
  const current = useRef(gate);
  const handler = useRef(callback);
  current.current = gate;
  handler.current = callback;
  return useCallback((...args: T) => {
    if (current.current !== gate || gate.done) return;
    gate.done = true;
    handler.current(...args);
  }, [gate]);
}
