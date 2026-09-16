import { afterEach, describe, expect, mock, test } from "bun:test";
import { deferred, flush } from "../../test-utils";
import { fetchSession, saveSession, type SessionMessage } from "./sessionsClient";

const originalFetch = globalThis.fetch;
const messages: SessionMessage[] = [{ id: "u1", role: "user", content: "生成椅子" }];
afterEach(() => { globalThis.fetch = originalFetch; });

describe("会话请求顺序", () => {
  test("较早的保存未完成时，自动保存与离开时的最新快照都等待同一队列", async () => {
    const firstResponse = deferred<Response>();
    const writes: SessionMessage[][] = [];
    let disk: SessionMessage[] = [];
    globalThis.fetch = mock(async (_url: unknown, init?: RequestInit) => {
      const snapshot = JSON.parse(init!.body as string).messages;
      writes.push(snapshot);
      if (writes.length === 1) await firstResponse.promise;
      disk = snapshot;
      return new Response("{}");
    }) as unknown as typeof fetch;
    const old = saveSession("demo", "s-queue", "旧", messages);
    await flush();
    const updated = [...messages, { id: "a1", role: "assistant" as const, content: "已完成" }];
    const latest = saveSession("demo", "s-queue", "新", updated);
    await flush();
    expect(writes).toHaveLength(1);
    firstResponse.resolve(new Response("{}"));
    await Promise.all([old, latest]);
    expect(writes).toEqual([messages, updated]);
    expect(disk).toEqual(updated);
  });

  test("失败保留错误反馈，但不阻塞后续保存和重新读取", async () => {
    const firstResponse = deferred<Response>();
    const calls: string[] = [];
    globalThis.fetch = mock(async (_url: unknown, init?: RequestInit) => {
      calls.push(init?.method ?? "GET");
      if (calls.length === 1) return firstResponse.promise;
      return Response.json(init?.method === "PUT" ? {} : { session: { id: "s-retry" } });
    }) as unknown as typeof fetch;
    const first = saveSession("demo", "s-retry", "旧", messages).catch((err: Error) => err);
    const second = saveSession("demo", "s-retry", "新", messages);
    const restored = fetchSession("s-retry");
    await flush();
    expect(calls).toEqual(["PUT"]);
    firstResponse.resolve(Response.json({ error: { message: "写盘失败" } }, { status: 500 }));
    expect((await first as Error).message).toBe("写盘失败");
    await second;
    expect((await restored)?.id).toBe("s-retry");
    expect(calls).toEqual(["PUT", "PUT", "GET"]);
  });

  test("不同会话的保存互不阻塞", async () => {
    const blocked = deferred<Response>();
    globalThis.fetch = mock(async (url: unknown) =>
      String(url).endsWith("s-blocked") ? blocked.promise : new Response("{}"),
    ) as unknown as typeof fetch;
    const first = saveSession("demo", "s-blocked", "旧", messages);
    await saveSession("demo", "s-other", "其他会话", messages);
    blocked.resolve(new Response("{}"));
    await first;
  });
});
