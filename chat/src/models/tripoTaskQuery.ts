import { ChatServiceError } from "../common/errors";
import { API_REQUEST_TIMEOUT_MS, fetchWithTimeout, readBodyWithTimeout } from "../common/http";

/**
 * Tripo 任务状态查询：走官方的**批量**端点 `POST /tasks/list`
 * （https://developers.tripo3d.ai/en/docs/task-batch-query），并把同一时刻到点的查询
 * **合并成一个请求**。
 *
 * 为什么值得这么做：一批 16 个对象会在同一毫秒提交，之后每个任务各自每 10 秒轮询一次。
 * 旧实现是每个任务一个 `GET /tasks/{id}`，一轮就是 16 个请求；官方明确建议
 * 「用 POST /v3/tasks/list 替代多次 GET /v3/tasks/{task_id}」，而且查询端点的速率限制
 * 再宽也是有限的（限流超限的 code 是 1007，与并发的 2000 不是一回事）。
 *
 * 合并窗口只有 25 毫秒，所以：
 * - 同一批提交、节奏对齐的任务会被拼成一个请求（N→1）；
 * - 单个任务（或节奏差得远的任务）单独发一个请求，不会为了凑批而拖慢自己的轮询；
 * - 每个任务仍然保有自己的 deadline / 轮询间隔 / 状态回调（那些在 `pollProviderTask` 里），
 *   这里只替换「发出去的那一个 HTTP 调用」。
 *
 * 调用方的超时仍然有硬上限：请求内部照旧套 `fetchWithTimeout` + `readBodyWithTimeout`，
 * 单次预算取本批所有等待者的最小值——最紧的那个调用方决定这一次请求的预算。
 */

/** 官方限制：一次最多 100 个 task_id */
export const TRIPO_BATCH_QUERY_MAX_IDS = 100;
/** 合并窗口：这么短的时间内到达的查询拼进同一个请求 */
export const TRIPO_QUERY_COALESCE_WINDOW_MS = 25;

interface Waiter {
  resolve: (task: Record<string, unknown>) => void;
  reject: (error: unknown) => void;
  requestTimeoutMs: number;
}

interface BatchResult {
  tasks: Map<string, Record<string, unknown>>;
}

export interface TripoTaskQuerierOptions {
  /** 形如 `https://openapi.tripo3d.ai/v3` */
  baseUrl: string;
  apiKey: string;
  fetchFn: typeof fetch;
  /** 单次查询的默认预算 */
  requestTimeoutMs?: number;
  /** 合并窗口，测试可调小/调大 */
  coalesceWindowMs?: number;
}

function jsonOrEmpty(response: Response): Promise<Record<string, unknown>> {
  return response.json().catch(() => ({})) as Promise<Record<string, unknown>>;
}

export class TripoTaskQuerier {
  private waiters = new Map<string, Waiter[]>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running: Promise<void> | null = null;
  /** 批量端点被服务端否掉（404/405）后不再重试，直接走逐任务查询 */
  private batchUnavailable = false;
  /** 发出去的批量请求次数（测试与诊断用） */
  private requestCount = 0;

  constructor(private readonly options: TripoTaskQuerierOptions) {}

  get sentRequestCount(): number {
    return this.requestCount;
  }

  get pendingCount(): number {
    return this.waiters.size;
  }

