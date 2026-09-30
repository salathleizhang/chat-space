import type { Vec3 } from "../../../shared/lib/cameraRig";
import type { SizeLike } from "./paneCamera";

/**
 * 窗格拾取：把「画布上的一个点」变成「那一格里的哪个物体」。
 *
 * ### 用引擎自带的 `Picker`，不要照抄 SuperSplat 的 `picker.ts`
 * `pc.Picker`（`framework/graphics/picker.js`）已经把 ID pass + 深度 pass 都做完了，
 * 而且在 WebGPU 上**自己就走 `texture.read(..., { immediate: true, renderTarget })`**
 * （`picker.js` 的 `_readTexture`）——正是本仓库反复强调的那条。SuperSplat 那份
 * `src/picker.ts` 是**专门给 splat 编辑**写的（`prepareId(splat, 'add'|'remove'|...)`、
 * `projectedSplatRenderer.preparePick`），通用选择用不上；它值得借的只有一条**坐标约定**：
 * 拾取缓冲的坐标是**画布归一化坐标 × 缓冲尺寸**（`picker.ts` 的 `readIds` 注释与
 * `Math.floor(x * rt.width)`），不是窗格局部坐标。
 *
 * ### 多窗格：一个 `Picker` 就够，但每次要按窗格重新 `prepare`
 * `prepare(camera, scene, layers)` 是**按相机**的：它按 camera 的 `rect` 调
 * `renderer.setupViewport`（`forward-renderer.js:511` → `renderer.js:187`），所以
 * 拾取缓冲里那一格的内容落在与真实帧**同一段归一化区域**，其余是白色（`Picker.prepare`
 * 把清屏色设为 `Color.WHITE`，`decodePixels` 把全 1 当"没命中"）。
 * 于是"画布归一化坐标 → 缓冲像素"这条映射与窗格大小、DPR、几宫格布局都无关。
 *
 * ### 三条静默失败
 * ① **`layers` 一定要显式只给共享核心层**。不传就用相机的**全部** layers，于是窗格 HUD 的
 *    坐标轴球、gizmo 手柄都会被拾取到（症状：点空白处也能选到东西、或选中 gizmo 的箭头）。
 * ② **splat 需要 `scene.gsplat.enableIds = true`**（默认 **false**，`gsplat-params.js:142`）。
 *    不开的话 `RenderPassPicker` 不会把 gsplat 放进 mapping，症状是"模型能选中、点云永远选不中"。
 * ③ **`Picker.prepare()` 是同步渲染一趟**（`RenderPass.render()` 自己 `startRenderPass`/`endRenderPass`），
 *    读回是异步的。所以**不要每帧、也不要每个 pointermove 都拾取**——一次点击一趟，
 *    悬停高亮要另想办法（降低分辨率或改用射线求交）。
 *
 * ⚠️ 本文件对引擎 API 的调用**只在真实浏览器里才算验证过**；单测覆盖的是坐标换算与结果归一化。
 */

/** 拾取结果。`entity` 是引擎实体，调用方按自己的命名规则映射到稳定 id（例如 `asset.id`）。 */
export interface PanePickResult {
  entity: unknown;
  kind: "mesh" | "gsplat";
  /** 实体名，仅用于诊断/日志。 */
  name: string;
  /** 世界 AABB（只在能算出来时给；splat 没有，为 undefined）。 */
  bounds?: { center: Vec3; halfExtents: Vec3 };
}

/** 拾取缓冲：引擎 `Picker` 与测试注入点都只要这几个成员。 */
export interface PickerLike {
  width: number;
  height: number;
  resize(width: number, height: number): void;
  prepare(camera: unknown, scene: unknown, layers?: unknown[]): void;
  getSelectionAsync(x: number, y: number, width?: number, height?: number): Promise<unknown[]>;
  destroy(): void;
}

/** 引擎返回的 `MeshInstance | GSplatComponent` 里我们真正要的那点信息。 */
interface MeshInstanceLike {
  node?: { name?: string; render?: { meshInstances?: unknown[] } };
  aabb?: { center: Vec3; halfExtents: Vec3 };
}
interface GSplatComponentLike {
  entity?: { name?: string };
  node?: { name?: string };
}

