/**
 * 测试工具：把本进程的 JS 定时器「打瘸」。
 *
 * 2026-10-03 的事故里，长命进程的 `setTimeout` 不再派发回调（25 ms 合并窗口、10 s 轮询间隔、
 * 15 分钟 deadline、60 分钟看门狗一个都没响），而 HTTP 接口照常工作。任何"必须能在这种进程里
 * 活下来"的机制，都要有对照实验：把 `setTimeout` 换成空操作，再用**外部时钟**（真实路径是
 * `listTasks()` → `tickTaskPumps()`）驱动，断言链路照样走完。
 *
 * 注意它只打瘸 JS 层的 `setTimeout`：`AbortSignal.timeout` 是运行时内部的，仍在工作。
 * 这正是我们要的粒度——被测的是"我们的等待与超时有没有把正确性寄托在 JS 定时器上"。
 */

export interface DeadTimers {
  /** 被吞掉的 setTimeout 调用次数（用来证明测试确实处在"定时器停摆"状态） */
  readonly swallowed: number;
  restore(): void;
}

/** 把 `globalThis.setTimeout` 换成一个什么都不做的函数；记得在 finally 里 restore()。 */
export function killJsTimers(): DeadTimers {
  const real = globalThis.setTimeout;
  let swallowed = 0;
  const stub = (() => {
    swallowed += 1;
    return 0 as unknown as ReturnType<typeof setTimeout>;
  }) as unknown as typeof setTimeout;
  globalThis.setTimeout = stub;
  return {
    get swallowed() {
      return swallowed;
    },
    restore() {
      globalThis.setTimeout = real;
    },
  };
}

/** 忙等（不用定时器）把墙上的时间推过去，每一轮都调一次 onSpin（通常就是外部 tick）。 */
export async function spinFor(
  ms: number,
  onSpin?: () => void | Promise<void>,
): Promise<void> {
  const until = Date.now() + Math.max(0, ms);
  while (Date.now() < until) {
    await onSpin?.();
    await Promise.resolve();
  }
}

/**
 * 忙等直到条件成立；超时返回 false。
 * 每轮都调 onSpin（外部时钟），所以它模拟的正是"工作台每秒来读一次任务列表"。
 */
export async function spinUntil(
  predicate: () => boolean,
  options: { timeoutMs?: number; onSpin?: () => void | Promise<void> } = {},
): Promise<boolean> {
  const until = Date.now() + (options.timeoutMs ?? 3_000);
  for (;;) {
    if (predicate()) return true;
    if (Date.now() >= until) return false;
    await options.onSpin?.();
    await Promise.resolve();
  }
}
