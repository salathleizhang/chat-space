import { afterEach, describe, expect, test } from "bun:test";
import { spinFor, killJsTimers } from "./deadTimers.testkit";
import {
  activeTaskPumpCount,
  currentTaskPump,
  onTaskPumpTick,
  releaseTaskPump,
  resetTaskPumps,
  runWithTaskPump,
  taskPumpStatus,
  tickTaskPumps,
} from "./taskPump";

afterEach(() => {
  resetTaskPumps();
});

describe("任务闸门的基础行为", () => {
  test("健康进程：wait 由内部定时器唤醒，tick 不需要参与", async () => {
    const started = Date.now();
    await runWithTaskPump("t-timer", "p", async () => {
      const pump = currentTaskPump();
      expect(pump).toBeDefined();
      await pump!.wait(20);
    });
    expect(Date.now() - started).toBeGreaterThanOrEqual(15);
  });

  test("异步上下文里随时拿得到闸门（await / Promise.all 之后仍在）", async () => {
    await runWithTaskPump("t-als", "p", async () => {
      const first = currentTaskPump();
      expect(first?.taskId).toBe("t-als");
      await Promise.resolve();
      await Promise.all([Promise.resolve(), Promise.resolve()]);
      expect(currentTaskPump()).toBe(first);
      expect(activeTaskPumpCount("p")).toBe(1);
      expect(taskPumpStatus("t-als")?.waiting).toBe(false);
    });
    expect(activeTaskPumpCount()).toBe(0);
  });

  test("不在任务上下文里就是 undefined（普通请求、工具直调不受影响）", () => {
    expect(currentTaskPump()).toBeUndefined();
  });
});

describe("定时器停摆：外部推进是唯一时钟", () => {
  test("未到期的 tick 不放行——1 Hz 的外部心跳不会把 10 秒轮询改写成 1 秒", async () => {
    const timers = killJsTimers();
    try {
      await runWithTaskPump("t-pace", "p", async () => {
        const pump = currentTaskPump()!;
        let resolved = false;
        const dueAt = Date.now() + 60;
        const waiting = pump.wait(60).then(() => {
          resolved = true;
        });
        // 定时器已停摆：立刻 tick 也不该放行（节奏由 dueAt 决定，不由心跳频率决定）
        tickTaskPumps("p");
        await Promise.resolve();
        expect(resolved).toBe(false);
        expect(timers.swallowed).toBeGreaterThan(0);
        // 把时间推过 dueAt，但不 tick —— 仍然不该醒（证明它真的不靠定时器）
        while (Date.now() < dueAt) await Promise.resolve();
        await Promise.resolve();
        expect(resolved).toBe(false);
        // 外部时钟到点：放行
        tickTaskPumps("p");
        await waiting;
        expect(resolved).toBe(true);
      });
    } finally {
      timers.restore();
    }
  });

  test("在飞请求超预算时由 tick 中止，并换新信号给下一次尝试", async () => {
    const timers = killJsTimers();
    try {
      await runWithTaskPump("t-abort", "p", async () => {
        const pump = currentTaskPump()!;
        const first = pump.signal;
        pump.enter(40);
        tickTaskPumps("p");
        expect(first.aborted).toBe(false); // 预算内不动它
        await spinFor(60);
        tickTaskPumps("p");
        expect(first.aborted).toBe(true);
        expect(pump.signal).not.toBe(first); // 下一次尝试必须拿到干净信号
        pump.leave();
        expect(taskPumpStatus("t-abort")?.inFlightMs).toBeNull();
      });
    } finally {
      timers.restore();
    }
  });

  test("tick 也驱动注册的冲刷器（合并窗口这类短定时器）", async () => {
    let flushes = 0;
    const off = onTaskPumpTick(() => {
      flushes += 1;
    });
    tickTaskPumps();
    tickTaskPumps();
    expect(flushes).toBe(2);
    off();
    tickTaskPumps();
    expect(flushes).toBe(2);
  });

  test("冲刷器抛错不影响 tick（读任务列表不该被它拖垮）", () => {
    const off = onTaskPumpTick(() => {
      throw new Error("坏冲刷器");
    });
    expect(() => tickTaskPumps()).not.toThrow();
    off();
  });

  test("闸门结束会放行等待者：链路不会永远停在最后一步", async () => {
    const timers = killJsTimers();
    try {
      let resolved = false;
      const running = runWithTaskPump("t-release", "p", async () => {
        await currentTaskPump()!.wait(10 * 60_000);
        resolved = true;
      });
      await spinFor(20, () => {
        // 让链路先跑到 wait 上
      });
      expect(resolved).toBe(false);
      releaseTaskPump("t-release");
      await running;
      expect(resolved).toBe(true);
    } finally {
      timers.restore();
    }
  });
});
