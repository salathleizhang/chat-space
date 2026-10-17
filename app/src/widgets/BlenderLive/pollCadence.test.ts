import { expect, test } from "bun:test";
import { BLENDER_ACTIVE_POLL_MS, BLENDER_IDLE_POLL_MS, blenderPollDelayMs } from "./pollCadence";

test("隐藏的标签页一次都不轮询：后台开着也照样烧掉服务的 Durable Object 读配额", () => {
  expect(blenderPollDelayMs([], true)).toBeNull();
  // 即使云端正在跑任务，隐藏的标签页也看不到进度（列表本身还是活的，回到前台会立刻刷）。
  expect(blenderPollDelayMs([{ state: "ready" }], true)).toBeNull();
  expect(blenderPollDelayMs([{ state: "paused" }], true)).toBeNull();
});

test("有会话在跑就保持原来的 5 秒节奏", () => {
  for (const state of ["queued", "allocating", "preparing", "ready", "saving", "cleaning", "pausing"]) {
    expect(blenderPollDelayMs([{ state }], false)).toBe(BLENDER_ACTIVE_POLL_MS);
  }
  // 只要有一个在跑，整张列表就按快节奏刷（别的窗口的进度也要跟得上）。
  expect(blenderPollDelayMs([{ state: "paused" }, { state: "queued" }], false)).toBe(BLENDER_ACTIVE_POLL_MS);
});

test("没有东西在跑就退到慢心跳，但不会完全停下（新任务仍要自己冒出来）", () => {
  expect(blenderPollDelayMs([], false)).toBe(BLENDER_IDLE_POLL_MS);
  for (const state of ["paused", "expired", "quarantined"]) {
    expect(blenderPollDelayMs([{ state }], false)).toBe(BLENDER_IDLE_POLL_MS);
  }
  expect(BLENDER_IDLE_POLL_MS).toBeGreaterThan(BLENDER_ACTIVE_POLL_MS);
});
