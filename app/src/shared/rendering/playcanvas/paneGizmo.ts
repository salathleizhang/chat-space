import { TRANSFORM_MODES, type TransformMode, type TransformSpace } from "../../../widgets/Viewport/transformMode";

/**
 * 每窗格的**变换 gizmo**：用引擎自带的 `TranslateGizmo` / `RotateGizmo` / `ScaleGizmo`
 * （`extras/gizmo`），不自研。这一层只回答"谁在拖、挂在哪个实体上、层怎么办"。
 *
 * ### 为什么可以用自带的（本机核实过源码，见 `PLAYCANVAS_MIGRATION.md` §三之七）
 * - **逐窗格是结构上支持的**：`new TranslateGizmo(cameraComponent, layer, name)` 会把 layer 加进
 *   **那一台**相机的 `layers`（`gizmo.js:60`），而手柄的射线用 `camera.screenToWorld()`——它按相机
 *   的 `rect` 换算（`camera.js:538-541`：`(x - rx*cw) / (rw*cw)`）。所以指针在别格时，本格 gizmo
 *   算出的 NDC 落在 [0,1] 之外，命中必然失败。**多窗格各建一个即可，不需要自己接事件。**
 * - 三种模式是三个独立实例、各有 `attach(nodes)` / `detach()` / `coordSpace` / `snap`，
 *   与 three 侧的 `TransformControls` 一一对应。
 *
 * ### 四条静默失败（照抄这段时最容易漏）
 * ① **`Gizmo.destroy()` 不删层**（`gizmo.js` 的 `destroy()` 只摘监听、`root.destroy()`），
 *    而 `Gizmo.createLayer()` 把层 `insert` 进了 `scene.layers`。不自己 `removeLayer` 就是
 *    **每格每轮泄漏一个层**（4 窗格 × 反复挂载 = 层越积越多，引擎每帧都要遍历它们）。
 * ② **`PaneRegistry.sync()` 每次都会重写 `camera.layers`**（`enginePanes.applyCamera` 里
 *    `camera.layers = o.layers`）。而 gizmo 是在构造时把层 concat 进相机的——下一次 sync 就把它
 *    抹掉，症状是**手柄突然不画了、零报错**。所以 gizmo 层必须通过 `PaneSpec.extraLayerIds`
 *    进注册表（`layerIdFor()` 就是给这里用的），让相机 layers 始终由**一个地方**写。
 * ③ 手柄拖动期间**必须让输入层把指针手势让出去**（否则同时轨道旋转）。本模块暴露
 *    `dragging(paneId)`，挂到 `PaneInputHost.isPointerClaimed` 上；信号来自引擎自己的
 *    `transform:start` / `transform:end`（`transform-gizmo.js:65-110`），不靠猜。
 * ④ 手柄**只在 `nodes.length > 0` 时才 enabled**（`gizmo.js:77-83`）。挂空实体等于没挂，
 *    而且不会报错——`attach(null)` 就是 detach，这是有意的。
 *
 * ### 与 three 侧的两处**有意**差异（记在这里免得被当成 bug）
 * - 本层把 gizmo 直接挂到**实体**上（引擎自己改这个实体的 transform）。three 侧挂的是一个
 *   不参与渲染的 pivot，再把 pivot 的相对矩阵分发给多个成员——**多选整体变换**要用那套
 *   （pivot = 各成员位置的包围盒中心 + 单位姿态）。多选那部分属于集成层，不在本模块。
 * - 引擎的吸附默认可用（`snapIncrement`），但本模块显式 `snap = false`：three 侧没有传任何
 *   `translationSnap` / `rotationSnap` / `scaleSnap`，手感要一致。
 */

/** gizmo 实例的最小接口：引擎三种 gizmo 都满足。 */
export interface GizmoLike {
  attach(nodes: unknown[] | unknown): void;
  detach(): void;
  destroy(): void;
  on(event: string, callback: (...args: unknown[]) => void): void;
  coordSpace: string;
  snap: boolean;
  enabled: boolean;
}

/** 一层 + 它的 id（引擎侧 `Gizmo.createLayer` 返回 `Layer`，`id` 是自动分配的 ≥5）。 */
export interface GizmoLayer {
  id: number;
  layer: unknown;
}

export interface PaneGizmoOptions {
  /**
   * 建一层并返回它。引擎侧用 `Gizmo.createLayer(app, name)`：它已经带
   * `clearDepthBuffer: true`（手柄永远画在世界之上）与 `SORTMODE_NONE`。
   */
  createLayer: (paneId: string) => GizmoLayer;
  /** 删掉这一层。**必须自己做**——`Gizmo.destroy()` 不管层（见文件头 ①）。 */
  removeLayer: (layer: GizmoLayer) => void;
  /** 该窗格的相机组件（`entity.camera`）。没有就建不了 gizmo。 */
  cameraFor: (paneId: string) => unknown | null;
  /** 三种模式的工厂。测试注入点。 */
  createGizmos?: (camera: unknown, layer: GizmoLayer, paneId: string) => Record<TransformMode, GizmoLike>;
  /** 手柄拖动开始 / 结束（输入层据此让出或收回指针手势）。 */
  onDragStart?: (paneId: string) => void;
  onDragEnd?: (paneId: string) => void;
}

