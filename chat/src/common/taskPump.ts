/**
 * 任务推进闸门（task pump）：把「等待」从**本进程的定时器**上解耦。
 *
 * 为什么必须有它（2026-10-03 事故）：一个跑了 22 小时的 chat 进程定时器不再派发回调——
 * 25 ms 的查询合并窗口、10 s 的轮询间隔、15 分钟的 deadline、60 分钟的看门狗**一个都没响**，
 * 而它的 HTTP 接口一直正常（同一把 key 换个新进程跑同样的轮询 1.17 秒就返回）。结果 16 个
 * 已付费的 Tripo 任务停在 `running` 十几分钟无人认领：**唯一能唤醒等待的东西也住在同一个
 * 死掉的定时器里**，进程外除了发一个 HTTP 请求没有任何手段，于是只能重启。
 *
 * 这里换一个时钟：**外部推进**。工作台每 1 秒调一次 `GET /api/tasks`
 * （`app/src/pages/AppDashboard/useTaskPolling.ts` 的 `TASK_POLL_INTERVAL_MS = 1_000`），
 * 那个心跳来自浏览器进程，与本进程定时器的死活无关。`tickTaskPumps()` 挂在
 * `listTasks()` 上，于是「读任务列表」这条纯 I/O 路径顺手把生成链路推着走。
 *
 * 三条纪律，缺一条就会退化成今天的样子：
 *
 * 1. **到期时刻用 `Date.now()` 记，不靠定时器**：`wait(ms)` 先记 `dueAt`，`tick()` 只放行
 *    `dueAt <= now` 的等待者。所以 1 Hz 的 tick 不会把 10 秒的轮询拉成 1 秒一次
 *    （没有这一条，轮询频率会被外部心跳改写，撞供应商限流）。
 * 2. **内部定时器照旧保留**：进程健康时由它精确唤醒，tick 什么都不做——行为与改造前一致。
 * 3. **在飞请求也要有外部兜底**：单次请求的硬上限本来是 `withHardTimeout` 的定时器；
 *    定时器停摆时那行永远走不到。`enter/leave` 记下在飞时刻与预算，tick 发现超预算就
 *    abort 这一次请求，让链路按既有的重试路径重来。
 *
 * 闸门自己不推进任何业务，只回答「现在能不能继续」。注册表挂在 `globalThis` 上：`bun --hot`
 * 替换模块后，正在跑的旧链路仍然找得到自己的闸门（与 `tasks.ts` 的 `BOOT_ID` 同一个理由）。
 */

import { AsyncLocalStorage } from "node:async_hooks";

/** 外部推进闸门的对外形状（链路只依赖这几个成员，方便测试注入替身）。 */
export interface TaskPump {
  readonly taskId: string;
  readonly projectSlug: string;
  /** 单次请求的中止信号；tick 判定超预算时换新，所以**每次尝试都要重新取**。 */
  readonly signal: AbortSignal;
  /** 等下一次轮询；健康时按定时器，停摆时靠 tick。 */
  wait(ms: number): Promise<void>;
  /** 记下「有一次请求在飞」及其硬预算（与 `withHardTimeout` 同一口径）。 */
  enter(budgetMs: number): void;
  /** 请求已结束（无论成功/失败）。 */
  leave(): void;
  /** 外部推进一次；返回是否真的推动了什么（诊断与测试用）。 */
  tick(now?: number): boolean;
  /** 结束闸门：放行所有等待者，避免链路永远停在这里。 */
  dispose(): void;
  readonly isWaiting: boolean;
  /** 下一个到期的等待还剩多少毫秒；没有等待者时返回 null。 */
  nextDueInMs(now?: number): number | null;
  /** 当前在飞请求已经飞了多久；没有在飞请求时返回 null。 */
  inFlightMs(now?: number): number | null;
}

interface Waiter {
  dueAt: number;
  finish: () => void;
}

class TaskPumpImpl implements TaskPump {
  private readonly waiters = new Set<Waiter>();
  private controller = new AbortController();
  private inFlight: { since: number; budgetMs: number } | null = null;
  private disposed = false;

  constructor(
    readonly taskId: string,
    readonly projectSlug: string,
  ) {}

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get isWaiting(): boolean {
    return this.waiters.size > 0;
  }

  nextDueInMs(now: number = Date.now()): number | null {
    if (this.waiters.size === 0) return null;
    let earliest = Number.POSITIVE_INFINITY;
    for (const waiter of this.waiters) earliest = Math.min(earliest, waiter.dueAt);
    return Math.max(0, earliest - now);
  }

  inFlightMs(now: number = Date.now()): number | null {
    return this.inFlight ? Math.max(0, now - this.inFlight.since) : null;
  }

  wait(ms: number): Promise<void> {
    const delay = Math.max(0, ms);
    return new Promise<void>((resolve) => {
      const waiter: Waiter = { dueAt: Date.now() + delay, finish: () => undefined };
      let done = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      waiter.finish = () => {
        if (done) return;
        done = true;
        if (timer !== null) clearTimeout(timer);
        this.waiters.delete(waiter);
        resolve();
      };
      this.waiters.add(waiter);
      // 健康进程里这是唯一的唤醒源；它不响时由 tick()（到期后）兜底。
      timer = setTimeout(waiter.finish, Math.max(1, delay));
    });
  }

  enter(budgetMs: number): void {
    this.inFlight = { since: Date.now(), budgetMs: Math.max(1, budgetMs) };
  }

  leave(): void {
    this.inFlight = null;
  }

