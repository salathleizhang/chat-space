import { describe, expect, test } from "bun:test";
import { killJsTimers } from "../common/deadTimers.testkit";
import { resetTaskPumps, tickTaskPumps } from "../common/taskPump";
import { TripoTaskQuerier } from "./tripoTaskQuery";

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("Tripo 查询器的生命周期与合并", () => {
  test("空闲时冲刷不会把查询器弄死（flush 生命周期回归）", async () => {
    let requests = 0;
    const fetchFn = (async () => {
      requests += 1;
      return jsonResponse({ code: 0, data: { tasks: { t1: { status: "success" } } } });
    }) as unknown as typeof fetch;
    const querier = new TripoTaskQuerier({
      baseUrl: "https://fake.tripo.test/v3",
      apiKey: "k",
      fetchFn,
      coalesceWindowMs: 1,
    });
    // 空闲冲刷：drain() 会同步跑完，旧实现会把 running 永久占住 → 后面的查询再也发不出去
    await querier.flushNow();
    await querier.flushNow();
    expect(requests).toBe(0); // 没有等待者时不该发任何请求
    const pending = querier.query("t1", 1_000);
    await querier.flushNow();
    const task = await pending;
    expect(task.status).toBe("success");
    expect(requests).toBe(1);
  });

  test("同一窗口的多个查询合并成一个批量请求", async () => {
    const bodies: unknown[] = [];
    const fetchFn = (async (_input: unknown, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return jsonResponse({
        code: 0,
        data: { tasks: { t1: { status: "running" }, t2: { status: "success" } } },
      });
    }) as unknown as typeof fetch;
    const querier = new TripoTaskQuerier({
      baseUrl: "https://fake.tripo.test/v3",
      apiKey: "k",
      fetchFn,
      coalesceWindowMs: 1,
    });
    const first = querier.query("t1", 1_000);
    const second = querier.query("t2", 1_000);
    await querier.flushNow();
    expect((await first).status).toBe("running");
    expect((await second).status).toBe("success");
    expect(bodies).toHaveLength(1);
    expect((bodies[0] as { task_ids: string[] }).task_ids.sort()).toEqual(["t1", "t2"]);
  });

  test("批量端点不可用时退回逐任务 GET", async () => {
    const urls: string[] = [];
    const fetchFn = (async (input: unknown) => {
      const url = String(input);
      urls.push(url);
      if (url.endsWith("/tasks/list")) return jsonResponse({ code: 404 }, 404);
      return jsonResponse({ code: 0, data: { status: "success" } });
    }) as unknown as typeof fetch;
    const querier = new TripoTaskQuerier({
      baseUrl: "https://fake.tripo.test/v3",
      apiKey: "k",
      fetchFn,
      coalesceWindowMs: 1,
    });
    const pending = querier.query("t9", 1_000);
    await querier.flushNow();
    expect((await pending).status).toBe("success");
    expect(urls.some((url) => url.endsWith("/tasks/t9"))).toBe(true);
  });

  test("定时器停摆时，外部 tick 冲刷合并窗口把查询发出去", async () => {
    resetTaskPumps();
    const timers = killJsTimers();
    try {
      let requests = 0;
      const fetchFn = (async () => {
        requests += 1;
        return jsonResponse({ code: 0, data: { tasks: { t5: { status: "success" } } } });
      }) as unknown as typeof fetch;
      const querier = new TripoTaskQuerier({
        baseUrl: "https://fake.tripo.test/v3",
        apiKey: "k",
        fetchFn,
        coalesceWindowMs: 25,
      });
      // 查询压在 25 ms 的合并窗口上——这个定时器已经不响了
      const pending = querier.query("t5", 1_000);
      tickTaskPumps();
      expect((await pending).status).toBe("success");
      expect(requests).toBe(1);
    } finally {
      timers.restore();
      resetTaskPumps();
    }
  });
});
