import type { CameraApplyOptions, CameraEntityHandle, PaneRegistryOptions } from "./paneRegistry";

/**
 * `PaneRegistry` 的**引擎绑定**：把注册表算出来的相机参数真正落到 PlayCanvas 实体上。
 *
 * 这一层刻意做得很薄——所有判断（rect 换算、清屏策略、layer 组合、优先级、增量同步）都在
 * `paneCamera.ts` / `paneRegistry.ts` 里并被单测覆盖；这里只有"调哪个 API"。
 *
 * ### 两条本机核实的引擎事实
 *  - **layer id 不用自己找**：`layer.js:87-90` 里不传 `id` 时 `this.id = layerCounter++`，
 *    传了显式 id 则把计数器推到它之后。默认层（0–4）是显式 id 建的，所以自动分配从 5 开始。
 *    本应用"layer 0 = 共享核心场景，1–4 = 各窗格 HUD"是**应用自己的概念**，
 *    与引擎默认层撞号，所以逐窗格 HUD 层必须新建。
 *  - **相机只认自己的 `layers`**：`CameraComponent.layers` 的 setter 会走
 *    `dirtyLayerCompositionCameras()` 正确增删。three 侧那套"两层 mask 都要给"在这里不存在。
 *
 * ⚠️ 本文件里对引擎 API 的调用**只在真实浏览器里才算验证过**。单测覆盖的是它上游的纯逻辑。
 */

export interface EnginePaneBindings extends PaneRegistryOptions {
  /** 供相机机位逻辑（轨道/聚焦）取到某个窗格的相机实体。 */
  entityFor(paneId: string): unknown;
  dispose(): void;
}

export interface EnginePaneOptions {
  /** 相机实体挂到哪。默认 `app.root`。 */
  root?: unknown;
  alpha?: number;
  background?: [number, number, number];
}

export async function createEnginePaneBindings(canvas: HTMLCanvasElement, app: unknown, options: EnginePaneOptions = {}): Promise<EnginePaneBindings> {
  const {
    Entity, Layer, Vec4, Color,
    PROJECTION_PERSPECTIVE, PROJECTION_ORTHOGRAPHIC,
  } = await import("playcanvas");

  const application = app as {
    root: { addChild(child: unknown): void };
    scene: { layers: { push(layer: unknown): void; remove(layer: unknown): void } };
  };
  // 显式标注：`options.root` 是 unknown，直接 ?? 会把类型塌成 {}。
  const root: { addChild(child: unknown): void } = (options.root as { addChild(child: unknown): void } | undefined) ?? application.root;
  const background = new Color(options.background?.[0] ?? 0.05, options.background?.[1] ?? 0.05, options.background?.[2] ?? 0.06);

  const entities = new Map<string, InstanceType<typeof Entity>>();
  const layers = new Map<number, InstanceType<typeof Layer>>();

  const bindings: EnginePaneBindings = {
    // 用**画布 CSS 尺寸**做分母：归一化之后 DPR 自然抵消（见 paneCamera.ts ③）。
    canvasSize: () => ({ width: canvas.clientWidth, height: canvas.clientHeight }),

    createCamera(paneId: string): CameraEntityHandle {
      const entity = new Entity(`pane-camera:${paneId}`);
      entity.addComponent("camera", { fov: 60, clearColor: background, priority: 0 });
      root.addChild(entity);
      entities.set(paneId, entity);
      // 只读一次并守住：`entity.camera` 在类型上可选，每帧重复判空会把热路径写脏。
      const camera = entity.camera;
      if (!camera) throw new Error(`camera component was not created for pane ${paneId}`);
      return {
        applyCamera(o: CameraApplyOptions) {
          // rect 是归一化、左下原点；**不要**在这里翻 y —— WebGPU 后端自己会翻。
          camera.rect = new Vec4(o.rect.x, o.rect.y, o.rect.z, o.rect.w);
          camera.layers = o.layers;
          camera.priority = o.priority;
          camera.clearColorBuffer = o.clearColorBuffer;
          camera.clearDepthBuffer = o.clearDepthBuffer;
          camera.projection = o.projection === "orthographic" ? PROJECTION_ORTHOGRAPHIC : PROJECTION_PERSPECTIVE;
          if (o.projection === "orthographic") camera.orthoHeight = o.orthoHeight;
          else camera.fov = o.fov;
        },
        destroy() {
          entities.delete(paneId);
          entity.destroy();
        },
      };
    },

    createPaneLayer(paneId: string): number {
      // 不传 id：让引擎的 layerCounter 分配一个空闲 id，避免与默认层 0–4 撞号。
      const layer = new Layer({ name: `pane-hud:${paneId}` });
      layers.set(layer.id, layer);
      application.scene.layers.push(layer);
      return layer.id;
    },

    removePaneLayer(layerId: number) {
      const layer = layers.get(layerId);
      if (!layer) return;
      layers.delete(layerId);
      application.scene.layers.remove(layer);
    },

    entityFor(paneId: string) {
      return entities.get(paneId) ?? null;
    },

    dispose() {
      for (const entity of entities.values()) entity.destroy();
      entities.clear();
      for (const layer of layers.values()) application.scene.layers.remove(layer);
      layers.clear();
    },
  };
  return bindings;
}
