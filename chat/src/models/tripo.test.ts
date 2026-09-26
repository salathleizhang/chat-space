import { describe, expect, test } from "bun:test";
import { ChatServiceError } from "../common/errors";
import { waitForTripoTask } from "./tripo";

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

  test("查询请求都带上了超时信号", async () => {
    const signals: (AbortSignal | null | undefined)[] = [];
    const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
      signals.push(init?.signal);
      return new Response(JSON.stringify({ data: { status: "success", output: {} } }), {
        status: 200,
      });
    }) as typeof fetch;

    await waitForTripoTask("task-2", { apiKey: "tsk_test", fetchFn, pollIntervalMs: 1 });
    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);
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
    expect(calls).toBe(1);
  });

  test("status=running 后 success：返回任务 data", async () => {
    const statuses = ["running", "success"];
    const fetchFn = (async (_input: string | URL | Request, _init?: RequestInit) => {
      const status = statuses.shift() ?? "success";
      return new Response(JSON.stringify({ data: { status, output: { model_url: "u" } } }), {
        status: 200,
      });
    }) as typeof fetch;

    const data = await waitForTripoTask("task-4", {
      apiKey: "tsk_test",
      fetchFn,
      pollIntervalMs: 1,
    });
    expect(data.status).toBe("success");
  });
});
