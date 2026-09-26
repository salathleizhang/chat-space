import { describe, expect, test } from "bun:test";
import { ChatServiceError } from "./errors";
import {
  API_REQUEST_TIMEOUT_MS,
  Deadline,
  fetchWithTimeout,
  isRetryableNetworkError,
  isTimeoutError,
  withHardTimeout,
  withRequestTimeout,
} from "./http";

describe("withRequestTimeout", () => {
  test("给没有 signal 的请求补上超时信号", () => {
    const init = withRequestTimeout({ method: "POST" }, API_REQUEST_TIMEOUT_MS);
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
  });

  test("调用方自带 signal 时两者取先到者：显式取消仍然有效，超时也不再缺席", () => {
    const controller = new AbortController();
    const init = withRequestTimeout({ signal: controller.signal }, API_REQUEST_TIMEOUT_MS);
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
    controller.abort();
    expect(init.signal?.aborted).toBe(true);
  });

  test("调用方没取消时，超时到点同样会中止组合信号", async () => {
    const controller = new AbortController();
    const init = withRequestTimeout({ signal: controller.signal }, 5);
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(init.signal?.aborted).toBe(true);
  });
});

describe("错误分类", () => {
  test("超时/取消错误可识别", () => {
    expect(isTimeoutError(Object.assign(new Error("x"), { name: "TimeoutError" }))).toBe(true);
    expect(isTimeoutError(Object.assign(new Error("x"), { name: "AbortError" }))).toBe(true);
    expect(isTimeoutError(new Error("x"))).toBe(false);
    expect(isTimeoutError(undefined)).toBe(false);
  });

  test("只有超时和网络层错误可重试，供应商业务错误必须立刻冒泡", () => {
    expect(isRetryableNetworkError(new TypeError("fetch failed"))).toBe(true);
    expect(
      isRetryableNetworkError(new ChatServiceError("超时", 504, "request_timeout")),
    ).toBe(true);
    expect(
      isRetryableNetworkError(new ChatServiceError("鉴权失败", 502, "seed3d_request_failed")),
    ).toBe(false);
  });
});

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

describe("fetchWithTimeout", () => {
  test("挂住的请求在预算到点后变成带上下文的 504，而不是永远 pending", async () => {
    const started = Date.now();
    const failure = fetchWithTimeout(hangingFetch(), "https://example.test/x", undefined, 20, "测试")
      .then(() => null)
      .catch((error: unknown) => error);

    const error = await failure;
    expect(error).toBeInstanceOf(ChatServiceError);
    expect((error as ChatServiceError).code).toBe("request_timeout");
    expect((error as ChatServiceError).status).toBe(504);
    expect((error as ChatServiceError).message).toContain("测试请求超时");
    expect(Date.now() - started).toBeLessThan(2_000);
  });

  test("正常响应原样返回", async () => {
    const fetchFn = (async (_input: string | URL | Request, _init?: RequestInit) =>
      new Response("{}", { status: 200 })) as typeof fetch;
    const response = await fetchWithTimeout(fetchFn, "https://example.test/x", undefined, 50, "测试");
    expect(response.status).toBe(200);
  });
});

/**
 * 最坏情况：fetch 既不返回也不理会 abort。
 *
 * 这正是 2026-09-26 卡死 37 分钟的形态——只靠 AbortSignal 的「超时」在这种情况下
 * 永远不会发生，所以必须有 Promise.race 级别的硬上限兜底。
 */
function deafFetch(): typeof fetch {
  return ((_input: string | URL | Request, _init?: RequestInit) =>
    new Promise<Response>(() => {})) as typeof fetch;
}

describe("withHardTimeout", () => {
  test("work 永不落定且不理会取消时，仍然到点拒绝", async () => {
    const started = Date.now();
    const error = await withHardTimeout(
      new Promise<never>(() => {}),
      30,
      () => new ChatServiceError("硬超时", 504, "request_timeout"),
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(ChatServiceError);
    expect((error as ChatServiceError).code).toBe("request_timeout");
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  test("work 先落定时不误伤，且超时错误不会被抛出来", async () => {
    const value = await withHardTimeout(Promise.resolve("ok"), 30, () => {
      throw new Error("不该走到这里");
    });
    expect(value).toBe("ok");
  });
});

describe("fetchWithTimeout 的硬上限", () => {
  test("fetch 完全不响应 abort 时也不会永远 pending", async () => {
    const started = Date.now();
    const error = await fetchWithTimeout(deafFetch(), "https://example.test/x", undefined, 30, "测试")
      .then(() => null)
      .catch((err: unknown) => err);

    expect((error as ChatServiceError).code).toBe("request_timeout");
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

describe("Deadline", () => {
  const makeError = () => new ChatServiceError("任务超时", 504, "tripo_timeout");

  test("总预算到点必然兑现，即使被包裹的请求完全不理会 abort", async () => {
    const deadline = new Deadline(30, makeError);
    try {
      const started = Date.now();
      const error = await deadline.guard(new Promise<never>(() => {})).catch((err: unknown) => err);
      expect((error as ChatServiceError).code).toBe("tripo_timeout");
      expect(deadline.expired).toBe(true);
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      deadline.dispose();
    }
  });

  test("到期时 signal 会中止，并带上调用方自己的错误（各供应商错误码不丢）", async () => {
    const deadline = new Deadline(20, makeError);
    try {
      const reason = await new Promise((resolve) => {
        deadline.signal.addEventListener("abort", () => resolve(deadline.signal.reason), {
          once: true,
        });
      });
      expect(reason).toBeInstanceOf(ChatServiceError);
      expect((reason as ChatServiceError).code).toBe("tripo_timeout");
    } finally {
      deadline.dispose();
    }
  });

  test("单次尝试可以用更紧的预算，错误仍然是总预算的说法", async () => {
    const deadline = new Deadline(60_000, makeError);
    try {
      const started = Date.now();
      const error = await deadline
        .guard(new Promise<never>(() => {}), 25)
        .catch((err: unknown) => err);
      expect((error as ChatServiceError).code).toBe("tripo_timeout");
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      deadline.dispose();
    }
  });
});