/**
 * 画布局部 CSS px → 拾取缓冲像素（左上原点，`Picker.getSelectionAsync` 的口径）。
 *
 * **归一化**是这条映射的关键：不管缓冲是多大、DPR 是多少，`x/画布宽` 就是同一个归一化位置
 * （引擎按相机 `rect` 把那一格画在缓冲的同一归一化区域里）。越界返回 null——把"点到了窗外"
 * 和"点在窗内但没物体"区分开。
 */
export function toPickPixel(
  point: { x: number; y: number },
  canvasCss: SizeLike,
  pickBuffer: SizeLike,
): { x: number; y: number } | null {
  if (canvasCss.width <= 0 || canvasCss.height <= 0) return null;
  if (pickBuffer.width <= 0 || pickBuffer.height <= 0) return null;
  if (!Number.isFinite(point.x) || !Number.isFinite(point.y)) return null;
  if (point.x < 0 || point.y < 0 || point.x >= canvasCss.width || point.y >= canvasCss.height) return null;
  return {
    x: Math.min(pickBuffer.width - 1, Math.floor((point.x / canvasCss.width) * pickBuffer.width)),
    y: Math.min(pickBuffer.height - 1, Math.floor((point.y / canvasCss.height) * pickBuffer.height)),
  };
}

/** 把引擎的拾取结果归一化成 `PanePickResult`。认不出来的返回 null（宁可漏，不可猜）。 */
export function describePickTarget(target: unknown): PanePickResult | null {
  if (!target || typeof target !== "object") return null;
  const asMesh = target as MeshInstanceLike;
  if (asMesh.node) {
    return { entity: asMesh.node, kind: "mesh", name: asMesh.node.name ?? "", bounds: meshBounds(asMesh) };
  }
  const asSplat = target as GSplatComponentLike;
  const entity = asSplat.entity ?? asSplat.node;
  if (entity) return { entity, kind: "gsplat", name: entity.name ?? "" };
  return null;
}

/** 多个结果里取第一个认得出来的（1×1 的拾取框通常只有一个 id）。 */
export function firstPickResult(selection: readonly unknown[]): PanePickResult | null {
  for (const candidate of selection) {
    const described = describePickTarget(candidate);
    if (described) return described;
  }
  return null;
}

/** `MeshInstance.aabb` 是**世界空间** AABB（`mesh-instance.js:218` 用 world transform 变换过）。 */
function meshBounds(instance: MeshInstanceLike): PanePickResult["bounds"] {
  const aabb = instance.aabb;
  if (!aabb?.center || !aabb.halfExtents) return undefined;
  return { center: [aabb.center[0], aabb.center[1], aabb.center[2]], halfExtents: [aabb.halfExtents[0], aabb.halfExtents[1], aabb.halfExtents[2]] };
}

/** 实体所有 mesh instance 的世界 AABB 并集。没有可算的（splat / 空实体）返回 undefined。 */
export function entityWorldBounds(entity: unknown): PanePickResult["bounds"] {
  const instances = (entity as { render?: { meshInstances?: MeshInstanceLike[] } } | null)?.render?.meshInstances ?? [];
  let min: Vec3 | null = null;
  let max: Vec3 | null = null;
  for (const instance of instances) {
    const bounds = meshBounds(instance);
    if (!bounds) continue;
    const lo: Vec3 = [
      bounds.center[0] - bounds.halfExtents[0],
      bounds.center[1] - bounds.halfExtents[1],
      bounds.center[2] - bounds.halfExtents[2],
    ];
    const hi: Vec3 = [
      bounds.center[0] + bounds.halfExtents[0],
      bounds.center[1] + bounds.halfExtents[1],
      bounds.center[2] + bounds.halfExtents[2],
    ];
    min = min ? [Math.min(min[0], lo[0]), Math.min(min[1], lo[1]), Math.min(min[2], lo[2])] : lo;
    max = max ? [Math.max(max[0], hi[0]), Math.max(max[1], hi[1]), Math.max(max[2], hi[2])] : hi;
  }
  if (!min || !max) return undefined;
  return {
    center: [(min[0] + max[0]) / 2, (min[1] + max[1]) / 2, (min[2] + max[2]) / 2],
    halfExtents: [(max[0] - min[0]) / 2, (max[1] - min[1]) / 2, (max[2] - min[2]) / 2],
  };
}

