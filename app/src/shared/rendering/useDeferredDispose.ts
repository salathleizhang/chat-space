import { useEffect, useRef } from "react";

/**
 * 为"由 `useMemo` 持有、由 effect cleanup 释放"的资源做**可取消的延迟释放**。
 *
 * 为什么需要它：StrictMode 会在同一轮里跑 mount → cleanup → mount。如果 cleanup 直接
 * `dispose()`，被释放的正是**已经提交、正在用**的那一份——`DeferredResource` 的注释和
 * `envTexture.ts` 都记着这个坑。把释放推迟一个 macrotask，并让同一资源的重新挂载取消它，
 * 就同时避免了两件事：误杀在用实例，以及在 `useMemo` 真的重建了新实例时漏掉旧实例。
 *
 * 释放按**资源本身**记账（而不是按组件实例一个 timer），所以"回放拿到的是新实例"那种
 * 情况下，旧实例仍会在下一个 macrotask 被释放。
 */
export function useDeferredDispose<T extends object>(resource: T | null, dispose: (value: T) => void): void {
  const timers = useRef<WeakMap<T, ReturnType<typeof setTimeout>>>(new WeakMap());
  useEffect(() => {
    if (!resource) return;
    const pending = timers.current.get(resource);
    if (pending !== undefined) {
      clearTimeout(pending);
      timers.current.delete(resource);
    }
    return () => {
      timers.current.set(resource, setTimeout(() => {
        timers.current.delete(resource);
        dispose(resource);
      }, 0));
    };
  }, [resource, dispose]);
}
