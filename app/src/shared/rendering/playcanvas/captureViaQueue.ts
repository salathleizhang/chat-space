import { captureQueue, type CapturePriority } from "../CaptureQueue";
import { MIN_CAPTURE_SIZE, captureBudget, type MemoryPressure } from "../ResourceBudget";
import { captureScenePixels, type CapturePixels } from "./capture";

/**
 * 把**纯 TS 的准入层**接到 PlayCanvas 的截图上。
 *
 * `CaptureQueue` 与 `ResourceBudget` 都是与引擎无关的纯逻辑（优先级、16 上限、1.5s 老化、
 * 交互让行、尺寸阶梯降级、两本账取更紧的一侧），**迁移时不要重写它们**——本模块只做编排：
 *
 * ```
 * 入队（准入 + 背压）→ 预约预算（可能降级）→ 渲染进私有 RT + 读回 → 释放预约
 * ```
 *
 * ### 为什么 `pressure` / `reclaim` 是注入的而不是直接导入
 * 两本账的另一侧是**模型缓存**（`ModelResources`），它目前仍绑在 three 上。
 * 直接导入会把 three 拖进这个模块；而且"截图准入同时看两侧余量"这条语义属于应用装配，
 * 不属于截图本身。应用侧接上时传入真实探针即可——
 * three 侧的做法见 `shared/rendering/capture.ts` 里那个 `modelPressure` 常量。
 */

export interface CaptureSceneRequest {
  /** 期望的输出边长（正方形）。预算不足时会**降级**到更小尺寸。 */
  size: number;
  priority?: CapturePriority;
  signal?: AbortSignal;
  camera?: unknown;
  clearColor?: [number, number, number];
  /** 设备采样数，用于估算这条尺寸要多少字节。默认读引擎当前值。 */
  samples?: number;
  /** 腾内存：参数是还差多少字节。不传则不回收。 */
  reclaim?: (needBytes: number) => void;
  /** 模型缓存侧的余量探针。不传则只看截图这一本账。 */
  pressure?: MemoryPressure;
}

export interface CaptureSceneResult extends CapturePixels {
  /** 实际使用的边长；小于请求值即发生了降级。 */
  size: number;
  degraded: boolean;
  /** 入队到开始执行之间的等待时长（毫秒），用于观察交互让行是否生效。 */
  queuedMs: number;
}

export async function captureSceneThroughQueue(
  app: unknown,
  request: CaptureSceneRequest,
  deps: {
    enqueue?: typeof captureQueue.enqueue;
    capture?: typeof captureScenePixels;
    now?: () => number;
    /** 预算实例。默认模块级单例；注入是为了让"降级"这条路径能被测到。 */
    budget?: typeof captureBudget;
  } = {},
): Promise<CaptureSceneResult> {
  const enqueue = deps.enqueue ?? captureQueue.enqueue.bind(captureQueue);
  const capture = deps.capture ?? captureScenePixels;
  const now = deps.now ?? (() => performance.now());
  const budget = deps.budget ?? captureBudget;
  const priority = request.priority ?? "thumbnail";
  const signal = request.signal ?? new AbortController().signal;
  const samples = request.samples ?? readSamples(app);
  const queuedAt = now();

  return enqueue(priority, signal, async () => {
    const reservation = budget.reserveCapture(
      request.size,
      samples,
      request.reclaim ?? (() => {}),
      MIN_CAPTURE_SIZE,
      request.pressure,
    );
    try {
      const pixels = await capture(app as never, {
        size: reservation.size,
        camera: request.camera,
        clearColor: request.clearColor,
      });
      return {
        ...pixels,
        size: reservation.size,
        degraded: reservation.degraded,
        queuedMs: Math.round(now() - queuedAt),
      } satisfies CaptureSceneResult;
    } finally {
      // 占用一直持到读回结束：读回是异步的，提前释放会让另一张截图挤进同一块显存。
      reservation.release();
    }
  });
}

function readSamples(app: unknown): number {
  const device = (app as { graphicsDevice?: { samples?: number } } | null)?.graphicsDevice;
  return device?.samples ?? 1;
}