  /** 查一个任务；到期未至则与同窗口的其他查询合并发出。 */
  query(taskId: string, requestTimeoutMs?: number): Promise<Record<string, unknown>> {
    const budget = requestTimeoutMs ?? this.options.requestTimeoutMs ?? API_REQUEST_TIMEOUT_MS;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const list = this.waiters.get(taskId);
      if (list) list.push({ resolve, reject, requestTimeoutMs: budget });
      else this.waiters.set(taskId, [{ resolve, reject, requestTimeoutMs: budget }]);
      this.schedule();
    });
  }

  /** 立刻发出当前排队的查询（测试用；生产由合并窗口的定时器驱动）。 */
  flushNow(): Promise<void> {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    return this.flush();
  }

  private schedule(): void {
    if (this.timer || this.running) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, this.options.coalesceWindowMs ?? TRIPO_QUERY_COALESCE_WINDOW_MS);
  }

  private flush(): Promise<void> {
    if (this.running) return this.running;
    const run = this.drain();
    this.running = run;
    return run;
  }

  private async drain(): Promise<void> {
    try {
      while (this.waiters.size > 0) {
        const batch = this.waiters;
        this.waiters = new Map();
        // 超过单请求上限的留在队列里，下一轮再发（不丢、也不超官方 100 的限制）
        const ids: string[] = [];
        for (const [id, list] of batch) {
          if (ids.length >= TRIPO_BATCH_QUERY_MAX_IDS) this.waiters.set(id, list);
          else ids.push(id);
        }
        const budget = Math.min(
          ...ids.map((id) => batch.get(id)?.[0]?.requestTimeoutMs ?? API_REQUEST_TIMEOUT_MS),
        );
        for (const [id, outcome] of await this.resolveBatch(ids, budget)) {
          for (const waiter of batch.get(id) ?? []) {
            if (outcome instanceof Error) waiter.reject(outcome);
            else waiter.resolve(outcome);
          }
        }
      }
    } finally {
      this.running = null;
    }
    // 排空期间 `running` 挡住了 schedule()，这里补一次
    if (this.waiters.size > 0) this.schedule();
  }

  /**
   * 解一批任务。优先一次批量请求；批量端点出错（比如 5xx，或老账号上不支持）时**退回逐任务
   * GET**——否则一个共享请求的抖动会把整批任务一起判死，失败面比改之前更大。
   */
  private async resolveBatch(
    ids: string[],
    budget: number,
  ): Promise<Map<string, Record<string, unknown> | Error>> {
    const outcomes = new Map<string, Record<string, unknown> | Error>();
    if (!this.batchUnavailable) {
      try {
        const result = await this.request(ids, budget);
        for (const id of ids) outcomes.set(id, result.tasks.get(id) ?? taskNotFound(id));
        return outcomes;
      } catch {
        // 落到下面的逐任务查询
      }
    }
    await Promise.all(
      ids.map(async (id) => {
        try {
          outcomes.set(id, await this.requestOne(id, budget));
        } catch (error) {
          outcomes.set(id, error instanceof Error ? error : new Error(String(error)));
        }
      }),
    );
    return outcomes;
  }

  private async request(ids: string[], requestTimeoutMs: number): Promise<BatchResult> {
    const label = "Tripo 批量任务查询";
    const response = await fetchWithTimeout(
      this.options.fetchFn,
      `${this.options.baseUrl}/tasks/list`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${this.options.apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ task_ids: ids }),
      },
      requestTimeoutMs,
      label,
    );
    this.requestCount += 1;
    if (response.status === 404 || response.status === 405) this.batchUnavailable = true;
    const payload = await readBodyWithTimeout(
      () => jsonOrEmpty(response),
      requestTimeoutMs,
      label,
    );
    if (!response.ok) {
      throw new ChatServiceError(
        `Tripo 任务查询失败（${response.status}）：${JSON.stringify(payload).slice(0, 300)}`,
        502,
        "tripo_status_failed",
      );
    }
    const data = (payload.data ?? {}) as Record<string, unknown>;
    const tasks = data.tasks;
    if (!tasks || typeof tasks !== "object") {
      throw new ChatServiceError(
        "Tripo 批量查询响应缺少 data.tasks",
        502,
        "tripo_status_failed",
      );
    }
    return { tasks: new Map(Object.entries(tasks as Record<string, Record<string, unknown>>)) };
  }

  /** 逐任务查询（旧的 GET /tasks/{id}）：批量不可用时的退路，也是失败面最小的路径 */
  private async requestOne(taskId: string, requestTimeoutMs: number): Promise<Record<string, unknown>> {
    const label = "Tripo 任务查询";
    const response = await fetchWithTimeout(
      this.options.fetchFn,
      `${this.options.baseUrl}/tasks/${taskId}`,
      { headers: { Authorization: `Bearer ${this.options.apiKey}` } },
      requestTimeoutMs,
      label,
    );
    this.requestCount += 1;
    const payload = await readBodyWithTimeout(
      () => jsonOrEmpty(response),
      requestTimeoutMs,
      label,
    );
    if (!response.ok) {
      throw new ChatServiceError(
        `Tripo 任务查询失败（${response.status}）`,
        502,
        "tripo_status_failed",
      );
    }
    return (payload.data ?? {}) as Record<string, unknown>;
  }
}

/** 服务端在 `missed` 里点名（id 非法 / key 不对 / 已过期）时用这个错误，别混成"还在跑" */
function taskNotFound(taskId: string): ChatServiceError {
  return new ChatServiceError(
    `Tripo 任务不存在或已过期（task_id=${taskId}）`,
    502,
    "tripo_task_not_found",
  );
}

/**
 * 查询器按 (fetchFn, baseUrl, apiKey) 缓存：并发是账户级的，同一把 key 的任务共用一个查询器
 * 才能被合并。用 `fetchFn` 做键还顺带把测试里的假 fetch 彼此隔开（各自一个查询器、
 * 各自一本请求计数）。
 */
const queriers = new WeakMap<typeof fetch, Map<string, TripoTaskQuerier>>();

export function tripoTaskQuerierFor(options: TripoTaskQuerierOptions): TripoTaskQuerier {
  let byKey = queriers.get(options.fetchFn);
  if (!byKey) {
    byKey = new Map();
    queriers.set(options.fetchFn, byKey);
  }
  const key = `${options.baseUrl}\u0000${options.apiKey}`;
  let querier = byKey.get(key);
  if (!querier) {
    querier = new TripoTaskQuerier(options);
    byKey.set(key, querier);
  }
  return querier;
}
