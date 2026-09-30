import { expect, test, mock } from "bun:test";
import { CaptureQueue } from "../CaptureQueue";
import { ResourceBudget, captureBytes } from "../ResourceBudget";
import type { CapturePixels } from "./capture";
import { captureSceneThroughQueue, type CaptureSceneResult } from "./captureViaQueue";

const pixels = (size: number): CapturePixels => ({ width: size, height: size, rgba: new Uint8Array(size * size * 4) });
const app = { graphicsDevice: { samples: 1 } };

/** 每个用例用独立的队列 / 预算实例：模块级单例会在用例之间互相污染。 */
function harness(budgetBytes = 128 * 1024 * 1024) {
  const queue = new CaptureQueue();
  const budget = new ResourceBudget(budgetBytes);
  const calls: number[] = [];
  const capture = mock(async (_app: unknown, options: { size: number }) => { calls.push(options.size); return pixels(options.size); });
  const deps = { enqueue: queue.enqueue.bind(queue), capture };
  return { queue, budget, calls, capture, deps };
}

test("走队列 + 预约预算后跑通，并回报实际尺寸与等待时长", async () => {
  const h = harness();
  // 必须注入假 capture：真实实现会去 import playcanvas 并遍历场景，测试环境里没有 GPU。
  const result = await captureSceneThroughQueue(app, { size: 512, samples: 1 }, h.deps);
  expect(result).toMatchObject({ size: 512, degraded: false, width: 512, height: 512 });
  expect(result.rgba.length).toBe(512 * 512 * 4);
  expect(result.queuedMs).toBeGreaterThanOrEqual(0);
});

test("预算不足时按尺寸阶梯**降级**，而不是失败", async () => {
  // 请求 1024 必须被**降级**（而不是抛错），且回报 degraded 与实际尺寸。
  // 这条能测到，是因为预算实例是注入的——用模块级单例就测不了了。
  const queue = new CaptureQueue();
  // 预算按引擎的公式算：captureBytes(256,1) ≈ 1.5MB，而 captureBytes(512,1) ≈ 6MB，
  // 所以这个额度**只放得下 256**，请求 1024 必然降级。手写 w*h*4 会算错（实际还要算上
  // depth、MSAA、行填充与 CPU 侧 RGBA）。
  const budget = new ResourceBudget(captureBytes(256, 1));
  const capture = mock(async (_app: unknown, options: { size: number }) => pixels(options.size));
  const result = await captureSceneThroughQueue(app, { size: 1024, samples: 1 }, {
    enqueue: queue.enqueue.bind(queue), capture, budget,
  });
  expect(result.degraded).toBe(true);
  expect(result.size).toBe(256);
  expect(capture).toHaveBeenCalledWith(app, expect.objectContaining({ size: 256 }));
});

test("预算连最小尺寸都放不下时抛错，且错误信息可读", async () => {
  const queue = new CaptureQueue();
  const budget = new ResourceBudget(16);
  await expect(
    captureSceneThroughQueue(app, { size: 1024, samples: 1 }, {
      enqueue: queue.enqueue.bind(queue), capture: mock(async () => pixels(256)), budget,
    }),
  ).rejects.toThrow(/budget exceeded/i);
});

test("预约在**读回之后**才释放：读回期间占用不能提前让出去", async () => {
  const queue = new CaptureQueue();
  let releaseCalls = 0;
  let heldDuringReadback: number | undefined;
  const budget = {
    reserveCapture: () => ({ size: 256, degraded: false, release: () => { releaseCalls += 1; } }),
  } as never;
  await captureSceneThroughQueue(app, { size: 256, samples: 1 }, {
    enqueue: queue.enqueue.bind(queue),
    budget,
    capture: (async (_app: unknown, options: { size: number }) => {
      heldDuringReadback = releaseCalls; // 进入读回时应当**还没**释放
      return pixels(options.size);
    }) as never,
  });
  expect(heldDuringReadback).toBe(0);
  expect(releaseCalls).toBe(1); // 读回结束后恰好释放一次
});

test("入队时已 abort 的请求直接拒绝，不渲染", async () => {
  const h = harness();
  const controller = new AbortController();
  controller.abort();
  const capture = mock(async () => pixels(256));
  await expect(
    captureSceneThroughQueue(app, { size: 256, signal: controller.signal }, { enqueue: h.queue.enqueue.bind(h.queue), capture }),
  ).rejects.toThrow(/cancel/i);
  expect(capture).not.toHaveBeenCalled();
});

test("优先级经队列传递：inspection 插在 thumbnail 前面", async () => {
  const queue = new CaptureQueue();
  const order: string[] = [];
  const controller = new AbortController();
  const make = (label: string, priority: "inspection" | "thumbnail") =>
    queue.enqueue(priority, controller.signal, async () => { order.push(label); return label; });
  const first = make("thumb-a", "thumbnail");
  const second = make("inspect", "inspection");
  await Promise.all([first, second]);
  expect(order).toEqual(["inspect", "thumb-a"]);
});

test("待办队列满时拒绝，且错误信息可展示", async () => {
  // capacity 限的是**待办队列**（不是运行中的任务）：跑起来的任务已从 pending 里摘走。
  // 所以要先让第一个真跑起来，再占满待办位，第三个才会被拒。
  const queue = new CaptureQueue(1);
  const controller = new AbortController();
  let unblock!: () => void;
  const running = queue.enqueue("thumbnail", controller.signal, () => new Promise<void>((resolve) => { unblock = resolve; }));
  await new Promise((resolve) => setTimeout(resolve, 5));
  const queued = queue.enqueue("thumbnail", controller.signal, async () => {});
  await expect(queue.enqueue("thumbnail", controller.signal, async () => {})).rejects.toThrow(/queue is full/i);
  unblock();
  await Promise.all([running, queued]);
});

test("结果类型包含降级标记（消费方可据此知道截图比请求的小）", () => {
  const sample: CaptureSceneResult = { width: 256, height: 256, rgba: new Uint8Array(0), size: 256, degraded: true, queuedMs: 12 };
  expect(sample.degraded).toBe(true);
  expect(sample.size).toBeLessThan(512);
});
