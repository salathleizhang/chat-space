import { afterEach, expect, mock, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { deferred } from "../../test-utils";
import { BlenderDesktopView, type DesktopViewGrant } from "./DesktopView";
import type { CloudSession } from "./service";

const session: CloudSession = { id: "session-a", epoch: 1, checkpoint: null, state: "ready", stopReason: null,
  owner: "fixture", project: "fixture", batchId: null, itemId: "interactive", instance: "fixture", build: "fixture",
  createdAt: 1, updatedAt: 1, deadline: Date.now() + 60_000, lastActivity: 1, budgetMs: 60_000 };
const initial: DesktopViewGrant = { id: session.id, epoch: 1, checkpoint: null, url: "https://desktop.example/old" };
const mounted: { root: Root; container: HTMLElement }[] = [];
afterEach(async () => { for (const { root, container } of mounted.splice(0)) { await act(async () => root.unmount()); container.remove(); } });
async function render(request: NonNullable<Parameters<typeof BlenderDesktopView>[0]["request"]>, readOnly = false) {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); mounted.push({ root, container });
  const update = async (s: CloudSession) => { await act(async () => { root.render(createElement(BlenderDesktopView, { session: s, initial, request, readOnly })); }); };
  await update(session); return { container, update, root };
}

test("autosave fences the iframe then automatically obtains a fresh desktop grant", async () => {
  const request = mock(async () => ({ url: "https://desktop.example/fresh" }));
  const { container, update } = await render(request);
  expect(container.querySelector("iframe")?.getAttribute("src")).toBe(initial.url);
  await update({ ...session, state: "saving" });
  expect(container.querySelector("iframe")).toBeNull(); expect(container.textContent).toContain("Saving the project");
  expect(request).toHaveBeenCalledTimes(0);
  await update({ ...session, checkpoint: "checkpoint-a" });
  expect(request).toHaveBeenCalledTimes(1);
  expect(container.querySelector("iframe")?.getAttribute("src")).toBe("https://desktop.example/fresh");
  await update({ ...session, checkpoint: "checkpoint-a", updatedAt: 2 });
  expect(request).toHaveBeenCalledTimes(1);
});

test("a read-only batch keeps the exact same live iframe through each intermediate checkpoint", async () => {
  const request = mock(async () => ({ url: "https://desktop.example/fresh" }));
  const { container, update } = await render(request, true);
  const stream = container.querySelector("iframe");
  await update({ ...session, state: "saving" });
  expect(container.querySelector("iframe")).toBe(stream);
  await update({ ...session, checkpoint: "checkpoint-a" });
  expect(container.querySelector("iframe")).toBe(stream);
  await update({ ...session, state: "saving", checkpoint: "checkpoint-a" });
  await update({ ...session, checkpoint: "checkpoint-b" });
  expect(container.querySelector("iframe")).toBe(stream);
  expect(request).not.toHaveBeenCalled();
  await update({ ...session, state: "paused", stopReason: "ended", checkpoint: "checkpoint-b" });
  expect(container.querySelector("iframe")).toBeNull();
});

test("checkpoint identity reconnects even when the display poll missed the saving state", async () => {
  const pending = deferred<{ url: string }>();
  const request = mock(() => pending.promise);
  const { container, update } = await render(request);
  await update({ ...session, checkpoint: "checkpoint-a" });
  expect(container.querySelector("iframe")).toBeNull(); expect(container.textContent).toContain("Reconnecting to the Blender view");
  expect(request).toHaveBeenCalledTimes(1);
  await act(async () => pending.resolve({ url: "https://desktop.example/fresh" }));
  expect(container.querySelector("iframe")?.getAttribute("src")).toBe("https://desktop.example/fresh");
});

test("a late reconnect cannot restore a paused or replaced desktop lease", async () => {
  const pending = deferred<{ url: string }>(); let signal: AbortSignal | undefined;
  const { container, update } = await render((_id, s) => { signal = s; return pending.promise; });
  await update({ ...session, checkpoint: "checkpoint-a" });
  await update({ ...session, state: "paused", stopReason: "ended", checkpoint: "checkpoint-a" });
  expect(signal?.aborted).toBe(true);
  await act(async () => pending.resolve({ url: "https://desktop.example/late" }));
  expect(container.querySelector("iframe")).toBeNull();
  await update({ ...session, epoch: 2, checkpoint: "checkpoint-a" });
  expect(container.querySelector("iframe")).toBeNull();
});

test("display messages are bound to the actual iframe, origin and session before exposing a frame", async () => {
  const previews: string[] = [], request = mock(async () => ({ url: initial.url }));
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); mounted.push({ root, container });
  await act(async () => root.render(createElement(BlenderDesktopView, { session, initial, request, onPreview: image => previews.push(image) })));
  const frame = container.querySelector("iframe")!;
  const message = { type: "chatspace-blender-display", session: session.id, status: "connected", preview: "data:image/jpeg;base64,YWJj" };
  const send = (origin: string, source: MessageEventSource | null, data = message) => window.dispatchEvent(new MessageEvent("message", { origin, source, data }));
  await act(async () => { send("https://other.example", frame.contentWindow); send("https://desktop.example", null); send("https://desktop.example", frame.contentWindow, { ...message, session: "other" }); });
  expect(previews).toEqual([]);
  await act(async () => send("https://desktop.example", frame.contentWindow));
  expect(previews).toEqual([message.preview]);
  expect(container.textContent).not.toContain("Connecting to the live Blender display");
  await act(async () => send("https://desktop.example", frame.contentWindow, { ...message, status: "connecting" }));
  expect(container.querySelector('img[alt="Last received Blender frame while reconnecting"]')?.getAttribute("src")).toBe(message.preview);
  expect(container.textContent).toContain("showing the last received frame");
  expect(container.querySelector("iframe")).toBe(frame);
  await act(async () => send("https://desktop.example", frame.contentWindow));
  expect(container.querySelector('img[alt="Last received Blender frame while reconnecting"]')).toBeNull();
});

test("frequent read-only checkpoints do not postpone the credential renewal clock", async () => {
  const originalInterval = globalThis.setInterval, originalFetch = globalThis.fetch;
  let renew: (() => void) | undefined, renewTimers = 0;
  globalThis.setInterval = ((callback: TimerHandler, delay?: number, ...args: unknown[]) => {
    if (delay === 120_000) { renewTimers++; renew = callback as () => void; }
    return originalInterval(callback, delay, ...args);
  }) as typeof setInterval;
  const network = mock(async (_input: RequestInfo | URL, _init?: RequestInit) => new Response(null, { status: 204 }));
  globalThis.fetch = network as unknown as typeof fetch;
  try {
    const request = mock(async () => ({ url: "https://desktop.example/desktop/session-a/?ticket=fresh" }));
    const { update } = await render(request, true);
    for (let i = 0; i < 5; i++) {
      await update({ ...session, state: "saving", checkpoint: String(i) });
      await update({ ...session, checkpoint: String(i + 1) });
    }
    expect(renewTimers).toBe(1);
    await act(async () => renew!());
    expect(request).toHaveBeenCalledTimes(1);
    expect(network).toHaveBeenCalledTimes(1);
    expect(String(network.mock.calls[0]?.[0])).toContain("/__lease/renew?ticket=fresh");
  } finally { globalThis.setInterval = originalInterval; globalThis.fetch = originalFetch; }
});
