import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ChatServiceError } from "../common/errors";
import { tripoGate } from "./tripoConcurrency";
import {
  retryAfterMsFrom,
  runTripoTask,
  tripoRetryPolicy,
  TripoRateLimitError,
  waitForTripoTask,
} from "./tripo";

/** 模拟「请求永远不返回」的 fetch：只有 AbortSignal 触发时才 reject */
function hangingFetch(): typeof fetch {
  return ((_input: string | URL | Request, init?: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      const signal = init?.signal;
      if (!signal) return;
      if (signal.aborted) {
        reject(signal.reason);
        return;
      }
      signal.addEventListener("abort", () => reject(signal.reason), { once: true });
    })) as typeof fetch;
}

/** 最坏情况：既不返回，也不理会 abort（Bun 在连接被静默断开时的真实表现） */
function deafFetch(): typeof fetch {
  return ((_input: string | URL | Request, _init?: RequestInit) =>
    new Promise<Response>(() => {})) as typeof fetch;
}

/** 批量查询的假 fetch：按收到的 task_ids 逐 id 回答（官方 POST /tasks/list 形状） */
function batchFetch(answer: (id: string, callIndex: number) => Record<string, unknown>) {
  const bodies: string[][] = [];
  const signals: (AbortSignal | null | undefined)[] = [];
  const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
    signals.push(init?.signal);
    const ids = (JSON.parse(String(init?.body)) as { task_ids: string[] }).task_ids;
    bodies.push(ids);
    const callIndex = bodies.length - 1;
    return new Response(
      JSON.stringify({
        code: 0,
        status: "success",
        data: {
          tasks: Object.fromEntries(ids.map((id) => [id, answer(id, callIndex)])),
          missed: [],
        },
      }),
      { status: 200 },
    );
  }) as typeof fetch;
  return { fetchFn, bodies, signals };
}

/** 等到条件成立（避免用固定 sleep 赌时序） */
async function waitFor(condition: () => boolean, timeoutMs = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await Bun.sleep(2);
}

describe("waitForTripoTask", () => {
  test("轮询请求一直不返回时在 deadline 内失败，不再永远停在 running", async () => {
    const started = Date.now();
    const error = await waitForTripoTask("task-1", {
      apiKey: "tsk_test",
      fetchFn: hangingFetch(),
      pollIntervalMs: 5,
      timeoutMs: 150,
      requestTimeoutMs: 20,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ChatServiceError);
    expect((error as ChatServiceError).code).toBe("tripo_timeout");
    expect((error as ChatServiceError).status).toBe(504);
    // deadline 是硬上限：单次请求超时只是重试，不会把整个任务拖长
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  test("查询请求完全不理会 abort 时仍在 deadline 内失败（2026-09-26 卡 37 分钟的回归）", async () => {
    const started = Date.now();
    const error = await waitForTripoTask("task-deaf", {
      apiKey: "tsk_test",
      fetchFn: deafFetch(),
      pollIntervalMs: 5,
      timeoutMs: 120,
      requestTimeoutMs: 20,
    }).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ChatServiceError);
    expect((error as ChatServiceError).code).toBe("tripo_timeout");
    expect(Date.now() - started).toBeLessThan(3_000);
  });

  test("查询请求都带上了超时信号，且走批量端点", async () => {
    const urls: string[] = [];
    const signals: (AbortSignal | null | undefined)[] = [];
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
      urls.push(String(input));
      signals.push(init?.signal);
      return new Response(
        JSON.stringify({
          code: 0,
          data: { tasks: { "task-2": { status: "success", output: {} } }, missed: [] },
        }),
        { status: 200 },
      );
    }) as typeof fetch;

    await waitForTripoTask("task-2", { apiKey: "tsk_test", fetchFn, pollIntervalMs: 1 });
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
    expect(urls[0]!.endsWith("/tasks/list")).toBe(true);
  });

  test("供应商明确回错时立刻失败，不重试到 deadline", async () => {
    let calls = 0;
    const fetchFn = (async (_input: string | URL | Request, _init?: RequestInit) => {
      calls += 1;
      return new Response("{}", { status: 500 });
    }) as typeof fetch;

    const error = await waitForTripoTask("task-3", {
      apiKey: "tsk_test",
      fetchFn,
      pollIntervalMs: 1,
      timeoutMs: 60_000,
    }).catch((err: unknown) => err);

    expect((error as ChatServiceError).code).toBe("tripo_status_failed");
    // 1 次批量 + 1 次退回的逐任务查询；关键是**没有**在 deadline 之前反复重试
    expect(calls).toBe(2);
  });

  test("批量端点出错时退回逐任务 GET，不让共享请求把一批任务一起判死", async () => {
    const urls: string[] = [];
    const fetchFn = (async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/tasks/list")) return new Response("{}", { status: 500 });
      return new Response(
        JSON.stringify({ code: 0, data: { status: "success", output: {} } }),
        { status: 200 },
      );
    }) as typeof fetch;

    const data = await waitForTripoTask("task-fallback", {
      apiKey: "tsk_fallback",
      fetchFn,
      pollIntervalMs: 1,
    });
    expect(data.status).toBe("success");
    expect(urls[0]!.endsWith("/tasks/list")).toBe(true);
    expect(urls[1]!.endsWith("/tasks/task-fallback")).toBe(true);
  });

  test("批量端点不存在（404）后不再重复试探，直接走逐任务查询", async () => {
    let batchCalls = 0;
    const fetchFn = (async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/tasks/list")) {
        batchCalls += 1;
        return new Response("{}", { status: 404 });
      }
      return new Response(JSON.stringify({ code: 0, data: { status: "success" } }), { status: 200 });
    }) as typeof fetch;

    const options = { apiKey: "tsk_latch", fetchFn, pollIntervalMs: 1 };
    await waitForTripoTask("latch-1", options);
    await waitForTripoTask("latch-2", options);
    expect(batchCalls).toBe(1);
  });

  test("status=running 后 success：返回任务 data", async () => {
    const statuses = ["running", "success"];
    const { fetchFn } = batchFetch(() => ({
      status: statuses.shift() ?? "success",
      output: { model_url: "u" },
    }));

    const data = await waitForTripoTask("task-4", {
      apiKey: "tsk_test",
      fetchFn,
      pollIntervalMs: 1,
    });
    expect(data.status).toBe("success");
  });

  test("同一时刻到点的多个任务合并成一个批量请求（N 个任务不再 N 个请求）", async () => {
    const { fetchFn, bodies } = batchFetch(() => ({ status: "success", output: {} }));
    const options = { apiKey: "tsk_batch", fetchFn, pollIntervalMs: 1 };
    await Promise.all([
      waitForTripoTask("t-a", options),
      waitForTripoTask("t-b", options),
      waitForTripoTask("t-c", options),
    ]);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]!.sort()).toEqual(["t-a", "t-b", "t-c"]);
  });

  test("id 被点名 missed（不存在/过期）时立刻失败，不当作还在跑", async () => {
    const fetchFn = (async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(
        JSON.stringify({ code: 0, data: { tasks: {}, missed: ["task-gone"] } }),
        { status: 200 },
      )) as typeof fetch;

    const error = await waitForTripoTask("task-gone", {
      apiKey: "tsk_test",
      fetchFn,
      pollIntervalMs: 1,
      timeoutMs: 60_000,
    }).catch((err: unknown) => err);

    expect((error as ChatServiceError).code).toBe("tripo_task_not_found");
  });
});

