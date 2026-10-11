import { afterEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { deferred } from "../../test-utils";
import { BlenderSessionWindow } from "./SessionWindow";
import type { CloudSession } from "./service";

const session: CloudSession = { id: "session-a", epoch: 1, checkpoint: null, state: "ready", stopReason: null,
  owner: "fixture", project: "fixture", batchId: null, itemId: "interactive", instance: "fixture", build: "fixture",
  createdAt: 1, updatedAt: 1, deadline: Date.now() + 60_000, lastActivity: 1, budgetMs: 60_000 };
const originalFetch = globalThis.fetch;
const mounted: { root: Root; container: HTMLElement }[] = [];
afterEach(async () => { for (const { root, container } of mounted.splice(0)) { await act(async () => root.unmount()); container.remove(); } globalThis.fetch = originalFetch; });
async function render(sessions: CloudSession[]) {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); mounted.push({ root, container }); const close = mock(() => {});
  const update = async (items: CloudSession[]) => { await act(async () => root.render(items.map((s, index) =>
    <BlenderSessionWindow key={s.id} session={s} index={index} onClose={close} />))); };
  await update(sessions); return { container, update, close };
}

test("each open session automatically gets its own stream, close never stops a sandbox", async () => {
  const requests: string[] = [];
  globalThis.fetch = mock(async (input: Parameters<typeof fetch>[0]) => { const path = String(input); requests.push(path); return Response.json({ url: `about:blank#${path.split("/")[4]}` }); }) as unknown as typeof fetch;
  const { container, update, close } = await render([session, { ...session, id: "session-b" }]);
  expect(requests).toEqual(["/api/blender/sessions/session-a/desktop", "/api/blender/sessions/session-b/desktop"]);
  const b = container.querySelector('[aria-label="Blender sessio"]'); expect(b).not.toBeNull();
  const streams = [...container.querySelectorAll("iframe")]; expect(streams.length).toBe(2); expect(streams[0]!.src).not.toBe(streams[1]!.src);
  await act(async () => (container.querySelector('[aria-label="关闭此 Blender 窗口"]') as HTMLElement).click()); expect(close).toHaveBeenCalledTimes(1);
  await update([{ ...session, id: "session-b", updatedAt: 2 }]);
  expect(container.querySelector("iframe")).toBe(streams[1]!); expect(requests.length).toBe(2); expect(requests.some(path => path.endsWith("/end"))).toBe(false);
});

test("closing one window aborts only its pending grant", async () => {
  const pending = deferred<Response>(); const signals: AbortSignal[] = [];
  globalThis.fetch = mock((_input: Parameters<typeof fetch>[0], options?: RequestInit) => { signals.push(options!.signal!); return pending.promise.then(response => response.clone()); }) as unknown as typeof fetch;
  const { container, update } = await render([session, { ...session, id: "session-b" }]);
  await update([{ ...session, id: "session-b" }]); expect(signals[0]!.aborted).toBe(true); expect(signals[1]!.aborted).toBe(false);
  await act(async () => pending.resolve(Response.json({ url: "about:blank#b" })));
  expect(container.querySelectorAll("iframe").length).toBe(1);
});

test("watching and a saved pause expose no business controls or mutations", async () => {
  const requests: string[] = [];
  globalThis.fetch = mock(async (input: Parameters<typeof fetch>[0]) => { requests.push(String(input)); return Response.json({ url: "about:blank#desktop" }); }) as unknown as typeof fetch;
  const { container, update } = await render([session]);
  expect(container.querySelector('[aria-label="Blender 操作"]')).toBeNull();
  expect(container.querySelectorAll("button").length).toBe(3);
  await update([{ ...session, state: "paused", stopReason: "ended", checkpoint: "saved" }]);
  expect(container.textContent).toContain("工程已保存，等待继续任务。");
  expect(container.querySelectorAll("button").length).toBe(3);
  expect(requests).toEqual(["/api/blender/sessions/session-a/desktop"]);
});

test("resuming the same session uses the new epoch and leaves another window connected", async () => {
  const requests: string[] = [];
  globalThis.fetch = mock(async (input: Parameters<typeof fetch>[0]) => { requests.push(String(input)); return Response.json({ url: `about:blank#grant-${requests.length}` }); }) as unknown as typeof fetch;
  const b = { ...session, id: "session-b" };
  const { container, update } = await render([session, b]); const bStream = container.querySelectorAll("iframe")[1]!;
  await update([{ ...session, state: "paused", stopReason: "ended", checkpoint: "saved" }, b]);
  expect(container.querySelectorAll("iframe").length).toBe(1); expect(container.querySelector("iframe")).toBe(bStream);
  await update([{ ...session, epoch: 2, checkpoint: "saved" }, b]);
  expect(requests.length).toBe(3); expect(container.querySelectorAll("iframe")[1]).toBe(bStream);
  expect(container.querySelectorAll("iframe")[0]!.src).toBe("about:blank#grant-3");
});
