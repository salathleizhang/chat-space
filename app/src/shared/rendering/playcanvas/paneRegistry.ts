import { paneClearFlags, panePriority, toCameraRect, type CameraRect, type PixelViewport, type SizeLike } from "./paneCamera";

/**
 * 窗格注册表：把"这一帧要哪几个窗格"增量同步成引擎里的相机实体。
 *
 * 为什么单独成一层：**增量同步**（按 id 保持身份、只建缺的、只销毁多余的）恰恰是 bug 藏身处——
 * StrictMode 的两次挂载、1→2→4 布局切换、窗格拖动改尺寸，都会反复走这条路。把它做成纯逻辑
 * （引擎调用留在注入的工厂后面）才能单测。
 *
 * ### layer 方案：**必须新建，不能复用 id 0–4**
 * 本应用的概念是"layer 0 = 共享核心场景，layer 1–4 = 各窗格自己的 HUD（gizmo、坐标轴球）",
 * 相机只看得见"核心 + 自己那层"。但 PlayCanvas 默认 layer 的 id **就是** 0–4
 * （`World=0 / Depth=1 / Skybox=2 / Immediate=3 / UI=4`），直接映射会撞号并踩到引擎内部层。
 * 所以逐窗格 HUD 层要由 `createPaneLayer()` **新建**拿一个空闲 id，共享核心场景沿用
 * `worldLayerId()`（默认 0）。
 *
 * ### 顺带消失的一个坑
 * three 侧这里有个两层过滤的陷阱：`Renderer._projectObject` 用 **ArrayCamera 自己的 mask** 先筛一次，
 *  `WebGPUBackend.renderObject` 再用**子相机的 mask** 筛一次，两层都要给（当时踩过"四个坐标轴球
 * 一个都不画"）。PlayCanvas 是"每个相机一个 `layers` 列表"，**只有一层**，所以这里只算每相机一份。
 */

/** 一个窗格要画成什么样。除 `id` 与 `viewport` 外都有默认值，调用方只填变化的部分。 */
export interface PaneSpec {
  /** 稳定身份。跨帧复用同一个相机实体，不要用下标当 id。 */
  id: string;
  /** 相对画布左上角的 CSS px（`viewRect()` 的输出）。 */
  viewport: PixelViewport;
  /** 该窗格 HUD 自己的 layer id；不传则由注册表分配。核心场景层由 `worldLayerId()` 给出。 */
  hudLayerId?: number;
  /**
   * 这一格相机额外要看得见的层（例如**变换 gizmo** 的层）。
   *
   * 为什么要走这里而不是让 gizmo 自己 `camera.layers.concat(...)`：`sync()` 每次都重写
   * `camera.layers`，外部 concat 进去的层下一次同步就被抹掉，症状是手柄突然不画、零报错。
   * 相机 layers 只能有**一个**写入点，所以额外层也在这里声明。
   */
  extraLayerIds?: readonly number[];
  projection?: "perspective" | "orthographic";
  fov?: number;
  /** 竖向视场角之外的正交范围；正交窗格用。 */
  orthoHeight?: number;
  /** 颜色是否逐格清。默认 true；**无论如何深度都逐格清**（见 paneCamera.ts ④）。 */
  clearColorPerPane?: boolean;
}

/** 交给引擎的那份相机参数。工厂负责把它落到 `CameraComponent` / `Camera` 上。 */
export interface CameraApplyOptions {
  rect: CameraRect;
  layers: number[];
  priority: number;
  clearColorBuffer: boolean;
  clearDepthBuffer: boolean;
  projection: "perspective" | "orthographic";
  fov: number;
  orthoHeight: number;
}

export interface CameraEntityHandle {
  applyCamera(options: CameraApplyOptions): void;
  destroy(): void;
}

export interface PaneRegistryOptions {
  createCamera: (paneId: string) => CameraEntityHandle;
  /** 新建一个 HUD layer 并返回它的 id。注意：不要复用 0–4。 */
  createPaneLayer: (paneId: string) => number;
  /** 共享核心场景所在的 layer id。默认 `LAYERID_WORLD`（0）。 */
  worldLayerId?: () => number;
  removePaneLayer?: (layerId: number) => void;
  canvasSize: () => SizeLike;
}

interface Entry {
  handle: CameraEntityHandle;
  layerId: number;
  ownsLayer: boolean;
}

/**
 * 相机可见的层：共享核心 + 自己那层 + 额外层（gizmo 等）。**去重**且顺序稳定，便于比较。
 * 相机 `layers` 里出现重复 id 会让同一层被画两遍，所以这里一定去重。
 */
export function cameraLayers(worldLayerId: number, hudLayerId: number, extraLayerIds: readonly number[] = []): number[] {
  return [...new Set([worldLayerId, hudLayerId, ...extraLayerIds])].sort((a, b) => a - b);
}

export class PaneRegistry {
  private entries = new Map<string, Entry>();
  private readonly worldLayerId: () => number;

  constructor(private readonly options: PaneRegistryOptions) {
    this.worldLayerId = options.worldLayerId ?? (() => 0);
  }

  get size(): number {
    return this.entries.size;
  }

  ids(): string[] {
    return [...this.entries.keys()];
  }

  /**
   * 把注册表同步成恰好这批窗格。返回本帧各窗格的 `camera.rect`，顺序与入参一致。
   * 尺寸为 0 的窗格会被跳过（首帧、隐藏的分页都会给出 0 尺寸）。
   */
  sync(panes: readonly PaneSpec[]): CameraRect[] {
    const seen = new Set<string>();
    const canvas = this.options.canvasSize();
    const rects: CameraRect[] = [];

    for (const [index, pane] of panes.entries()) {
      if (seen.has(pane.id)) continue; // 同一批里出现重名：只认第一个，避免建两个实体
      seen.add(pane.id);

      const rect = toCameraRect(pane.viewport, canvas);
      if (rect.z <= 0 || rect.w <= 0) continue; // 还没量到尺寸：这一帧不画，也不建实体

      const entry = this.ensure(pane);
      entry.handle.applyCamera({
        rect,
        layers: cameraLayers(this.worldLayerId(), entry.layerId, pane.extraLayerIds),
        priority: panePriority(index),
        ...paneClearFlags(index, { clearColorPerPane: pane.clearColorPerPane }),
        projection: pane.projection ?? "perspective",
        fov: pane.fov ?? 60,
        orthoHeight: pane.orthoHeight ?? pane.viewport.height,
      });
      rects.push(rect);
    }

    // 销毁这一帧不再出现的窗格（含它自己那层 HUD layer）
    for (const [id, entry] of [...this.entries]) {
      if (seen.has(id)) continue;
      this.entries.delete(id);
      entry.handle.destroy();
      if (entry.ownsLayer) this.options.removePaneLayer?.(entry.layerId);
    }
    return rects;
  }

  /** 释放全部窗格。幂等。 */
  dispose(): void {
    for (const entry of this.entries.values()) {
      entry.handle.destroy();
      if (entry.ownsLayer) this.options.removePaneLayer?.(entry.layerId);
    }
    this.entries.clear();
  }

  private ensure(pane: PaneSpec): Entry {
    const existing = this.entries.get(pane.id);
    if (existing) return existing;
    const ownsLayer = pane.hudLayerId === undefined;
    const layerId = pane.hudLayerId ?? this.options.createPaneLayer(pane.id);
    const entry: Entry = { handle: this.options.createCamera(pane.id), layerId, ownsLayer };
    this.entries.set(pane.id, entry);
    return entry;
  }
}
