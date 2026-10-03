import { ChatServiceError } from "./errors";
import {
  Deadline,
  isRetryableNetworkError,
  requestTimeoutError,
  sleep,
  withHardTimeout,
} from "./http";
import { currentTaskPump } from "./taskPump";

/**
 * 供应商轮询的公共骨架。
 *
 * 之前 5 个 provider 各写一份
 * `for (;;) { try { fetch } catch { if (Date.now() > deadline) throw ... } }`，
 * 共同的缺陷是 deadline 只在 await 返回之后才检查——请求挂住时那行永远走不到，任务就
 * 无限期停在 running（2026-09-26 World Labs 世界生成：供应商 5 分钟就完成，本机 37 分钟
 * 毫无进展，30 分钟的 deadline 一次都没触发）。这里把两件事收敛到一处：
 *
 *   ① 每一次尝试都有硬上限（请求 + 读 body 共享单次预算）；
 *   ② 总预算到点必然兑现，不管底层请求是否理会 abort。
 *
 * 各供应商只负责「查一次 + 判状态」，超时与重试语义不再各写一遍。
 *
 * ③（2026-10-03 补）**本进程的定时器本身也可能停摆**：那时 ① 的定时器不响、② 的
 * deadline 也检查不到，任务会静默停在 running（详见 `common/taskPump.ts` 的事故记录）。
 * 所以等待改成走任务闸门：健康时按定时器唤醒，停摆时由工作台每秒一次的
 * `GET /api/tasks` 外部推进。
 */
export interface ProviderPoll<T> {
  /** 错误文案里的主语，如 `Tripo 任务（task_id=xxx）` */
  label: string;
  /** 整条任务的总预算 */
  timeoutMs: number;
  /** 单次查询的预算 */
  requestTimeoutMs: number;
  /** 两次查询之间的间隔 */
  pollIntervalMs: number;
  /** 每次拿到状态后的回调（用来推进任务 phase，让进度可见） */
  onStatus?: (status: string) => void | Promise<void>;
  /** 查一次并读出响应体；signal 到期即中止。非 2xx 应在这里抛错。 */
  attempt: (signal: AbortSignal, requestTimeoutMs: number) => Promise<T>;
  /** 供应商标记的状态，用于 onStatus 与终态判定 */
  statusOf: (result: T) => string;
  /** 终态成功 */
  isDone: (result: T) => boolean;
  /** 返回错误表示终态失败；undefined 表示继续等 */
  failureOf: (result: T) => ChatServiceError | undefined;
  /** 总预算耗尽时的错误（保留各供应商自己的错误码） */
  timeoutError: () => ChatServiceError;
  /**
   * 两次尝试之间的等待。缺省是 `sleep`；任务化调用会自动换成**外部可推进**的闸门
   * （`common/taskPump.ts`），这样本进程定时器停摆时，工作台每秒一次的
   * `GET /api/tasks` 仍能把轮询推着走。显式传入只用于测试。
   */
  wait?: (ms: number) => Promise<void>;
}

/** 把 task pump 的中止信号并进本次尝试的信号里（没有 pump 就是原信号）。 */
function withExternalAbort(
  signal: AbortSignal,
  external: AbortSignal | undefined,
): AbortSignal {
  return external ? AbortSignal.any([signal, external]) : signal;
}

export async function pollProviderTask<T>(options: ProviderPoll<T>): Promise<T> {
  const deadline = new Deadline(options.timeoutMs, options.timeoutError);
  const pump = currentTaskPump();
  const wait = options.wait ?? (pump ? (ms: number) => pump.wait(ms) : sleep);
  try {
    for (;;) {
      if (deadline.expired) throw deadline.error();
      let result: T;
      try {
        // 单次尝试的硬上限：比单次预算宽一倍（请求 + 读 body），但绝不超过总预算。
        const budget = Math.min(options.requestTimeoutMs * 2, deadline.remainingMs);
        // 定时器停摆时 withHardTimeout 永远不响，所以把「在飞预算」也交给闸门记账：
        // 外部 tick 发现超预算会中止这次请求，链路按下面的重试路径重来。
        pump?.enter(budget);
        result = await withHardTimeout(
          options.attempt(
            withExternalAbort(deadline.signal, pump?.signal),
            options.requestTimeoutMs,
          ),
          budget,
          () => requestTimeoutError(options.label, budget),
        );
      } catch (error) {
        // 供应商明确回错的业务错误立刻冒泡；网络抖动/单次超时才重试。
        if (!isRetryableNetworkError(error)) throw error;
        if (deadline.expired) throw deadline.error();
        await deadline.guard(wait(options.pollIntervalMs));
        continue;
      } finally {
        pump?.leave();
      }
      await options.onStatus?.(options.statusOf(result));
      if (options.isDone(result)) return result;
      const failure = options.failureOf(result);
      if (failure) throw failure;
      if (deadline.expired) throw deadline.error();
      await deadline.guard(wait(options.pollIntervalMs));
    }
  } finally {
    deadline.dispose();
  }
}
