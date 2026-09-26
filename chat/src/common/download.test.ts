import { describe, expect, test } from "bun:test";
import { downloadBytesWithRetry } from "./download";
import { ChatServiceError } from "./errors";

/** 先发一段字节再断开：模拟 socket 中途被关掉（真实报错就是 socket closed） */
function streamThenError(bytes: number[], error: Error, status: number): Response {
  let sent = false;
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true;
          controller.enqueue(new Uint8Array(bytes));
          return;
        }
        controller.error(error);
      },
    }),
    { status },
  );
}

const SOCKET_CLOSED = new TypeError(
  "The socket connection was closed unexpectedly. For more information, pass `verbose: true` in the second argument to fetch()",
);

describe("downloadBytesWithRetry", () => {
  test("一次 socket 抖动不该让整条下载失败：重试后成功", async () => {
    let calls = 0;
    const fetchFn = (async (_input: string | URL | Request, _init?: RequestInit) => {
      calls += 1;
      if (calls === 1) throw SOCKET_CLOSED;
      return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
    }) as typeof fetch;

    const bytes = await downloadBytesWithRetry("https://example.test/a.glb", {
      fetchFn,
      maxAttempts: 3,
      requestTimeoutMs: 200,
      backoffBaseMs: 1,
    });

    expect(calls).toBe(2);
    expect([...bytes]).toEqual([1, 2, 3]);
  });

  test("body 中途断开：保住已收到的字节，重试时用 Range 从断点续传", async () => {
    const ranges: (string | null)[] = [];
    let calls = 0;
    const fetchFn = (async (_input: string | URL | Request, init?: RequestInit) => {
      calls += 1;
      ranges.push(new Headers(init?.headers).get("range"));
      if (calls === 1) return streamThenError([1, 2], SOCKET_CLOSED, 206);
      return new Response(new Uint8Array([3, 4]), { status: 206 });
    }) as typeof fetch;

    const bytes = await downloadBytesWithRetry("https://example.test/a.spz", {
      fetchFn,
      maxAttempts: 3,
      requestTimeoutMs: 200,
      backoffBaseMs: 1,
    });

    // 第二次必须只取缺的那两个字节，而不是从头再来
    expect(ranges).toEqual([null, "bytes=2-"]);
    expect([...bytes]).toEqual([1, 2, 3, 4]);
  });

  test("服务端不认 Range 回 200 全量时，以这一轮为准、不跟旧字节拼", async () => {
    let calls = 0;
    const fetchFn = (async (_input: string | URL | Request, _init?: RequestInit) => {
      calls += 1;
      if (calls === 1) return streamThenError([1, 2], SOCKET_CLOSED, 200);
      return new Response(new Uint8Array([9, 9, 9]), { status: 200 });
    }) as typeof fetch;

    const bytes = await downloadBytesWithRetry("https://example.test/b.glb", {
      fetchFn,
      maxAttempts: 3,
      requestTimeoutMs: 200,
      backoffBaseMs: 1,
    });

    expect([...bytes]).toEqual([9, 9, 9]);
  });

  test("404 这种明确回错不重试", async () => {
    let calls = 0;
    const fetchFn = (async (_input: string | URL | Request, _init?: RequestInit) => {
      calls += 1;
      return new Response("nope", { status: 404 });
    }) as typeof fetch;

    const error = await downloadBytesWithRetry("https://example.test/missing.glb", {
      fetchFn,
      maxAttempts: 4,
      requestTimeoutMs: 200,
      backoffBaseMs: 1,
    }).catch((err: unknown) => err);

    expect(calls).toBe(1);
    expect((error as ChatServiceError).code).toBe("download_failed");
  });

  test("重试耗尽后给出可恢复的失败信息（指向 repair-assets）", async () => {
    let calls = 0;
    const fetchFn = (async (_input: string | URL | Request, _init?: RequestInit) => {
      calls += 1;
      throw SOCKET_CLOSED;
    }) as unknown as typeof fetch;

    const error = await downloadBytesWithRetry("https://example.test/c.spz", {
      fetchFn,
      maxAttempts: 2,
      requestTimeoutMs: 200,
      backoffBaseMs: 1,
    }).catch((err: unknown) => err);

    expect(calls).toBe(2);
    expect(error).toBeInstanceOf(ChatServiceError);
    expect((error as ChatServiceError).message).toContain("repair-assets");
  });
});
