import { afterEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BlenderCloudWindow } from "./CloudWindow";
import type { CloudSession } from "./service";

const originalFetch = globalThis.fetch, originalInterval = globalThis.setInterval;
const originalVisibility = Object.getOwnPropertyDescriptor(document, "visibilityState");
let root: Root | undefined, host: HTMLElement | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); root = undefined; host = undefined;
  globalThis.fetch = originalFetch; globalThis.setInterval = originalInterval;
  // 还原真实描述符（happy-dom 的访问器要回来），否则这个只读属主会串到同进程的别的测试文件。
  if (originalVisibility) Object.defineProperty(document, "visibilityState", originalVisibility);
  else delete (document as unknown as Record<string, unknown>).visibilityState; });
/** 造一次可见性切换，跟浏览器一样派发 visibilitychange。 */
function setVisibility(value: "visible" | "hidden") {
  Object.defineProperty(document, "visibilityState", { value, configurable: true });
  document.dispatchEvent(new Event("visibilitychange"));
}
const session: CloudSession = { id: "session-a", epoch: 1, checkpoint: "saved", state: "paused", stopReason: "ended",
  owner: "fixture", project: "fixture", batchId: null, itemId: "interactive", instance: "fixture", build: "fixture",
  createdAt: 1, updatedAt: 1, deadline: Date.now() + 60_000, lastActivity: 1, budgetMs: 60_000 };

test("logo opens all project viewers; polling adds new AI work without reopening dismissed windows or charging", async () => {
  let sessions = [session, { ...session, id: "session-b" }, { ...session, id: "session-other", project: "other" }];
  const requests: { path: string; method: string }[] = []; let tick!: () => void;
  globalThis.setInterval = ((callback: () => void, delay: number) => { tick = callback; return originalInterval(() => {}, delay); }) as unknown as typeof setInterval;
  globalThis.fetch = mock(async (input: Parameters<typeof fetch>[0], options?: RequestInit) => {
    const path = String(input); requests.push({ path, method: options?.method ?? "GET" });
    return Response.json(path === "/api/capabilities" ? { blenderCloud: true } : { sessions, jobs: {} });
  }) as unknown as typeof fetch;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const render = async (request: number) => { await act(async () => root!.render(<BlenderCloudWindow projectSlug="fixture" openRequest={request} />)); };
  await render(1);
  const frames = () => [...document.querySelectorAll<HTMLElement>("[data-blender-window]")];
  expect(frames().length).toBe(2); expect(document.body.textContent).not.toContain("窗口管理");
  const b = frames()[1]!;
  await act(async () => frames()[0]!.querySelector<HTMLButtonElement>("button")!.click()); expect(frames()).toEqual([b]);
  sessions = [...sessions, { ...session, id: "session-c" }];
  await act(async () => tick()); expect(frames().length).toBe(2); expect(frames()[0]).toBe(b);
  await render(2); expect(frames().length).toBe(3); expect(frames()[0]).toBe(b);
  expect(requests.every(request => request.method === "GET")).toBe(true);
  expect(requests.every(request => ["/api/capabilities", "/api/blender/sessions"].includes(request.path))).toBe(true);
});

test("new AI work appears without a logo click, while old paused viewers stay closed", async () => {
  let sessions = [session]; let tick!: () => void;
  globalThis.setInterval = ((callback: () => void, delay: number) => { tick = callback; return originalInterval(() => {}, delay); }) as unknown as typeof setInterval;
  globalThis.fetch = mock(async input => String(input) === "/api/capabilities" ? Response.json({ blenderCloud: true }) : Response.json({ sessions, jobs: {} })) as unknown as typeof fetch;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<BlenderCloudWindow projectSlug="fixture" openRequest={0} />));
  expect(document.querySelectorAll("[data-blender-window]").length).toBe(0);
  sessions = [...sessions, { ...session, id: "new-task", state: "queued", stopReason: null }];
  await act(async () => tick());
  expect(document.querySelectorAll("[data-blender-window]").length).toBe(1);
  expect(document.body.textContent).toContain("Blender new-ta");
});

