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
async function render(request: NonNullable<Parameters<typeof BlenderDesktopView>[0]["request"]>) {
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container); mounted.push({ root, container });
  const update = async (s: CloudSession) => { await act(async () => { root.render(createElement(BlenderDesktopView, { session: s, initial, request })); }); };
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