  tick(now: number = Date.now()): boolean {
    let touched = false;
    for (const waiter of [...this.waiters]) {
      if (waiter.dueAt <= now) {
        waiter.finish();
        touched = true;
      }
    }
    const flight = this.inFlight;
    if (flight && now - flight.since > flight.budgetMs) {
      // 定时器本该在超预算时拒绝这次请求；它没响，就由外部时钟替它下手。
      this.inFlight = null;
      const stale = this.controller;
      this.controller = new AbortController();
      stale.abort(
        new Error(
          `任务 ${this.taskId} 的单次请求超过 ${Math.round(flight.budgetMs / 1000)} 秒预算，` +
            "已由外部推进中止（本进程定时器未触发）",
        ),
      );
      touched = true;
    }
    return touched;
  }

  dispose(): void {
    this.disposed = true;
    for (const waiter of [...this.waiters]) waiter.finish();
    this.waiters.clear();
    this.inFlight = null;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }
}

interface PumpHolder {
  pump: TaskPumpImpl;
  projectSlug: string;
}

/**
 * 进程级注册表。放在 `globalThis` 上而不是模块作用域：`bun --hot` 会重建模块，
 * 但正在跑的任务链路还握着旧模块里的闸门，`tickTaskPumps()` 必须还能找到它。
 */
interface PumpRegistry {
  storage: AsyncLocalStorage<TaskPumpImpl>;
  byTask: Map<string, PumpHolder>;
  /** 定时器停摆时也需要外部推动的「冲刷器」（如 Tripo 的查询合并窗口）。 */
  flushers: Set<() => void>;
}

const REGISTRY_KEY = "__chatspaceTaskPumpRegistry";

function registry(): PumpRegistry {
  const holder = globalThis as { [REGISTRY_KEY]?: PumpRegistry };
  holder[REGISTRY_KEY] ??= {
    storage: new AsyncLocalStorage<TaskPumpImpl>(),
    byTask: new Map<string, PumpHolder>(),
    flushers: new Set<() => void>(),
  };
  return holder[REGISTRY_KEY];
}

/** 当前异步上下文里的闸门；不在任务里（普通请求、测试、工具直调）返回 undefined。 */
export function currentTaskPump(): TaskPump | undefined {
  return registry().storage.getStore();
}

/**
 * 在任务上下文里跑一段工作，并给它一个闸门。
 * 同一个 taskId 重复进入会复用已有闸门（热重载/续跑不会互相踩）。
 */
export async function runWithTaskPump<T>(
  taskId: string,
  projectSlug: string,
  work: () => Promise<T>,
): Promise<T> {
  const reg = registry();
  const existing = reg.byTask.get(taskId);
  const pump = existing?.pump ?? new TaskPumpImpl(taskId, projectSlug);
  reg.byTask.set(taskId, { pump, projectSlug });
  try {
    return await reg.storage.run(pump, work);
  } finally {
    pump.dispose();
    if (reg.byTask.get(taskId)?.pump === pump) reg.byTask.delete(taskId);
  }
}

/** 显式结束一个闸门（任务提前收场时用；`runWithTaskPump` 正常结束也会调）。 */
export function releaseTaskPump(taskId: string): void {
  const reg = registry();
  const holder = reg.byTask.get(taskId);
  if (!holder) return;
  holder.pump.dispose();
  reg.byTask.delete(taskId);
}

export function activeTaskPumpCount(projectSlug?: string): number {
  let count = 0;
  for (const holder of registry().byTask.values()) {
    if (projectSlug && holder.projectSlug !== projectSlug) continue;
    count += 1;
  }
  return count;
}

/** 诊断口：某个任务现在卡在哪（等待下一次轮询 / 请求在飞 / 不在推进中）。 */
export function taskPumpStatus(
  taskId: string,
  now: number = Date.now(),
): { waiting: boolean; nextDueInMs: number | null; inFlightMs: number | null } | undefined {
  const holder = registry().byTask.get(taskId);
  if (!holder) return undefined;
  return {
    waiting: holder.pump.isWaiting,
    nextDueInMs: holder.pump.nextDueInMs(now),
    inFlightMs: holder.pump.inFlightMs(now),
  };
}

/**
 * 外部推进：放行到期的等待者、中止超预算的在飞请求、驱动注册过的冲刷器。
 * 由 `listTasks()` 调用（工作台 1 Hz 的 `GET /api/tasks` 就是外部时钟）。
 * 返回被推动的闸门数；读任务列表不该因为它抛错而失败，所以冲刷器的异常在这里吞掉。
 */
export function tickTaskPumps(projectSlug?: string, now: number = Date.now()): number {
  const reg = registry();
  let touched = 0;
  for (const holder of reg.byTask.values()) {
    if (projectSlug && holder.projectSlug !== projectSlug) continue;
    if (holder.pump.tick(now)) touched += 1;
  }
  for (const flush of [...reg.flushers]) {
    try {
      flush();
    } catch {
      // 冲刷失败不影响任务列表读取；真正的失败会在链路自己的重试路径里体现。
    }
  }
  return touched;
}

/**
 * 注册一个「每次 tick 都要推一下」的冲刷器，返回注销函数。
 * 用途：链路的等待由外部时钟放行，但**发出请求**那一刻还压在一个短定时器上
 * （Tripo 的 25 ms 查询合并窗口），那个定时器停摆时同样需要外部时钟。
 * 注册发生在模块加载期（见 tripoTaskQuery.ts），所以 `resetTaskPumps()` 不动它。
 */
export function onTaskPumpTick(flush: () => void): () => void {
  const flushers = registry().flushers;
  flushers.add(flush);
  return () => flushers.delete(flush);
}

/** 测试用：清空在跑的闸门（模块加载期注册的冲刷器保持不动）。 */
export function resetTaskPumps(): void {
  const reg = registry();
  for (const holder of reg.byTask.values()) holder.pump.dispose();
  reg.byTask.clear();
}