export interface CreatePanePickerOptions {
  /** 共享核心场景的 layer id。默认 `LAYERID_WORLD` = 0。**不要**把 HUD/gizmo 层算进来。 */
  worldLayerId?: number;
  /** 画布 CSS 尺寸（与 `paneCamera.ts` 同一份，归一化后 DPR 自然抵消）。 */
  canvasSize: () => SizeLike;
  /** 取某个窗格的相机组件（`entity.camera`）。返回 null 表示这一格现在拾取不了。 */
  cameraFor: (paneId: string) => { camera?: unknown } | null;
  /** 拾取缓冲相对画布 CSS 尺寸的倍率。默认 1（1 CSS px = 1 拾取像素）。 */
  resolution?: number;
  /** 测试注入点。 */
  createPicker?: (width: number, height: number) => PickerLike;
}

export interface PanePickerHandle {
  /** 在某个窗格的**画布局部 CSS px** 处拾取。没有命中返回 null。 */
  pick(paneId: string, point: { x: number; y: number }): Promise<PanePickResult | null>;
  /** 当前拾取缓冲尺寸（探针/诊断用）。还没建过时返回 0×0。 */
  bufferSize(): SizeLike;
  /** 释放拾取缓冲。**幂等**；之后 `pick()` 一律返回 null。设备重建后请新建一个实例。 */
  dispose(): void;
}

/**
 * 建一个按需拾取的句柄。**第一趟 `pick()` 才创建 `Picker`**（不拾取就不分配显存）。
 *
 * 并发调用会被串行化：`prepare()` 与读回共用同一块缓冲，两次并发会互相踩。
 */
export function createPanePicker(app: unknown, options: CreatePanePickerOptions): PanePickerHandle {
  const resolution = options.resolution ?? 1;
  let picker: PickerLike | null = null;
  let disposed = false;
  let queue: Promise<unknown> = Promise.resolve();

  const bufferFor = (): SizeLike => {
    const canvas = options.canvasSize();
    return {
      width: Math.max(1, Math.floor(canvas.width * resolution)),
      height: Math.max(1, Math.floor(canvas.height * resolution)),
    };
  };

  const ensurePicker = async (): Promise<PickerLike | null> => {
    if (disposed) return null;
    const wanted = bufferFor();
    if (picker) {
      if (picker.width !== wanted.width || picker.height !== wanted.height) picker.resize(wanted.width, wanted.height);
      return picker;
    }
    if (options.createPicker) {
      picker = options.createPicker(wanted.width, wanted.height);
      return picker;
    }
    const { Picker } = await import("playcanvas");
    picker = new Picker(app as never, wanted.width, wanted.height, false) as unknown as PickerLike;
    return picker;
  };

  const runPick = async (paneId: string, point: { x: number; y: number }): Promise<PanePickResult | null> => {
    const cameraComponent = options.cameraFor(paneId);
    if (!cameraComponent) return null;
    const instance = await ensurePicker();
    if (!instance || disposed) return null;
    const pixel = toPickPixel(point, options.canvasSize(), instance);
    if (!pixel) return null;
    const application = app as {
      scene: { layers: { getLayerById(id: number): unknown }; gsplat?: unknown };
    };
    const worldLayer = application.scene.layers.getLayerById(options.worldLayerId ?? 0);
    // 只给共享核心层：HUD 的坐标轴球与 gizmo 手柄不该被拾取到
    instance.prepare(cameraComponent.camera, application.scene, worldLayer ? [worldLayer] : undefined);
    const selection = await instance.getSelectionAsync(pixel.x, pixel.y, 1, 1);
    return firstPickResult(selection);
  };

  return {
    pick(paneId, point) {
      // 串行化：同一块缓冲不能两个 prepare/read 叠在一起
      const next = queue.then(() => runPick(paneId, point), () => runPick(paneId, point));
      queue = next.catch(() => undefined);
      return next;
    },
    bufferSize: () => (picker ? { width: picker.width, height: picker.height } : { width: 0, height: 0 }),
    dispose() {
      disposed = true;
      picker?.destroy();
      picker = null;
    },
  };
}
