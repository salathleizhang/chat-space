import { afterEach, expect, mock, test } from "bun:test";

/**
 * 真实 `happy-dom` 没有 `indexedDB`，而 `importCloudBlenderExports` 第一件事就是
 * `new BrowserAssetStorage()`。`mock.module` 是**整体替换**，所以其余导出必须摊平保留；
 * 这里只换掉那个类，而且这些用例全部在"还没走到锁与写盘"就结束。
 */
const actualStorage = await import("./storage");
mock.module("./storage", () => ({
  ...actualStorage,
  BrowserAssetStorage: class {
    async exists(_path: string) { return true; }
    async withLock<T>(_path: string, run: () => Promise<T>): Promise<T> { return run(); }
  },
}));

const { importCloudBlenderExports } = await import("./blenderImports");

const SESSION = "4e446a0f-445e-432c-b3bc-4a0837a199c0";
const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** 服务端口的最小替身：只回答给定路由，并记下真实问过哪些路径。 */
function serve(routes: Record<string, unknown>): string[] {
  const asked: string[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const route = String(input).replace("/api/blender/", "");
    asked.push(route);
    const found = Object.hasOwn(routes, route);
    return new Response(JSON.stringify(found ? routes[route] : { error: "Blender record unavailable" }), {
      status: found ? 200 : 404, headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  return asked;
}

test("没有已发布导出的会话会说清楚，而不是让模型看起来丢了", async () => {
  // 真实事故形状：任务以 model_budget_exhausted 结束，云端只有一个已保存的 .blend 检查点。
  const asked = serve({
    [`sessions/${SESSION}`]: { session: { project: "demo" } },
    [`sessions/${SESSION}/exports`]: { exports: [] },
  });
  await expect(importCloudBlenderExports("demo", SESSION)).rejects.toThrow("no exported GLB to import");
  expect(asked).toEqual([`sessions/${SESSION}`, `sessions/${SESSION}/exports`]);
});

test("空导出这条提示不会盖掉真正的清单错误", async () => {
  serve({
    [`sessions/${SESSION}`]: { session: { project: "demo" } },
    [`sessions/${SESSION}/exports`]: { exports: [{ id: "not-a-uuid", sessionId: SESSION, bytes: 53544, sha256: "x", triangles: 972 }] },
  });
  await expect(importCloudBlenderExports("demo", SESSION)).rejects.toThrow("Invalid model manifest");
});

test("会话属于别的项目时在读导出之前就拒绝", async () => {
  const asked = serve({ [`sessions/${SESSION}`]: { session: { project: "another" } } });
  await expect(importCloudBlenderExports("demo", SESSION)).rejects.toThrow("belongs to another project");
  expect(asked).toEqual([`sessions/${SESSION}`]);
});
