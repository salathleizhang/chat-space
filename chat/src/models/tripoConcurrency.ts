/**
 * Tripo 的**并发限制**（官方文档：Rate Limits & Concurrency，
 * https://developers.tripo3d.ai/zh/docs/rate-limits）。
 *
 * 与「速率限制」是两件事：速率限制按 **API Key** 数单位时间的请求数（超限 code 1007），
 * 并发限制按**账户 + 任务类目**数同时跑的任务数（超限 code 2000）。本模块只管后者。
 *
 * 官方默认额度（2026-10-01 核对）：
 *
 * | 类目 | 默认并发 |
 * | --- | --- |
 * | 3D 生成 — H 系列（`v3.x` / `v2.5`） | 10 |
 * | 3D 生成 — P 系列（`P1-*` / `P2-*`） | 5 |
 * | 图像生成（含 image-to-multiview） | 1 |
 * | 模型后处理（贴图/格式转换/精修） | 5 |
 * | 网格操作（分割/补全/重拓扑） | 10 |
 * | 动画（绑骨/检查/重定向） | 10 |
 *
 * 这组数字是**实证过的**，不是从文档抄来就算数：2026-09-30 的 10 个 `v3.1-*`（H 系列）
 * 同一毫秒齐发 10/10 全成功；2026-10-01 的 16 个 `P2-*`（P 系列）同一毫秒齐发**恰好 5 个**
 * 成功、其余 11 个 code 2000。也就是说「塞满就会撞」，必须在提交端排队。
 *
 * 并发是**账户级**的：同一把 key 在别的进程/别的机器上跑的任务也占池子。本闸门只约束
 * 本进程，撞上别的占用者时靠 `runTripoTask` 的 429 重排兜底（见 tripo.ts）。
 */

/** 类目 → 并发上限。`other` 是官方表里没列（如 `/models/import`）的端点，取表内最大值。 */
export const TRIPO_CONCURRENCY_LIMITS = {
  "generation-h": 10,
  "generation-p": 5,
  "image-generation": 1,
  "model-processing": 5,
  "mesh-operations": 10,
  animation: 10,
  other: 10,
} as const;

export type TripoTaskCategory = keyof typeof TRIPO_CONCURRENCY_LIMITS;

const GENERATION_PATHS = new Set([
  "/generation/text-to-model",
  "/generation/image-to-model",
  "/generation/multiview-to-model",
]);

const IMAGE_GENERATION_PATHS = new Set([
  "/generation/text-to-image",
  "/generation/image-to-image",
  "/generation/image-to-multiview",
  "/generation/edit-multiview",
]);

const MODEL_PROCESSING_PATHS = new Set([
  "/models/texture",
  "/models/convert",
  "/models/refine",
]);

const MESH_OPERATION_PATHS = new Set([
  "/mesh/segment",
  "/mesh/complete",
  "/mesh/decimate",
]);

const ANIMATION_PATHS = new Set([
  "/animations/rig-check",
  "/animations/rig",
  "/animations/retarget",
]);

/**
 * P 系列判定：`P1-20260311` / `P2-20260801` / 别名 `tripo-p1` 都算 P 系列；
 * `v3.1-20260211`、`tripo-v3.1`、`v2.5-*` 都是 H 系列。P 与 H 的池子是分开的，
 * 混判会让 P 系列（只有 5 个槽）拿到 H 的 10 个额度，白撞 429。
 */
export function isTripoPSeriesModel(model: unknown): boolean {
  return typeof model === "string" && /^(?:tripo-)?p\d/i.test(model.trim());
}

/** 由端点 + 请求体判定类目；未知端点落到 `other`。 */
export function tripoCategoryFor(
  path: string,
  body?: Record<string, unknown> | undefined,
): TripoTaskCategory {
  if (GENERATION_PATHS.has(path)) {
    return isTripoPSeriesModel(body?.model) ? "generation-p" : "generation-h";
  }
  if (IMAGE_GENERATION_PATHS.has(path)) return "image-generation";
  if (MODEL_PROCESSING_PATHS.has(path)) return "model-processing";
  if (MESH_OPERATION_PATHS.has(path)) return "mesh-operations";
  if (ANIMATION_PATHS.has(path)) return "animation";
  return "other";
}

type Release = () => void;

/**
 * 按类目的计数闸门，先进先出。
 *
 * 为什么必须 FIFO：一批 16 个对象同时进队，如果后进先出或用轮询试探，
 * 已经等了几分钟的任务会被无限推后（饿死），而先到的先跑才符合用户直觉。
 *
 * 必须在**整个任务生命周期**里持槽（提交 → 轮询到终态），不能只包住提交：
 * 并发数数的是 Tripo 侧"正在跑"的任务，提交完就放槽等于没限。
 */
export class TripoCategoryGate {
  private readonly active = new Map<TripoTaskCategory, number>();
  private readonly waiting = new Map<TripoTaskCategory, Array<() => void>>();

  constructor(
    private readonly limits: Partial<Readonly<Record<TripoTaskCategory, number>>> = TRIPO_CONCURRENCY_LIMITS,
  ) {}

  limitOf(category: TripoTaskCategory): number {
    return this.limits[category] ?? TRIPO_CONCURRENCY_LIMITS[category] ?? TRIPO_CONCURRENCY_LIMITS.other;
  }

  activeCount(category: TripoTaskCategory): number {
    return this.active.get(category) ?? 0;
  }

  queuedCount(category: TripoTaskCategory): number {
    return this.waiting.get(category)?.length ?? 0;
  }

  /** 取一个槽；满了就排队（先到先得）。resolve 出来的 release 只能生效一次。 */
  acquire(category: TripoTaskCategory): Promise<Release> {
    const running = this.activeCount(category);
    if (running < this.limitOf(category)) {
      this.active.set(category, running + 1);
      return Promise.resolve(this.makeRelease(category));
    }
    return new Promise<Release>((resolve) => {
      const queue = this.waiting.get(category) ?? [];
      queue.push(() => {
        this.active.set(category, this.activeCount(category) + 1);
        resolve(this.makeRelease(category));
      });
      this.waiting.set(category, queue);
    });
  }

  private makeRelease(category: TripoTaskCategory): Release {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.active.set(category, Math.max(0, this.activeCount(category) - 1));
      const queue = this.waiting.get(category);
      const next = queue?.shift();
      if (queue && queue.length === 0) this.waiting.delete(category);
      next?.();
    };
  }

  /** 测试用：清空计数与队列。生产代码不要调用。 */
  reset(): void {
    this.active.clear();
    this.waiting.clear();
  }
}

/**
 * 进程级单例：并发是账户级的，同一个 chat 服务里所有 Tripo 任务共用一本账。
 * （多进程部署时每个进程各有一本，超出部分靠 429 重排收口。）
 */
export const tripoGate = new TripoCategoryGate();
