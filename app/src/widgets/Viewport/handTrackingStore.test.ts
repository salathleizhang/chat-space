import { describe, expect, test } from "bun:test";
import {
  HAND_FPS_INTERVAL_MS,
  createHandTrackingStore,
  handStatusLabel,
  handStatusTone,
  type HandTrackingFrame,
} from "./handTrackingStore";
import { syntheticHandLandmarks } from "./handDebug";

/**
 * 共享容器的**三条纪律**（它们决定预览小窗与场景每帧读到什么）：
 * ① 热路径（每帧的手）不进订阅通知——否则预览小窗 30–60 Hz 重渲染；
 * ② 新的一帧必须**叫醒渲染循环**（画布是 demand 模式，不叫就永远不重画）；
 * ③ 掉出 running 时把读数清干净，别把上一轮的 fps/手数留在面板上。
 */

const frame = (hands: number, detectMs: number, timestampMs: number): HandTrackingFrame => ({
  hands: Array.from({ length: hands }, (_, index) => ({
    landmarks: syntheticHandLandmarks({ center: [0.3 + index * 0.4, 0.6], pinched: index === 0 }),
    physical: index === 0 ? "left" : "right",
    pinching: index === 0,
    pinchRatio: index === 0 ? 0.1 : 1,
    confidence: 0.9,
  })),
  frameId: timestampMs,
  timestampMs,
  detectMs,
});