/**
 * 2026-10-17 事故：桌面标签页每 5 秒轮询一次会话列表，把 Cloudflare Durable Object 的
 * `rows read` 免费额度读爆（5M/天），整个 Blender 服务返回 503。这条钉住"隐藏的标签页不再轮询"。
 */
test("隐藏的标签页不再轮询；回到前台立刻刷新，但不会重新打开被关掉的窗口", async () => {
  // 用 queued 会话：它在 CloudWindow 眼里是"在跑"（要 5 秒节奏），但不挂 DesktopView，
  // 所以 setInterval 里只会有本组件自己的节奏，不会混进子组件的 1 秒/120 秒。
  const sessions = [{ ...session, state: "queued", stopReason: null }];
  const requests: string[] = [], intervals: number[] = [];
  globalThis.setInterval = ((_callback: () => void, delay: number) => { intervals.push(delay); return originalInterval(() => {}, delay); }) as unknown as typeof setInterval;
  globalThis.fetch = mock(async input => { const path = String(input); requests.push(path);
    return Response.json(path === "/api/capabilities" ? { blenderCloud: true } : { sessions, jobs: {} }); }) as unknown as typeof fetch;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  const frames = () => [...document.querySelectorAll<HTMLElement>("[data-blender-window]")];
  await act(async () => root!.render(<BlenderCloudWindow projectSlug="fixture" openRequest={1} />));
  expect(intervals.every(delay => delay === 5_000 || delay === 30_000)).toBe(true);
  expect(intervals[intervals.length - 1]).toBe(5_000);   // 会话在跑 = 用户在看进度 → 保持原来的 5 秒
  expect(frames().length).toBe(1);
  await act(async () => frames()[0]!.querySelector<HTMLButtonElement>("button")!.click());
  expect(frames().length).toBe(0);
  const before = requests.length, scheduled = intervals.length;
  await act(async () => { setVisibility("hidden"); });
  expect(intervals.length).toBe(scheduled);              // 隐藏期间没有再安排任何一次轮询
  expect(requests.length).toBe(before);                  // 也不补发那一次：隐藏的标签页一次都不发
  await act(async () => { setVisibility("visible"); });
  expect(intervals.length).toBe(scheduled + 1);          // 回到前台才重新排（立刻刷一次 + 继续轮询）
  expect(intervals[intervals.length - 1]).toBe(5_000);
  expect(requests.length).toBeGreaterThan(before);
  expect(frames().length).toBe(0);                       // 节奏变化不是"再看一次全部"：被关掉的窗口不许自己回来
});

test("没有东西在跑时退到 30 秒心跳，新任务仍然会自己冒出来", async () => {
  let sessions = [session]; const intervals: number[] = []; let tick!: () => void;
  globalThis.setInterval = ((callback: () => void, delay: number) => { intervals.push(delay); tick = callback; return originalInterval(() => {}, delay); }) as unknown as typeof setInterval;
  globalThis.fetch = mock(async input => String(input) === "/api/capabilities" ? Response.json({ blenderCloud: true }) : Response.json({ sessions, jobs: {} })) as unknown as typeof fetch;
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root!.render(<BlenderCloudWindow projectSlug="fixture" openRequest={0} />));
  expect(intervals).toEqual([30_000]);                   // 没有会话 → 慢心跳，且没有子组件掺进来
  // 慢心跳不等于停下：新任务照样在下一个节拍出现。
  sessions = [...sessions, { ...session, id: "new-task", state: "queued", stopReason: null }];
  await act(async () => tick());
  expect(document.querySelectorAll("[data-blender-window]").length).toBe(1);
  // 一有会话在跑就切回快节奏（没有 showAll，不会顺带重开别的窗口）。
  expect(intervals[intervals.length - 1]).toBe(5_000);
});
