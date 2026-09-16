import { afterEach, describe, expect, mock, test } from "bun:test";
import { streamChat } from "./chatClient";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function handlers() {
  return {
    onDelta: mock(() => {}),
    onError: mock(() => {}),
    onDone: mock(() => {}),
  };
}

function sseResponse(body: string): Response {
  return new Response(body, {
    headers: { "Content-Type": "text/event-stream" },
  });
}

describe("streamChat", () => {
  test("忽略 SSE 心跳注释并正常处理 done", async () => {
    globalThis.fetch = mock(async () =>
      sseResponse(
        ': keep-alive\n\nevent: delta\ndata: {"type":"delta","text":"完成"}\n\n' +
          'event: done\ndata: {"type":"done"}\n\n',
      ),
    ) as unknown as typeof fetch;
    const callbacks = handlers();

    await streamChat("demo", [], {}, callbacks);

    expect(callbacks.onDelta).toHaveBeenCalledWith("完成");
    expect(callbacks.onDone).toHaveBeenCalledTimes(1);
    expect(callbacks.onError).not.toHaveBeenCalled();
  });

  test("没有终止事件就 EOF 时显式报告连接中断", async () => {
    globalThis.fetch = mock(async () =>
      sseResponse(': keep-alive\n\nevent: delta\ndata: {"type":"delta","text":"一半"}\n\n'),
    ) as unknown as typeof fetch;
    const callbacks = handlers();

    await streamChat("demo", [], {}, callbacks);

    expect(callbacks.onDone).not.toHaveBeenCalled();
    expect(callbacks.onError).toHaveBeenCalledWith(
      "与本地 chat 服务的连接意外中断，请重试。",
    );
  });

  test("error 是终止事件，不在 EOF 后重复报错", async () => {
    globalThis.fetch = mock(async () =>
      sseResponse('event: error\ndata: {"type":"error","message":"上游失败"}\n\n'),
    ) as unknown as typeof fetch;
    const callbacks = handlers();

    await streamChat("demo", [], {}, callbacks);

    expect(callbacks.onError).toHaveBeenCalledTimes(1);
    expect(callbacks.onError).toHaveBeenCalledWith("上游失败");
  });
});