export interface PaneGizmoHandle {
  /** 该窗格的 gizmo 层 id——**交给 `PaneSpec.extraLayerIds`**，否则下次 sync 会覆盖 camera.layers。 */
  layerIdFor(paneId: string): number | null;
  setMode(paneId: string, mode: TransformMode): void;
  modeFor(paneId: string): TransformMode | null;
  setSpace(paneId: string, space: TransformSpace): void;
  spaceFor(paneId: string): TransformSpace | null;
  /** 挂到实体（三种模式共用同一个挂点）。传 null = 摘掉。 */
  attach(paneId: string, entity: unknown | null): void;
  attachedEntity(paneId: string): unknown | null;
  /** 该窗格是否正在拖手柄。 */
  dragging(paneId: string): boolean;
  /** 探针/测试用：取某个模式的实例。 */
  gizmoFor(paneId: string, mode: TransformMode): GizmoLike | null;
  dispose(): void;
}

interface PaneEntry {
  layer: GizmoLayer;
  gizmos: Record<TransformMode, GizmoLike>;
  mode: TransformMode;
  space: TransformSpace;
  entity: unknown | null;
  dragging: boolean;
}

/**
 * 建一个逐窗格的 gizmo 宿主。**层与三种 gizmo 都是在第一次用到某一格时才建**（不挂就不分配）。
 */
export async function createPaneGizmos(options: PaneGizmoOptions): Promise<PaneGizmoHandle> {
  let createGizmos = options.createGizmos;
  if (!createGizmos) {
    const { TranslateGizmo, RotateGizmo, ScaleGizmo } = await import("playcanvas");
    // 引擎的三种 gizmo 构造签名都是 `(cameraComponent, layer)`，名字由基类固定
    // （`translate-gizmo.js:78` 的 `super(camera, layer, "gizmo:translate")`）。
    createGizmos = (camera, layer) => ({
      translate: new TranslateGizmo(camera as never, layer.layer as never) as unknown as GizmoLike,
      rotate: new RotateGizmo(camera as never, layer.layer as never) as unknown as GizmoLike,
      scale: new ScaleGizmo(camera as never, layer.layer as never) as unknown as GizmoLike,
    });
  }

  const entries = new Map<string, PaneEntry>();
  let disposed = false;

  const ensure = (paneId: string): PaneEntry | null => {
    if (disposed) return null;
    const existing = entries.get(paneId);
    if (existing) return existing;
    const camera = options.cameraFor(paneId);
    if (!camera) return null; // 相机还没建好：这一帧挂不上，等下一次
    const layer = options.createLayer(paneId);
    const gizmos = createGizmos!(camera, layer, paneId);
    const entry: PaneEntry = { layer, gizmos, mode: "translate", space: "world", entity: null, dragging: false };
    for (const mode of TRANSFORM_MODES) {
      const gizmo = gizmos[mode];
      // 与 three 侧一致：没有吸附（那边三个 snap 都是 null）
      gizmo.snap = false;
      gizmo.coordSpace = entry.space;
      // 拖动开始/结束用引擎自己的事件，不猜；这就是输入层"让手势"的信号源
      gizmo.on("transform:start", () => {
        entry.dragging = true;
        options.onDragStart?.(paneId);
      });
      gizmo.on("transform:end", () => {
        entry.dragging = false;
        options.onDragEnd?.(paneId);
      });
    }
    entries.set(paneId, entry);
    return entry;
  };

  const applyMode = (entry: PaneEntry, mode: TransformMode) => {
    if (entry.mode === mode) return;
    // 三种模式是三个独立实例：换模式要把旧的摘掉，否则旧手柄还留在场景里（视觉上两套手柄叠着）
    entry.gizmos[entry.mode].detach();
    entry.mode = mode;
    const active = entry.gizmos[mode];
    active.coordSpace = entry.space;
    if (entry.entity) active.attach([entry.entity]);
  };

  const handle: PaneGizmoHandle = {
    layerIdFor: (paneId) => entries.get(paneId)?.layer.id ?? null,

    setMode(paneId, mode) {
      const entry = ensure(paneId);
      if (!entry) return;
      applyMode(entry, mode);
    },
    modeFor: (paneId) => entries.get(paneId)?.mode ?? null,

    setSpace(paneId, space) {
      const entry = ensure(paneId);
      if (!entry) return;
      entry.space = space;
      entry.gizmos[entry.mode].coordSpace = space;
    },
    spaceFor: (paneId) => entries.get(paneId)?.space ?? null,

    attach(paneId, entity) {
      const entry = ensure(paneId);
      if (!entry) return;
      entry.entity = entity;
      const active = entry.gizmos[entry.mode];
      if (entity) active.attach([entity]);
      else active.detach();
    },
    attachedEntity: (paneId) => entries.get(paneId)?.entity ?? null,

    dragging: (paneId) => entries.get(paneId)?.dragging ?? false,

    gizmoFor: (paneId, mode) => entries.get(paneId)?.gizmos[mode] ?? null,

    dispose() {
      disposed = true;
      for (const entry of entries.values()) {
        for (const mode of TRANSFORM_MODES) entry.gizmos[mode].destroy();
        // ① 引擎不会删层，必须自己删；否则每轮泄漏一层
        options.removeLayer(entry.layer);
      }
      entries.clear();
    },
  };
  return handle;
}