describe("手势状态容器", () => {
  test("状态流转：idle → requesting → loading → running", () => {
    const store = createHandTrackingStore();
    expect(store.getSnapshot().status).toBe("idle");
    store.setStatus("requesting");
    expect(store.getSnapshot().status).toBe("requesting");
    store.setStatus("loading");
    expect(store.getSnapshot().status).toBe("loading");
    store.setStatus("running");
    expect(store.getSnapshot().status).toBe("running");
  });

  test("出错时带上给用户看的一句话，且读数清零", () => {
    const store = createHandTrackingStore();
    store.setStatus("running");
    store.publishFrame(frame(2, 12, 10_000));
    expect(store.getSnapshot().handCount).toBe(2);

    store.setStatus("error", "Camera permission denied");
    const snapshot = store.getSnapshot();
    expect(snapshot.status).toBe("error");
    expect(snapshot.error).toBe("Camera permission denied");
    expect(snapshot.handCount).toBe(0);
    expect(snapshot.fps).toBe(0);
    expect(store.getFrame().hands).toHaveLength(0);
  });

  test("每帧都换 frame 引用（R3F 直接读它），但订阅只在低速字段变化时被叫", () => {
    const store = createHandTrackingStore();
    let notifications = 0;
    store.subscribe(() => { notifications += 1; });

    store.publishFrame(frame(1, 10, 10_000));
    const first = notifications;
    expect(first).toBeGreaterThan(0); // 手数从 0 → 1

    // 同一只手、检测耗时在变，但没到 fps 刷新间隔：不该再通知
    store.publishFrame(frame(1, 11, 10_050));
    store.publishFrame(frame(1, 12, 10_100));
    expect(notifications).toBe(first);
    // 但 frame 本身必须是最新的（热路径）
    expect(store.getFrame().detectMs).toBe(12);

    // 到了间隔：fps 更新，通知一次
    store.publishFrame(frame(1, 10, 10_000 + HAND_FPS_INTERVAL_MS));
    expect(notifications).toBe(first + 1);
    expect(store.getSnapshot().fps).toBeGreaterThan(0);
  });

  test("新的一帧会叫醒渲染循环（demand 模式唯一的续帧来源）", () => {
    const store = createHandTrackingStore();
    let woken = 0;
    store.setFrameRequester(() => { woken += 1; });
    store.publishFrame(frame(1, 10, 10_000));
    expect(woken).toBe(1);
    store.requestFrame();
    expect(woken).toBe(2);
    // 卸载时注销，之后再叫不该有副作用
    store.setFrameRequester(null);
    store.publishFrame(frame(1, 10, 10_500));
    expect(woken).toBe(2);
  });

  test("注入期间检测帧不得覆盖注入帧（否则合成的手只活到下一帧检测结果）", () => {
    const store = createHandTrackingStore();
    store.publishFrame(frame(1, 10, 10_000));
    expect(store.getFrame().hands).toHaveLength(1);

    // 注入：锁 + 写一帧（注入走的是绕过锁的那条通路）
    store.setDetectionLock(true);
    store.publishInjectedFrame(frame(2, 10, 10_016));
    expect(store.getFrame().hands).toHaveLength(2);

    // 检测循环的下一帧到了：被挡住，注入帧还在
    store.publishFrame(frame(0, 11, 10_032));
    expect(store.getFrame().hands).toHaveLength(2);

    // 解锁之后检测帧重新生效（真机路径不能被诊断口永久顶掉）
    store.setDetectionLock(false);
    store.publishFrame(frame(0, 11, 10_048));
    expect(store.getFrame().hands).toHaveLength(0);
  });

  test("射线是渲染线程写的、物理步跨帧读的：清了就真的是 null", () => {
    const store = createHandTrackingStore();
    expect(store.getPointer()).toBeNull();
    store.setPointer({
      origin: [0, 1, 0],
      direction: [0, 0, -1],
      tip: [0, 1, -0.6],
      active: true,
      pinching: true,
      slot: "left",
    });
    expect(store.getPointer()?.slot).toBe("left");
    store.setPointer(null);
    expect(store.getPointer()).toBeNull();
  });

  test("检测健康度：发布数会涨，抛错次数与最后一条错误都留痕", () => {
    // 这三条是"看不到手"的分诊依据（见 handTrackingStore.ts 的注释）
    const store = createHandTrackingStore();
    expect(store.getSnapshot().published).toBe(0);
    store.publishFrame(frame(1, 10, 10_000));
    store.publishFrame(frame(1, 10, 10_500));
    expect(store.getSnapshot().published).toBe(2);
    expect(store.getSnapshot().detectErrors).toBe(0);

    store.noteDetectError(new Error("boom in detectForVideo"));
    expect(store.getSnapshot().detectErrors).toBe(1);
    expect(store.getSnapshot().detectError).toBe("boom in detectForVideo");
    // 非 Error 也留得下话（wasm 有时抛字符串）
    store.noteDetectError("plain string");
    expect(store.getSnapshot().detectErrors).toBe(2);
    expect(store.getSnapshot().detectError).toBe("plain string");

    store.reset();
    expect(store.getSnapshot().published).toBe(0);
    expect(store.getSnapshot().detectErrors).toBe(0);
    expect(store.getSnapshot().detectError).toBeNull();
  });

  test("reset 把一切都清回初始态", () => {
    const store = createHandTrackingStore();
    store.setStatus("running", null, "cdn");
    store.publishFrame(frame(2, 20, 10_000));
    store.reset();
    expect(store.getSnapshot().status).toBe("idle");
    expect(store.getSnapshot().handCount).toBe(0);
    expect(store.getFrame().hands).toHaveLength(0);
  });
});

describe("状态文案", () => {
  const base = createHandTrackingStore().getSnapshot();

  test("每种状态都有一句话（预览小窗直接显示它）", () => {
    expect(handStatusLabel({ ...base, status: "idle" })).toBe("Hand tracking off");
    expect(handStatusLabel({ ...base, status: "requesting" })).toContain("camera");
    expect(handStatusLabel({ ...base, status: "loading" })).toContain("Loading");
    expect(handStatusLabel({ ...base, status: "running", handCount: 0 })).toBe("Show your hands");
    expect(handStatusLabel({ ...base, status: "running", handCount: 2 })).toBe("Tracking");
    expect(handStatusLabel({ ...base, status: "error", error: "No camera found" })).toBe("No camera found");
    // error 但没带消息时不能显示空字符串
    expect(handStatusLabel({ ...base, status: "error", error: null })).toBe("Hand tracking failed");
  });

  test("色调：看得见手才算 live，出错是 error，其余是 busy", () => {
    expect(handStatusTone({ ...base, status: "running", handCount: 1 })).toBe("live");
    expect(handStatusTone({ ...base, status: "running", handCount: 0 })).toBe("busy");
    expect(handStatusTone({ ...base, status: "loading" })).toBe("busy");
    expect(handStatusTone({ ...base, status: "error" })).toBe("error");
  });
});
