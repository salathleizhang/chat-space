import { describe, expect, test } from "bun:test";
import { ChatServiceError } from "./errors";
import {
  API_REQUEST_TIMEOUT_MS,
  fetchWithTimeout,
  isRetryableNetworkError,
  isTimeoutError,
  withRequestTimeout,
} from "./http";

describe("withRequestTimeout", () => {
  test("给没有 signal 的请求补上超时信号", () => {
    const init = withRequestTimeout({ method: "POST" }, API_REQUEST_TIMEOUT_MS);
    expect(init.method).toBe("POST");
    expect(init.signal).toBeInstanceOf(AbortSignal);
    expect(init.signal?.aborted).toBe(false);
  });

  test("调用方自带 signal 时保持不动，尊重显式取消", () => {
    const controller = new AbortController();
    const init = withRequestTimeout({ signal: controller.signal }, API_REQUEST_TIMEOUT_MS);
    expect(init.signal).toBe(controller.signal);
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