describe("Tripo 提交并发与 429", () => {
  const savedPolicy = { ...tripoRetryPolicy };

  beforeEach(() => {
    tripoGate.reset();
    Object.assign(tripoRetryPolicy, savedPolicy);
  });

  afterEach(() => {
    tripoGate.reset();
    Object.assign(tripoRetryPolicy, savedPolicy);
  });

  function rateLimited(status: number, code: number, retryAfter?: string): Response {
    return new Response(
      JSON.stringify({ code, status: "error", message: "You have exceeded the limit of generation" }),
      {
        status,
        headers: retryAfter === undefined ? {} : { "Retry-After": retryAfter },
      },
    );
  }

  test("P 系列并发闸门：第 6 个排队而不是发出去撞 429", async () => {
    const submitted: string[] = [];
    let releaseAll: (() => void) | undefined;
    const hold = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });
    const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
      submitted.push(String(JSON.parse(String(init?.body)).input));
      return new Response(JSON.stringify({ code: 0, data: { task_id: `t-${submitted.length}` } }), {
        status: 200,
      });
    }) as typeof fetch;

    // 6 个 P 系列（官方并发 5）任务：前 5 个进池并挂住，第 6 个必须还在队列里
    const runs = Array.from({ length: 6 }, (_, index) =>
      runTripoTask(
        { path: "/generation/image-to-model", body: { input: `img-${index}`, model: "P2-20260801" } },
        { apiKey: "tsk-1", fetchFn },
        async (taskId) => {
          await hold;
          return taskId;
        },
      ),
    );
    await waitFor(() => submitted.length >= 5);
    await Bun.sleep(10); // 再等一会儿，确认第 6 个没有偷偷发出去
    expect(submitted).toHaveLength(5);
    expect(tripoGate.activeCount("generation-p")).toBe(5);
    expect(tripoGate.queuedCount("generation-p")).toBe(1);

    releaseAll?.();
    await Promise.all(runs);
    expect(submitted).toHaveLength(6);
    expect(tripoGate.activeCount("generation-p")).toBe(0);
    expect(tripoGate.queuedCount("generation-p")).toBe(0);
  });

  test("H 系列与 P 系列是两个独立池（H 有 10 个槽，不受 P 的 5 限制）", async () => {
    let releaseAll: (() => void) | undefined;
    const hold = new Promise<void>((resolve) => {
      releaseAll = resolve;
    });
    const fetchFn = (async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ code: 0, data: { task_id: "t" } }), { status: 200 })) as typeof fetch;

    const runs = Array.from({ length: 5 }, (_, index) =>
      runTripoTask(
        { path: "/generation/image-to-model", body: { input: `p-${index}`, model: "P1-20260311" } },
        { apiKey: "tsk-1", fetchFn },
        async () => await hold,
      ),
    );
    await waitFor(() => tripoGate.activeCount("generation-p") === 5);
    expect(tripoGate.activeCount("generation-p")).toBe(5);
    // P 池满了，H 池照常进
    await runTripoTask(
      { path: "/generation/image-to-model", body: { input: "h", model: "v3.1-20260211" } },
      { apiKey: "tsk-1", fetchFn },
      async () => "h-done",
    );
    expect(tripoGate.activeCount("generation-h")).toBe(0);
    releaseAll?.();
    await Promise.all(runs);
  });

  test("code 2000（类目并发占满）：按 Retry-After 让出槽位重排，成功后正常返回", async () => {
    let attempts = 0;
    const waits: number[] = [];
    const fetchFn = (async (_input: string | URL | Request, _init?: RequestInit) => {
      attempts += 1;
      if (attempts === 1) return rateLimited(429, 2000, "0");
      return new Response(JSON.stringify({ code: 0, data: { task_id: "task-after-wait" } }), {
        status: 200,
      });
    }) as typeof fetch;

    const started = Date.now();
    const taskId = await runTripoTask(
      { path: "/generation/image-to-model", body: { input: "img", model: "P2-20260801" } },
      { apiKey: "tsk-1", fetchFn },
      async (id) => {
        waits.push(Date.now() - started);
        return id;
      },
    );
    expect(taskId).toBe("task-after-wait");
    expect(attempts).toBe(2);
    // 重排期间不占槽：撞 429 的那一轮已经把槽放掉了
    expect(tripoGate.activeCount("generation-p")).toBe(0);
  });

  test("code 1007（请求频率超限）：指数退避重试，用尽后抛 tripo_rate_limited", async () => {
    tripoRetryPolicy.rateMaxAttempts = 3;
    tripoRetryPolicy.backoffBaseMs = 1;
    tripoRetryPolicy.backoffMaxMs = 2;
    let attempts = 0;
    const fetchFn = (async (_input: string | URL | Request, _init?: RequestInit) => {
      attempts += 1;
      return rateLimited(429, 1007);
    }) as typeof fetch;

    const error = await runTripoTask(
      { path: "/generation/image-to-model", body: { input: "img", model: "v3.1-20260211" } },
      { apiKey: "tsk-1", fetchFn },
      async () => "unreachable",
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(TripoRateLimitError);
    expect((error as TripoRateLimitError).kind).toBe("rate");
    expect((error as TripoRateLimitError).code).toBe("tripo_rate_limited");
    expect(attempts).toBe(3);
    expect(tripoGate.activeCount("generation-h")).toBe(0);
  });

  test("非 429 的提交失败仍然是 tripo_submit_failed（分类没把别的错误吞掉）", async () => {
    const fetchFn = (async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response(JSON.stringify({ code: 2002, message: "Unsupported request parameter" }), {
        status: 400,
      })) as typeof fetch;

    const error = await runTripoTask(
      { path: "/generation/image-to-model", body: { input: "img", model: "P1-20260311" } },
      { apiKey: "tsk-1", fetchFn },
      async () => "unreachable",
    ).catch((err: unknown) => err);

    expect((error as ChatServiceError).code).toBe("tripo_submit_failed");
    expect((error as ChatServiceError).status).toBe(502);
  });
});

describe("retryAfterMsFrom", () => {
  test("秒数与 HTTP 日期都认，坏值返回 undefined", () => {
    expect(retryAfterMsFrom(new Headers({ "Retry-After": "5" }))).toBe(5_000);
    expect(retryAfterMsFrom(new Headers({ "Retry-After": "0" }))).toBe(0);
    // 超过一分钟的等待被钳住，避免一个坏头把任务挂死
    expect(retryAfterMsFrom(new Headers({ "Retry-After": "9999" }))).toBe(60_000);
    expect(retryAfterMsFrom(new Headers({ "Retry-After": "not-a-value" }))).toBeUndefined();
    expect(retryAfterMsFrom(undefined)).toBeUndefined();
    const future = new Date(Date.now() + 3_000).toUTCString();
    const parsed = retryAfterMsFrom(new Headers({ "Retry-After": future }));
    expect(parsed).toBeGreaterThan(0);
    expect(parsed).toBeLessThanOrEqual(3_000);
  });
});
