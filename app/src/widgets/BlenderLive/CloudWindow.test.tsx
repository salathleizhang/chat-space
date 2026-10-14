import { afterEach, expect, mock, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { BlenderCloudWindow } from "./CloudWindow";
import type { CloudSession } from "./service";

const originalFetch = globalThis.fetch, originalInterval = globalThis.setInterval;
let root: Root | undefined, host: HTMLElement | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); host?.remove(); root = undefined; host = undefined;
  globalThis.fetch = originalFetch; globalThis.setInterval = originalInterval; });
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
