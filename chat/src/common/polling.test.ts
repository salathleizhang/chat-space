import { describe, expect, test } from "bun:test";
import { killJsTimers, spinUntil } from "./deadTimers.testkit";
import { ChatServiceError } from "./errors";
import { pollProviderTask, type ProviderPoll } from "./polling";
import { resetTaskPumps, runWithTaskPump, tickTaskPumps } from "./taskPump";

/**
 * 2026-10-03 事故的回归：进程的 JS 定时器停摆时，轮询必须靠**外部时钟**
 * （工作台每秒一次的 `GET /api/tasks` → `tickTaskPumps`）走完，而不是永远停在 running。
 */

interface FakePollOptions {
  attempts: number;
  pollIntervalMs: number;
  timeoutMs?: number;
  /** 前 N 次尝试抛可重试错误（走 catch 分支的等待） */
  failFirst?: number;
  onAttempt?: (index: number, at: number) => void;
}

function fakePoll(options: FakePollOptions): ProviderPoll<{ status: string }> {
  let seen = 0;
  return {
    label: "假供应商任务",
    timeoutMs: options.timeoutMs ?? 60_000,
    requestTimeoutMs: 5_000,
    pollIntervalMs: options.pollIntervalMs,
    attempt: async () => {
      seen += 1;
      options.onAttempt?.(seen, Date.now());
      if (options.failFirst && seen <= options.failFirst) {
        throw new ChatServiceError("假超时", 504, "request_timeout");
      }
      return { status: seen >= options.attempts ? "success" : "running" };
    },
    statusOf: (result) => result.status,
    isDone: (result) => result.status === "success",
    failureOf: () => undefined,
    timeoutError: () => new ChatServiceError("假供应商超时", 504, "fake_timeout"),
  };
}

describe("定时器停摆时的供应商轮询", () => {
  test("外部 tick 把轮询走完，且 tick 频率不会改写轮询节奏", async () => {
    resetTaskPumps();
    const timers = killJsTimers();
    try {
      const attemptTimes: number[] = [];
      let settled = false;
      const running = runWithTaskPump("t-poll", "p", () =>
        pollProviderTask(
          fakePoll({
            attempts: 3,
            pollIntervalMs: 30,
            onAttempt: (_index, at) => attemptTimes.push(at),
          }),
        ),
      ).then(
        (result) => {
          settled = true;
          return result;
        },
        (error) => {
          settled = true;
          throw error;
        },
      );
      // 外部时钟比真实工作台快得多（每轮都 tick）：既证明不靠定时器，也证明节奏由 dueAt 决定
      const drove = await spinUntil(() => settled, {
        timeoutMs: 3_000,
        onSpin: () => {
          tickTaskPumps("p");
        },
      });
      expect(drove).toBe(true);
      const result = await running;
      expect(result.status).toBe("success");
      expect(attemptTimes).toHaveLength(3);
      // 两次间隔 = 60 ms 左右；若 tick 直接把等待放行，这里会是几毫秒
      expect(attemptTimes[2]! - attemptTimes[0]!).toBeGreaterThanOrEqual(55);
      expect(timers.swallowed).toBeGreaterThan(0);
    } finally {
      timers.restore();
      resetTaskPumps();
    }
  });

  test("总预算到点仍然失败（靠时钟检查，不靠定时器）", async () => {
    resetTaskPumps();
    const timers = killJsTimers();
    try {
      let settled = false;
      const outcome = runWithTaskPump("t-deadline", "p", () =>
        pollProviderTask(fakePoll({ attempts: 99, pollIntervalMs: 10, timeoutMs: 60 })),
      ).then(
        () => {
          settled = true;
          return undefined;
        },
        (error: unknown) => {
          settled = true;
          return error;
        },
      );
      const drove = await spinUntil(() => settled, {
        timeoutMs: 3_000,
        onSpin: () => {
          tickTaskPumps("p");
        },
      });
      expect(drove).toBe(true);
      const error = await outcome;
      expect(error).toBeInstanceOf(ChatServiceError);
      expect((error as ChatServiceError).code).toBe("fake_timeout");
    } finally {
      timers.restore();
      resetTaskPumps();
    }
  });

  test("可重试失败之后的退避等待同样由外部 tick 放行", async () => {
    resetTaskPumps();
    const timers = killJsTimers();
    try {
      let settled = false;
      const running = runWithTaskPump("t-retry", "p", () =>
        pollProviderTask(fakePoll({ attempts: 2, pollIntervalMs: 20, failFirst: 2 })),
      ).then((result) => {
        settled = true;
        return result;
      });
      const drove = await spinUntil(() => settled, {
        timeoutMs: 3_000,
        onSpin: () => {
          tickTaskPumps("p");
        },
      });
      expect(drove).toBe(true);
      expect((await running).status).toBe("success");
    } finally {
      timers.restore();
      resetTaskPumps();
    }
  });

  test("显式 wait 覆盖闸门（测试注入用）：不在任务上下文里也能按自己的节奏推进", async () => {
    resetTaskPumps();
    const waits: number[] = [];
    const result = await pollProviderTask({
      ...fakePoll({ attempts: 2, pollIntervalMs: 7 }),
      wait: (ms) => {
        waits.push(ms);
        return Promise.resolve();
      },
    });
    expect(result.status).toBe("success");
    expect(waits).toEqual([7]);
  });
});
