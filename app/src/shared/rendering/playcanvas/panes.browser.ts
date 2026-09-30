import { fitDistance, type CameraRig, type Vec3 } from "../../../shared/lib/cameraRig";
import { createPlayCanvasApp } from "./app";
import { registerSplatParsers } from "./splat";
import type { PcEntityLike } from "./modelTextures";
import { createWebGPUDevice, readAdapterIdentity } from "./device";
import { createEnginePaneBindings } from "./enginePanes";
import { PaneRegistry, type PaneSpec } from "./paneRegistry";
import { applyRig, type RigEntityLike } from "./cameraRig";
import { attachPanePointerInput, type PaneInputSpec, type PanePointerInputHandle } from "./paneInput";
import { createPanePicker, type PanePickerHandle } from "./panePicking";
import { createPaneGizmos, type PaneGizmoHandle } from "./paneGizmo";

/**
 * Phase 2 的**真实浏览器探针**：把新的渲染层（WebGPU-only 设备 → 应用 → 窗格注册表）装起来，
 * 用一张画布画 N 个窗格，并取回可核对的读数。
 *
 * 与 `app/src/shared/rendering/*.browser.ts` 是同一类东西：**不进生产包**，
 * 只由 `app/pc-panes.html`（dev 入口）引用。跑法见 `PLAYCANVAS_MIGRATION.md` §三之三。
 *
 * 报告要能回答三个问题：
 *  ① 每个窗格是不是**都真的画出了东西**（逐格像素校验，只看全画布会漏）
 *  ② 4 个窗格是不是合并成 **1 个 GPU render pass**（直接数 `startRenderPass`）
 *  ③ 帧间隔随窗格数怎么变（裸栈读数，只作方向性信号）
 */

export interface PaneHarnessResult {
  ok: boolean;
  panes: number;
  errors: string[];
  steps: string[];
  device?: { constructorName: string; isWebGPU: boolean; isWebGL2: boolean; samples: number };
  adapter?: ReturnType<typeof readAdapterIdentity>;
  layerIds?: number[];
  rects?: { x: number; y: number; z: number; w: number }[];
  gpuRenderPasses?: { start: number; end: number };
  drawCalls?: number;
  panePixels?: { meanLuma: number | null; nonBackgroundFraction: number; outOfBounds?: boolean }[];
  frameMs?: { p50: number; min: number; max: number };
  motion?: boolean;
  capture?: {
    width: number; height: number; bytes: number;
    meanLuma: number; nonBackgroundFraction: number; opaqueFraction: number;
    /** 走准入层（队列 + 预算）时的读数 */
    queuedMs?: number; degraded?: boolean; size?: number;
  };
  inspection?: {
    /** 每格的特征：亮度 + 极简哈希。四格不同即说明相机真的摆到了四个视角。 */
    tiles: { label: string; meanLuma: number; hash: number; nonBackground: number }[];
    uniqueHashes: number;
    pngBase64Length: number;
  };
  rigCheck?: { azimuthDegrees: number; meanLuma: number; hash: number }[];
  /**
   * 指针输入自检（`input=1`）：在真实浏览器里走**真实的 DOM 事件路径**（命中测试 → 手势路由 →
   * 台架 → applyRig → 引擎实体）。合成事件不是可信事件，所以另有一条 CDP 真实事件的复测，
   * 见 `PLAYCANVAS_MIGRATION.md` §三之六。
   */
  input?: {
    /** 各步受理的窗格（证明事件落到了正确的那一格）。 */
    routed: (string | null)[];
    orbit?: { azimuth: number; distance: number; camera: [number, number, number] | null };
    wheel?: { distance: number };
    pan?: { target: Vec3; distance: number };
    focus?: { target: Vec3; distance: number; expectedDistance: number };
    /** 没被操作的窗格是否**一动都没动**（多窗格各自输入的核心断言）。 */
    untouched: { paneId: string; moved: boolean }[];
    /** 在画布外抬手后手势是否真的收掉了（不收手 = 后面每次移动都在转视角）。 */
    gestureReleased: boolean;
    /** 输入之后窗格 0 的画面像素签名是否变了（证明台架真的驱动了渲染，不只是改了状态）。 */
    pixelChanged: boolean;
    ok: boolean;
  };
  /**
   * 画布上的兼容鼠标事件计数。**只有 CDP 复测（`inputHoldMs`）的读数是有效的**——
   * 页面内 `dispatchEvent` 的合成指针事件不会让浏览器生成 click/dblclick。
   */
  compatEvents?: Record<string, number>;
  interactionCount?: number;
  /**
   * 拾取自检（`picking=1`）：用**引擎自己的投影**把靶子盒子投到屏幕上再拾取，
   * 必须命中靶子；每个窗格再取一个"离画布中心最远的窗格角"作阴性对照，必须落空。
   */
  picking?: {
    buffer: { width: number; height: number };
    aimed: { paneId: string; point: { x: number; y: number }; name: string | null; kind: string | null }[];
    empty: { paneId: string; point: { x: number; y: number }; name: string | null }[];
    /** 拾取不得改变相机台架（它是只读查询） */
    rigUnchanged: boolean;
    ok: boolean;
  };
  /**
   * 变换 gizmo 自检（`gizmo=1`）：手柄只画在**自己那一格**（对比挂上/摘掉的逐格像素签名），
   * 且 gizmo 层确实进了那一格相机的 layers。
   */
  gizmo?: {
    mode: string | null;
    space: string | null;
    /** gizmo 层 id 是否在 pane-0 相机的 layers 里（不在就会被下次 sync 抹掉、手柄静默消失） */
    layerInCamera: boolean;
    /** 挂上 / 摘掉手柄时各格的像素签名 */
    withGizmo: number[];
    withoutGizmo: number[];
    ownPaneChanged: boolean;
    otherPanesUnchanged: boolean;
    /** gizmo 挂上期间每帧的 GPU render pass 数（`gizmo=1` 时帧循环就带着手柄跑） */
    passesPerFrame: number;
    ok: boolean;
  };
  model?: {
    /** 生产者在真实模型上找到了什么 */
    textureEntries?: { id: string; label: string; materials: string[]; width: number; height: number; hasThumb: boolean }[];
    supportedSlots?: string[];
    /** 引擎侧的原始字段名诊断——窄接口的字段名只能在这里被确认 */
    diagnostics?: { entitiesWithRender: number; meshInstanceCount: number; materials: number; sampleMaterialProps: string[] };
    /** 贴图结构转储：`getSource()` 返回的 level 到底把图像放在哪个字段（只能实测）。 */
    textureShape?: Record<string, unknown>;
    /** 原始结构转储：窄接口的字段名只能在这里被确认。 */
    raw?: { rootKeys: string[]; hasRender: boolean; renderKeys: string[]; childCount: number; firstChildKeys: string[] };
  };
  numSplats?: number | null;
  loadMs?: number;
  assetEvents?: string[];
  frameCount?: number;
  renderedSomething?: boolean;
  elapsedMs?: number;
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
};

export interface PaneHarnessOptions {
  panes: number;
  frames?: number;
  /** 真实 splat 资产的绝对 URL（跨源，走探针的 CORS 静态服务）。给了就渲染它而不是占位盒子。 */
  asset?: string;
  /**
   * 持续环绕相机。这是**病 1 的对照条件**：three/GSL 栈在拖动时 P50 从 16.7 恶化到 100–150ms
   * （根因是 GSL 1.1.5 在原生 WebGPU 路径上每帧绘制前**同步排序**）。
   * 机位在引擎的 `update` 事件里改，保证发生在渲染之前。
   */
  motion?: boolean;
  /** 真实 GLB 的绝对 URL。给了就加载它，并**验证 PlayCanvas 侧的"模型描述"生产者**在真实模型上的行为。 */
  glb?: string;
  /** 跑一次离屏截图并报告读数。 */
  capture?: boolean;
  /** 跑一次四视角检查图，并报告每格的像素签名（四格应当互不相同）。 */
  inspection?: boolean;
  /** 验证相机台架：同一场景两个方位角拍到的画面必须不同。 */
  rig?: boolean;
  /** 跑一遍指针输入自检（轨道/滚轮/平移/双击 + 多窗格隔离），走真实 DOM 事件路径。 */
  input?: boolean;
  /**
   * 挂上输入监听后**保持存活**这么久（ms），好让 CDP 派发**可信**鼠标事件来复测；
   * 期间把读数挂到 `window.__PC_INPUT__`（`rects()` / `rig(id)` / `camera(id)` / `active()`）。
   */
  inputHoldMs?: number;
  /** 跑一遍拾取自检（`input=1` 时点击也会自动拾取——拾取挂在 `onClick` 上）。 */
  picking?: boolean;
  /** 给 pane-0 挂上变换 gizmo（translate），并做逐格隔离自检；CDP 那条还会真拖手柄。 */
  gizmo?: boolean;
}

export async function runPaneHarness(canvas: HTMLCanvasElement, options: PaneHarnessOptions): Promise<PaneHarnessResult> {
  const started = performance.now();
  const result: PaneHarnessResult = { ok: false, panes: options.panes, motion: options.motion ?? false, errors: [], steps: [] };
  const log = (message: string) => result.steps.push(`+${Math.round(performance.now() - started)}ms ${message}`);

  try {
    const device = await createWebGPUDevice(canvas);
    result.device = {
      constructorName: device.constructor.name,
      isWebGPU: device.isWebGPU,
      isWebGL2: device.isWebGL2,
      samples: device.samples,
    };
    result.adapter = readAdapterIdentity(device);
    if (!device.isWebGPU) throw new Error("device 不是 WebGPU —— 出现了回退");
    log(`device: ${result.device.constructorName} isWebGPU=${device.isWebGPU} samples=${device.samples}`);

    const handle = await createPlayCanvasApp(canvas, device);
    const app = handle.app as unknown as {
      root: { addChild(child: unknown): void };
      scene: { layers: { layerList: { id: number; name: string }[] } };
      stats?: { drawCalls?: { total?: number } };
      assets: unknown;
      start(): void;
      destroy(): void;
      on(event: string, handler: () => void): void;
    };

    // 一个能被每个窗格看见的简单场景：几个不同高度的盒子 + 平行光。
    // 给了 asset 时改成加载真实 splat（合成对照在这里**没有意义**——本仓库已实测
    // "合成云 0.26ms vs 真实 SPZ 20.97ms，差 80 倍"）。
    const { Entity, Color, StandardMaterial, Gizmo, PROJECTION_PERSPECTIVE, PROJECTION_ORTHOGRAPHIC } = await import("playcanvas");
    const applyOptions = { perspective: PROJECTION_PERSPECTIVE, orthographic: PROJECTION_ORTHOGRAPHIC };

    let focus = { center: [0, 0.8, 0] as [number, number, number], radius: 5 };
    if (options.asset) {
      await registerSplatParsers(app);
      const { Asset, AssetListLoader } = await import("playcanvas");
      const tLoad = performance.now();
      const asset = new Asset("world", "gsplat", { url: options.asset });
      const events: string[] = [];
      asset.on("error", (err: unknown) => events.push(`error: ${err instanceof Error ? err.message : String(err)}`));
      asset.on("load", () => events.push("load"));
      await new Promise<void>((resolve) => { new AssetListLoader([asset], app.assets as never).load(() => resolve()); });
      result.assetEvents = events;
      result.loadMs = Math.round(performance.now() - tLoad);
      const resource = (asset as unknown as { resource?: { numSplats?: number; centers?: Float32Array } }).resource;
      result.numSplats = resource?.numSplats ?? null;
      if (!result.numSplats) throw new Error(`GSplat 资源没有 numSplats —— 加载失败（events=${JSON.stringify(events)}）`);
      const world = new Entity("world");
      world.addComponent("gsplat", { asset });
      app.root.addChild(world);
      // 用 centers 算包围盒，把相机摆到看得全的距离（不猜机位）
      const centers = resource!.centers!;
      const lo = [Infinity, Infinity, Infinity];
      const hi = [-Infinity, -Infinity, -Infinity];
      for (let i = 0; i < result.numSplats; i += 1) {
        for (let k = 0; k < 3; k += 1) {
          const v = centers[i * 3 + k]!;
          if (v < lo[k]!) lo[k] = v;
          if (v > hi[k]!) hi[k] = v;
        }
      }
      const center = [0, 1, 2].map((k) => (lo[k]! + hi[k]!) / 2) as [number, number, number];
      const radius = Math.max(...[0, 1, 2].map((k) => (hi[k]! - lo[k]!) / 2));
      focus = { center, radius };
      log(`splat 加载: ${result.numSplats} 个, ${result.loadMs}ms`);
    }
    // 材质做一份共用：`render.material` 的静态类型是基类 `Material`，
    // 所以先把 StandardMaterial 建好再赋进去，而不是在属性链上设 diffuse。
    const boxMaterial = new StandardMaterial();
    boxMaterial.diffuse = new Color(0.85, 0.72, 0.45);
    boxMaterial.update();
    const boxes = [
      [0, 0.5, 0, 1], [2.2, 0.9, 0.4, 1.8], [-2.4, 0.35, -0.6, 0.7], [0.6, 1.6, -2.2, 1.4],
    ] as const;
    for (const [x, y, z, s] of (options.asset ? [] : boxes)) {
      const box = new Entity("box");
      box.addComponent("render", { type: "box" });
      if (box.render) box.render.material = boxMaterial;
      box.setLocalScale(s, s, s);
      box.setPosition(x, y, z);
      app.root.addChild(box);
    }
    // 拾取自检的靶子：单独摆在高处。**故意远离其它盒子**——这样"投影点拾取"要么命中它，
    // 要么明确落空；坐标约定写错时不会碰巧命中隔壁的盒子。
    const pickTargetEntity = new Entity("pick-target");
    pickTargetEntity.addComponent("render", { type: "box" });
    if (pickTargetEntity.render) pickTargetEntity.render.material = boxMaterial;
    pickTargetEntity.setLocalScale(1.2, 1.2, 1.2);
    pickTargetEntity.setPosition(0, 6, 0);
    if (!options.asset) app.root.addChild(pickTargetEntity);
    const light = new Entity("light");
    light.addComponent("light", { type: "directional", color: new Color(1, 1, 1), intensity: 1.4 });
    light.setEulerAngles(35, 45, 0);
    app.root.addChild(light);

    const bindings = await createEnginePaneBindings(canvas, app);
    const registry = new PaneRegistry({ ...bindings, canvasSize: () => ({ width: canvas.clientWidth, height: canvas.clientHeight }) });

    const count = Math.max(1, Math.min(4, options.panes));
    const layout = (index: number, n: number) => {
      if (n === 1) return { left: 0, top: 0, width: canvas.clientWidth, height: canvas.clientHeight };
      if (n === 2) return { left: (index * canvas.clientWidth) / 2, top: 0, width: canvas.clientWidth / 2, height: canvas.clientHeight };
      if (n === 3) return { left: (index * canvas.clientWidth) / 3, top: 0, width: canvas.clientWidth / 3, height: canvas.clientHeight };
      return {
        left: (index % 2) * (canvas.clientWidth / 2),
        top: Math.floor(index / 2) * (canvas.clientHeight / 2),
        width: canvas.clientWidth / 2,
        height: canvas.clientHeight / 2,
      };
    };

    // 先建一次拿到 hudLayerId（注册表会为每格新建一层），再按真实尺寸同步。
    const specs: PaneSpec[] = [];
    const initial = registry.sync(
      Array.from({ length: count }, (_, i) => ({ id: `pane-${i}`, viewport: layout(i, count) })),
    );
    result.rects = initial;
    result.layerIds = app.scene.layers.layerList.map((layer) => layer.id);

    /**
     * 每格的台架状态是**唯一真值**：摆机位、运动、指针输入都只改这里，再 `applyRig` 到实体。
     * 迁移前是直接 `setPosition`/`lookAt`；改成台架后输入层才有状态可读写。
     */
    const rigs = new Map<string, CameraRig>();
    const placeCameras = (phase: number) => {
      for (let i = 0; i < count; i += 1) {
        const id = `pane-${i}`;
        const entity = bindings.entityFor(id) as unknown as RigEntityLike | null;
        if (!entity) continue;
        const azimuth = ((i - (count - 1) / 2) * 25 * Math.PI) / 180 + phase;
        // 与迁移前的直接摆位等价：水平距离 radius*2.2、抬高 radius*0.25，看向 focus.center
        const horizontal = focus.radius * 2.2;
        const rise = focus.radius * 0.25;
        const distance = Math.hypot(horizontal, rise);
        const next: CameraRig = {
          target: [focus.center[0], focus.center[1], focus.center[2]],
          azimuth,
          polar: Math.acos(rise / distance),
          distance,
          fov: 60,
          projection: "perspective",
        };
        rigs.set(id, next);
        applyRig(entity, next, applyOptions);
      }
    };
    for (let i = 0; i < count; i += 1) specs.push({ id: `pane-${i}`, viewport: layout(i, count) });
    placeCameras(0);
    registry.sync(specs);
    log(`${count} 个窗格，rect=${JSON.stringify(result.rects)}`);

    /**
     * 变换 gizmo：三种模式各一个实例、逐窗格。**在输入层之前建**——引擎的 gizmo 自己往 canvas 上挂
     * pointer 监听（`gizmo.js:70-72`），不过输入层还会在拖动途中复查 `isPointerClaimed`，所以
     * 注册顺序不是正确性的唯一依赖（两边都写进了 AGENTS.md §四之二）。
     */
    let gizmoHost: PaneGizmoHandle | null = null;
    let gizmoDragStarts = 0;
    let gizmoDragEnds = 0;
    let lastGizmoHoverName: string | null = null;
    if (options.gizmo && pickTargetEntity.parent) {
      gizmoHost = await createPaneGizmos({
        createLayer: (paneId) => {
          // 引擎的 createLayer 已经给好 clearDepthBuffer（手柄画在世界之上）与 SORTMODE_NONE
          const layer = Gizmo.createLayer(app as never, `pane-gizmo:${paneId}`);
          return { id: layer.id, layer };
        },
        // Gizmo.destroy() 不管层，必须自己删（否则每轮泄漏一层）
        removeLayer: (entry) => { (app.scene.layers as unknown as { remove(layer: unknown): void }).remove(entry.layer); },
        cameraFor: (paneId) => (bindings.entityFor(paneId) as { camera?: unknown } | null)?.camera ?? null,
        onDragStart: () => { gizmoDragStarts += 1; },
        onDragEnd: () => { gizmoDragEnds += 1; },
      });
      gizmoHost.attach("pane-0", pickTargetEntity);
      // gizmo 层必须进注册表：sync() 每次都重写 camera.layers，外部 concat 的层下一次就被抹掉
      const gizmoLayerId = gizmoHost.layerIdFor("pane-0");
      if (gizmoLayerId !== null) {
        specs[0]!.extraLayerIds = [gizmoLayerId];
        registry.sync(specs);
      }
      // 悬停读数（轴名规则同引擎的 `TransformGizmo._getAxis`：node 名 `xxx:axis`）
      gizmoHost.gizmoFor("pane-0", "translate")?.on("pointer:move", (_x, _y, meshInstance) => {
        lastGizmoHoverName = (meshInstance as { node?: { name?: string } } | null)?.node?.name ?? null;
      });
      log(`gizmo: mode=${gizmoHost.modeFor("pane-0")} layer=${gizmoLayerId} 挂到 ${pickTargetEntity.name}`);
    }

    // 指针输入：每个窗格各自的 DOM 事件 → 只有被指到的那一格的台架会变。
    // `input` 跑一次页面内的合成事件自检；`inputHoldMs` 只挂着监听等 CDP 派发**可信**事件。
    const inputSpecs: PaneInputSpec[] = specs.map((pane) => ({ id: pane.id, viewport: pane.viewport }));
    const cameraTuple = (paneId: string): [number, number, number] | null => {
      const entity = bindings.entityFor(paneId) as unknown as { getPosition?(): { x: number; y: number; z: number } } | null;
      const position = entity?.getPosition?.();
      return position
        ? [+position.x.toFixed(4), +position.y.toFixed(4), +position.z.toFixed(4)]
        : null;
    };
    /** 等两帧：确保改过的相机/实体状态真的被渲染出来（逐格像素对比前必须等）。 */
    const settle = () => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));

    /** 某一格的像素签名（只看亮像素）：判断"这一格的画面变了没有"。 */
    const paneSignature = (index: number): number => {
      const image = document.createElement("canvas");
      image.width = canvas.width;
      image.height = canvas.height;
      const context = image.getContext("2d", { willReadFrequently: true })!;
      context.drawImage(canvas, 0, 0);
      const pane = inputSpecs[index]!.viewport;
      const scaleX = canvas.width / canvas.clientWidth;
      const scaleY = canvas.height / canvas.clientHeight;
      const pixels = context.getImageData(
        Math.round(pane.left * scaleX), Math.round(pane.top * scaleY),
        Math.max(1, Math.round(pane.width * scaleX)), Math.max(1, Math.round(pane.height * scaleY)),
      ).data;
      let hash = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const luma = (pixels[i]! + pixels[i + 1]! + pixels[i + 2]!) / 3;
        if (luma > 14) hash = (hash * 31 + i) % 2147483647;
      }
      return hash;
    };

    // 兼容鼠标事件计数：用来实测"取消 pointerdown 之后浏览器还发不发 click/dblclick"（见 paneInput.ts ⑤）
    const compatEvents: Record<string, number> = {};
    let interactions = 0;
    let input: PanePointerInputHandle | null = null;
    // 拾取：按需建缓冲（不点击就不分配显存）。`onClick` 是应用将要走的同一条路径。
    let lastPick: { paneId: string; name: string | null; kind: string | null } | null = null;
    let lastPickError: string | null = null;
    const picker: PanePickerHandle | null = options.picking
      ? createPanePicker(app, {
          canvasSize: () => ({ width: canvas.clientWidth, height: canvas.clientHeight }),
          cameraFor: (paneId) => bindings.entityFor(paneId) as { camera?: unknown } | null,
        })
      : null;
    const pickAt = (paneId: string, point: { x: number; y: number }) => {
      void picker?.pick(paneId, point).then((hit) => {
        lastPick = hit ? { paneId, name: hit.name, kind: hit.kind } : { paneId, name: null, kind: null };
      }).catch((error) => { lastPickError = String(error); });
    };
    if (options.input || options.inputHoldMs) {
      for (const type of ["click", "dblclick", "mousedown", "mouseup"]) {
        canvas.addEventListener(type, () => { compatEvents[type] = (compatEvents[type] ?? 0) + 1; });
      }
      input = attachPanePointerInput(canvas, {
        panes: () => inputSpecs,
        getRig: (paneId) => rigs.get(paneId) ?? null,
        setRig: (paneId, rig) => {
          rigs.set(paneId, rig);
          const entity = bindings.entityFor(paneId) as unknown as RigEntityLike | null;
          if (entity) applyRig(entity, rig, applyOptions);
        },
        focusTarget: () => ({ center: [focus.center[0], focus.center[1], focus.center[2]], radius: focus.radius }),
        onClick: (paneId, point) => { if (picker) pickAt(paneId, point); },
        // 手柄拖动期间把指针手势让给 gizmo（信号来自引擎自己的 transform:start/end）
        isPointerClaimed: (paneId) => gizmoHost?.dragging(paneId) ?? false,
        onInteraction: () => { interactions += 1; },
      });
    }

    // 数真实 GPU render pass：被合并的 FramePass 不会调用 startRenderPass。
    let starts = 0;
    let ends = 0;
    const target = device as unknown as {
      startRenderPass?: (...args: unknown[]) => unknown;
      endRenderPass?: (...args: unknown[]) => unknown;
    };
    const originalStart = target.startRenderPass?.bind(device);
    const originalEnd = target.endRenderPass?.bind(device);
    if (originalStart) target.startRenderPass = (...args: unknown[]) => { starts += 1; return originalStart(...args); };
    if (originalEnd) target.endRenderPass = (...args: unknown[]) => { ends += 1; return originalEnd(...args); };

    // 运动机位在引擎的 `update` 里推进——它在 `render` 之前触发（`app-base.js` 的 tick），
    // 所以每一帧渲染看到的都是新角度。放在我自己的 rAF 回调里无法保证这个顺序。
    let motionPhase = 0;
    if (options.motion) {
      app.on("update", () => { motionPhase += 0.02; placeCameras(motionPhase); });
    }

    if (options.glb && !options.asset) {
      const { collectTextureEntries, collectMaterials } = await import("./modelTextures");
      const tLoad = performance.now();
      /*
        用 `loadFromUrlAndFilename`：这是引擎自带示例（`viewer.example.mjs:450`）的写法。
        先前的 `new Asset(name, "container", { url })` + `AssetListLoader` 拿到的资源
        `instantiateRenderEntity()` 返回的是**空树**（`hasRender: false`、`childCount: 0`），
        而且只监听 `error` 事件会漏掉真正的失败——这个回调的 `err` 参数才是权威。
      */
      const registry = app.assets as unknown as {
        loadFromUrlAndFilename(url: string, filename: string, type: string,
          callback: (err: unknown, asset: unknown) => void): void;
      };
      const container = await new Promise<{ resource?: { instantiateRenderEntity(): unknown } }>((resolve, reject) => {
        registry.loadFromUrlAndFilename(options.glb!, "model.glb", "container", (err, loaded) => {
          if (err) reject(new Error(`container 加载失败: ${err instanceof Error ? err.message : JSON.stringify(err)}`));
          else resolve(loaded as { resource?: { instantiateRenderEntity(): unknown } });
        });
      });
      result.loadMs = Math.round(performance.now() - tLoad);
      const resource = container.resource;
      result.assetEvents = [`loaded=${!!resource}`];
      if (!resource) throw new Error("GLB 未加载成功（resource 为空）");
      const modelEntity = resource.instantiateRenderEntity() as PcEntityLike & { setPosition(x: number, y: number, z: number): void };
      app.root.addChild(modelEntity);
      modelEntity.setPosition(0, 0, 0);

      // 生产者在**真实模型**上的产出：这是窄接口字段名唯一的确认途径
      const materials = collectMaterials(modelEntity);
      const entries = collectTextureEntries(modelEntity);
      let meshInstances = 0;
      let entitiesWithRender = 0;
      const walk = (node: PcEntityLike) => {
        if (node.render) { entitiesWithRender += 1; meshInstances += node.render.meshInstances?.length ?? 0; }
        for (const child of node.children ?? []) walk(child);
      };
      walk(modelEntity);
      const { describeFirstTexture } = await import("./modelTextures");
      const textureShape = describeFirstTexture(modelEntity);
      const rootAny = modelEntity as unknown as Record<string, unknown>;
      const renderAny = rootAny.render as Record<string, unknown> | undefined;
      const children = (rootAny.children ?? []) as unknown[];
      const firstChild = (children[0] ?? {}) as Record<string, unknown>;
      result.model = {
        raw: {
          rootKeys: Object.keys(rootAny).filter((k) => !k.startsWith("_")).slice(0, 30),
          hasRender: !!renderAny,
          renderKeys: renderAny ? Object.keys(renderAny).slice(0, 20) : [],
          childCount: children.length,
          firstChildKeys: Object.keys(firstChild).filter((k) => !k.startsWith("_")).slice(0, 30),
        },
        textureEntries: entries.map((e) => ({ id: e.id, label: e.label, materials: e.materials, width: e.width, height: e.height, hasThumb: e.dataUrl !== null })),
        supportedSlots: [...new Set(entries.flatMap((e) => e.label.split("/")))],
        diagnostics: {
          entitiesWithRender,
          meshInstanceCount: meshInstances,
          materials: materials.length,
          sampleMaterialProps: materials[0] ? Object.keys(materials[0]).filter((k) => /Map$/.test(k)).slice(0, 24) : [],
        },
        textureShape,
      };
      log(`模型: ${materials.length} 个材质, ${entries.length} 张贴图, 诊断=${JSON.stringify(result.model.diagnostics)}`);
      focus = { center: [0, 0, 0], radius: 1.2 };
    }

    app.start();

    const frames: number[] = [];
    let previous = performance.now();
    const total = options.frames ?? 240;
    await new Promise<void>((done) => {
      let n = 0;
      const tick = () => {
        const now = performance.now();
        frames.push(now - previous);
        previous = now;
        n += 1;
        if (n < total) requestAnimationFrame(tick);
        else done();
      };
      requestAnimationFrame(tick);
    });

    const warm = frames.slice(Math.floor(total / 4));
    result.frameCount = total;
    result.frameMs = { p50: +median(warm).toFixed(2), min: +Math.min(...warm).toFixed(2), max: +Math.max(...warm).toFixed(2) };
    result.gpuRenderPasses = { start: starts, end: ends };
    result.drawCalls = app.stats?.drawCalls?.total ?? undefined;
    log(`帧间隔 p50=${result.frameMs.p50}ms  renderPass start=${starts} end=${ends}  drawCalls=${result.drawCalls}`);

    // 逐格像素校验：多窗格下"整块画布有内容"可能只来自其中一格。
    const width = canvas.width;
    const height = canvas.height;
    const snapshot = document.createElement("canvas");
    snapshot.width = width;
    snapshot.height = height;
    const context = snapshot.getContext("2d", { willReadFrequently: true })!;
    context.drawImage(canvas, 0, 0, width, height);
    const data = context.getImageData(0, 0, width, height).data;

    const stats = (x0: number, y0: number, w: number, h: number) => {
      const xEnd = Math.min(width, x0 + w);
      const yEnd = Math.min(height, y0 + h);
      let sum = 0;
      let nonBackground = 0;
      let count = 0;
      for (let y = Math.max(0, y0); y < yEnd; y += 1) {
        for (let x = Math.max(0, x0); x < xEnd; x += 1) {
          const offset = (y * width + x) * 4;
          const luma = (data[offset]! + data[offset + 1]! + data[offset + 2]!) / 3;
          sum += luma;
          count += 1;
          if (luma > 14) nonBackground += 1;
        }
      }
      return count === 0
        ? { meanLuma: null, nonBackgroundFraction: 0, outOfBounds: true }
        : { meanLuma: +(sum / count).toFixed(2), nonBackgroundFraction: +(nonBackground / count).toFixed(4) };
    };

    // 用 CSS 归一化布局换算成像素采样区，与相机 rect 同源
    result.panePixels = [];
    for (let i = 0; i < count; i += 1) {
      const rect = layout(i, count);
      const scaleX = width / canvas.clientWidth;
      const scaleY = height / canvas.clientHeight;
      result.panePixels.push(stats(
        Math.round(rect.left * scaleX),
        Math.round(rect.top * scaleY),
        Math.max(1, Math.round(rect.width * scaleX)),
        Math.max(1, Math.round(rect.height * scaleY)),
      ));
    }
    log(`逐格像素: ${JSON.stringify(result.panePixels)}`);

    if (options.inspection) {
      const { captureInspectionSheet } = await import("./inspectionCapture");
      // 用主相机拍到的 focus 作为包围球；模型/世界都已经被摆好了
      const base64 = await captureInspectionSheet(app as never, { center: focus.center, radius: focus.radius }, { tile: 128 });
      // 逐格重算签名：把检查图切回四块来验"四个视角确实不同"
      const tile = 128;
      const canvas = document.createElement("canvas");
      canvas.width = tile; canvas.height = tile;
      const context = canvas.getContext("2d", { willReadFrequently: true })!;
      const image = new Image();
      await new Promise<void>((resolve, reject) => { image.onload = () => resolve(); image.onerror = () => reject(new Error("sheet decode failed")); image.src = `data:image/png;base64,${base64}`; });
      const tiles: { label: string; meanLuma: number; hash: number; nonBackground: number }[] = [];
      for (const [index, view] of ["ISO", "FRONT", "RIGHT", "TOP"].entries()) {
        context.clearRect(0, 0, tile, tile);
        context.drawImage(image, (index % 2) * tile, Math.floor(index / 2) * tile, tile, tile, 0, 0, tile, tile);
        const data = context.getImageData(0, 0, tile, tile).data;
        let sum = 0, nonBackground = 0, hash = 0;
        for (let i = 0; i < data.length; i += 4) {
          const luma = (data[i]! + data[i + 1]! + data[i + 2]!) / 3;
          sum += luma;
          if (luma > 14) nonBackground += 1;
          // 极简签名：只对亮像素做加权和，足以区分不同视角
          if (luma > 14) hash = (hash * 31 + i) % 2147483647;
        }
        const total = data.length / 4;
        tiles.push({ label: view, meanLuma: +(sum / total).toFixed(2), hash, nonBackground: +(nonBackground / total).toFixed(4) });
      }
      result.inspection = { tiles, uniqueHashes: new Set(tiles.map((t) => t.hash)).size, pngBase64Length: base64.length };
      log(`四视角: ${tiles.map((t) => `${t.label}(亮度${t.meanLuma}/非背景${t.nonBackground})`).join(" ")} 唯一签名=${result.inspection.uniqueHashes}`);
    }

    if (options.capture) {
      // 走**准入层**（CaptureQueue 排队 + ResourceBudget 预约/降级），而不是直接调底层截图：
      // 这才是应用实际会走的路径，也是"队列 + 预算 + 真实 GPU"三者第一次一起跑。
      const { captureSceneThroughQueue } = await import("./captureViaQueue");
      const size = 256;
      const shot = await captureSceneThroughQueue(app, { size, priority: "thumbnail", samples: device.samples });
      let sum = 0, nonBackground = 0, opaque = 0;
      const pixels = shot.rgba;
      for (let i = 0; i < pixels.length; i += 4) {
        const luma = (pixels[i]! + pixels[i + 1]! + pixels[i + 2]!) / 3;
        sum += luma;
        if (luma > 14) nonBackground += 1;
        if (pixels[i + 3]! > 0) opaque += 1;
      }
      const total = pixels.length / 4;
      result.capture = {
        width: shot.width, height: shot.height, bytes: pixels.length,
        queuedMs: shot.queuedMs, degraded: shot.degraded, size: shot.size,
        meanLuma: +(sum / total).toFixed(2),
        nonBackgroundFraction: +(nonBackground / total).toFixed(4),
        // 紧凑排布的证据：字节数必须**恰好**等于 w*h*4（若带 256 行填充会明显更大）
        opaqueFraction: +(opaque / total).toFixed(4),
      };
      log(`截图: ${result.capture.width}x${result.capture.height} bytes=${result.capture.bytes} 亮度=${result.capture.meanLuma} 非背景=${result.capture.nonBackgroundFraction}`);
    }

    if (options.rig) {
      // 走**相机台架**（纯状态 → applyRig → 引擎相机），而不是直接摆机位：
      // 单测只证明"写对了属性"，这里证明"相机真的动了、画面真的变了"。
      // capture 块的导入在那条分支里，这里要各自导入
      const { captureSceneThroughQueue } = await import("./captureViaQueue");
      const base = {
        target: [focus.center[0], focus.center[1], focus.center[2]] as Vec3,
        polar: Math.PI / 2.4, distance: focus.radius * 2.6,
        fov: 60, projection: "perspective" as const,
      };
      const samples: { azimuthDegrees: number; meanLuma: number; hash: number }[] = [];
      for (const degrees of [0, 90]) {
        const rig: CameraRig = { ...base, azimuth: (degrees * Math.PI) / 180 };
        rigs.set("pane-0", rig);
        const entity = bindings.entityFor("pane-0") as unknown as RigEntityLike | null;
        if (entity) applyRig(entity, rig, applyOptions);
        await new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const shot = await captureSceneThroughQueue(app, { size: 96, priority: "thumbnail", samples: device.samples });
        let sum = 0, hash = 0;
        for (let i = 0; i < shot.rgba.length; i += 4) {
          const luma = (shot.rgba[i]! + shot.rgba[i + 1]! + shot.rgba[i + 2]!) / 3;
          sum += luma;
          if (luma > 14) hash = (hash * 31 + i) % 2147483647;
        }
        samples.push({ azimuthDegrees: degrees, meanLuma: +(sum / (shot.rgba.length / 4)).toFixed(2), hash });
      }
      result.rigCheck = samples;
      log(`相机台架: ${samples.map((x) => `${x.azimuthDegrees}°→亮度${x.meanLuma}`).join("  ")}  签名不同=${samples[0]!.hash !== samples[1]!.hash}`);
    }

    if (options.input && input) {
      /*
        指针输入自检：**真实 DOM 事件路径**（在真实浏览器里跑），合成事件本身不是可信事件，
        所以另有一条 `inputHoldMs` + CDP 可信事件的复测（PLAYCANVAS_MIGRATION.md §三之六）。
        驱动顺序与用户在编辑器里的操作一一对应：拖动转视角 → 滚轮缩放 → 右键平移 → 双击聚焦。
      */
      const report: NonNullable<PaneHarnessResult["input"]> = {
        routed: [], untouched: [], gestureReleased: false, pixelChanged: false, ok: false,
      };
      const beforeRigs = new Map([...rigs].map(([id, rig]) => [id, JSON.stringify(rig)]));
      const beforeCameras = new Map([...rigs.keys()].map((id) => [id, JSON.stringify(cameraTuple(id))]));
      const rect = canvas.getBoundingClientRect();
      const spots = inputSpecs.map((pane) => ({
        x: pane.viewport.left + pane.viewport.width / 2,
        y: pane.viewport.top + pane.viewport.height / 2,
      }));
      const center = spots[0]!;
      const pointer = (type: string, x: number, y: number, init: PointerEventInit) =>
        new PointerEvent(type, {
          pointerId: 1, pointerType: "mouse", bubbles: true, cancelable: true,
          clientX: rect.left + x, clientY: rect.top + y, ...init,
        });
      const down = (x: number, y: number, button = 0) => {
        canvas.dispatchEvent(pointer("pointerdown", x, y, { button, buttons: button === 0 ? 1 : button === 2 ? 2 : 4 }));
        report.routed.push(input!.active()?.paneId ?? null);
      };
      // move / up 派发到 window：指针移出画布后事件落点就是 window（这正是"粘住"缺陷的现场）
      const move = (x: number, y: number) => window.dispatchEvent(pointer("pointermove", x, y, { buttons: 1 }));
      const up = (x: number, y: number, button = 0) => window.dispatchEvent(pointer("pointerup", x, y, { button, buttons: 0 }));
      const click = (x: number, y: number) => { down(x, y); up(x, y); };
      const hashBefore = paneSignature(0);

      // ① 左键拖动 = 轨道旋转：方位角变小、距离不变
      const orbitBefore = rigs.get("pane-0")!;
      down(center.x, center.y);
      move(center.x + 40, center.y + 10);
      move(center.x + 80, center.y + 20);
      up(center.x + 80, canvas.clientHeight + 40); // 在画布外抬手
      const orbitAfter = rigs.get("pane-0")!;
      const orbitOk = orbitAfter.azimuth < orbitBefore.azimuth - 1e-6
        && Math.abs(orbitAfter.distance - orbitBefore.distance) < 1e-9;
      report.gestureReleased = input.active() === null;
      report.orbit = { azimuth: +orbitAfter.azimuth.toFixed(4), distance: +orbitAfter.distance.toFixed(4), camera: cameraTuple("pane-0") };

      // ② 滚轮 = 乘性缩放（并且真的取消了默认行为）
      const wheelBefore = rigs.get("pane-0")!;
      const wheelEvent = new WheelEvent("wheel", {
        deltaY: -100, deltaMode: 0, clientX: rect.left + center.x, clientY: rect.top + center.y,
        bubbles: true, cancelable: true,
      });
      canvas.dispatchEvent(wheelEvent);
      const wheelAfter = rigs.get("pane-0")!;
      const wheelOk = wheelEvent.defaultPrevented && wheelAfter.distance < wheelBefore.distance - 1e-6;
      report.wheel = { distance: +wheelAfter.distance.toFixed(4) };

      // ③ 右键拖动 = 平移：目标点动了、距离与姿态不变
      const panBefore = rigs.get("pane-0")!;
      down(center.x, center.y, 2);
      move(center.x + 30, center.y + 20);
      up(center.x + 30, center.y + 20, 2);
      const panAfter = rigs.get("pane-0")!;
      const panShift = Math.hypot(...panAfter.target.map((value, index) => value - panBefore.target[index]!));
      const panOk = panShift > 1e-6 && Math.abs(panAfter.distance - panBefore.distance) < 1e-9;
      report.pan = { target: panAfter.target.map((v) => +v.toFixed(4)) as Vec3, distance: +panAfter.distance.toFixed(4) };

      // ④ 双击（两次点击，1px 之内）= 聚焦到包围球
      click(center.x, center.y);
      click(center.x + 1, center.y);
      const focusAfter = rigs.get("pane-0")!;
      const expectedDistance = fitDistance(focus.radius, 60);
      const focusShift = Math.hypot(...focusAfter.target.map((value, index) => value - focus.center[index]!));
      const focusOk = focusShift < 1e-3 && Math.abs(focusAfter.distance - expectedDistance) < 1e-3;
      report.focus = {
        target: focusAfter.target.map((v) => +v.toFixed(4)) as Vec3,
        distance: +focusAfter.distance.toFixed(4),
        expectedDistance: +expectedDistance.toFixed(4),
      };

      await settle();
      report.pixelChanged = paneSignature(0) !== hashBefore;

      // ⑤ 其余窗格必须一动都没动（台架与引擎实体位置都要一样）
      for (const id of rigs.keys()) {
        if (id === "pane-0") continue;
        report.untouched.push({
          paneId: id,
          moved: JSON.stringify(rigs.get(id)) !== beforeRigs.get(id)
            || JSON.stringify(cameraTuple(id)) !== beforeCameras.get(id),
        });
      }

      report.ok = report.routed[0] === "pane-0"
        && orbitOk && wheelOk && panOk && focusOk
        && report.gestureReleased && report.pixelChanged
        && report.untouched.every((pane) => !pane.moved);
      result.input = report;
      log(`输入自检: 命中=${report.routed.join("/")} 轨道=${orbitOk} 滚轮=${wheelOk} 平移=${panOk} 聚焦=${focusOk} 画面变了=${report.pixelChanged} 未污染=${report.untouched.every((p) => !p.moved)} 收手=${report.gestureReleased}`);
    }

    if (options.picking && picker && pickTargetEntity.parent) {
      /*
        拾取自检：用**引擎自己的投影**（`CameraComponent.worldToScreen`，它自己处理 `camera.rect`
        与 DPR）算出靶子盒子在屏幕上的位置，再让拾取器去那一点拿结果。
        坐标约定写错（例如按窗格局部坐标而不是画布归一化坐标去读缓冲）时，这里会命中不到靶子。
      */
      const report: NonNullable<PaneHarnessResult["picking"]> = {
        buffer: { width: 0, height: 0 }, aimed: [], empty: [], rigUnchanged: true, ok: false,
      };
      const beforePickRigs = JSON.stringify([...rigs]);
      const targetWorld = pickTargetEntity.getPosition();
      const canvasCenter = { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 };
      // 阴性对照取"离画布中心最远的那个窗格角"：相机看向场景中心，那些角上一定没有物体
      const emptySpot = (pane: PaneInputSpec) => {
        const cx = pane.viewport.left + pane.viewport.width / 2;
        const cy = pane.viewport.top + pane.viewport.height / 2;
        return {
          x: +(cx + (cx < canvasCenter.x ? -1 : 1) * (pane.viewport.width / 2 - 6)).toFixed(2),
          y: +(cy + (cy < canvasCenter.y ? -1 : 1) * (pane.viewport.height / 2 - 6)).toFixed(2),
        };
      };
      for (const pane of inputSpecs) {
        const camera = (bindings.entityFor(pane.id) as unknown as {
          camera?: { worldToScreen(point: unknown): { x: number; y: number } };
        } | null)?.camera;
        if (!camera) continue;
        const screen = camera.worldToScreen(targetWorld);
        const point = { x: +screen.x.toFixed(2), y: +screen.y.toFixed(2) };
        const hit = await picker.pick(pane.id, point);
        report.aimed.push({ paneId: pane.id, point, name: hit?.name ?? null, kind: hit?.kind ?? null });
        const emptyPoint = emptySpot(pane);
        const miss = await picker.pick(pane.id, emptyPoint);
        report.empty.push({ paneId: pane.id, point: emptyPoint, name: miss?.name ?? null });
      }
      report.buffer = picker.bufferSize();
      report.rigUnchanged = JSON.stringify([...rigs]) === beforePickRigs;
      report.ok = report.aimed.length === inputSpecs.length
        && report.aimed.every((entry) => entry.name === "pick-target")
        && report.empty.every((entry) => entry.name === null)
        && report.rigUnchanged;
      result.picking = report;
      log(`拾取自检: 靶子=${report.aimed.map((e) => `${e.paneId}→${e.name}`).join(" ")} 空白=${report.empty.map((e) => `${e.paneId}→${e.name}`).join(" ")} 缓冲=${report.buffer.width}x${report.buffer.height} 台架未动=${report.rigUnchanged}`);
    }

    if (options.gizmo && gizmoHost) {
      /*
        gizmo 自检：手柄**只画在自己那一格**。做法是"挂上 vs 摘掉"两次逐格像素签名对比——
        比"看图"客观，而且能抓住"gizmo 层被 sync 从 camera.layers 里抹掉"这个静默失败
        （那正是本仓库在 paneRegistry 的 extraLayerIds 上要守的东西）。
      */
      const report: NonNullable<PaneHarnessResult["gizmo"]> = {
        mode: gizmoHost.modeFor("pane-0"), space: gizmoHost.spaceFor("pane-0"),
        layerInCamera: false, withGizmo: [], withoutGizmo: [],
        ownPaneChanged: false, otherPanesUnchanged: true, passesPerFrame: 0, ok: false,
      };
      await settle();
      report.withGizmo = inputSpecs.map((_pane, index) => paneSignature(index));
      const pane0Camera = (bindings.entityFor("pane-0") as unknown as { camera?: { layers?: number[] } } | null)?.camera;
      const gizmoLayerId = gizmoHost.layerIdFor("pane-0");
      report.layerInCamera = gizmoLayerId !== null && (pane0Camera?.layers ?? []).includes(gizmoLayerId);

      gizmoHost.attach("pane-0", null);
      await settle();
      report.withoutGizmo = inputSpecs.map((_pane, index) => paneSignature(index));
      gizmoHost.attach("pane-0", pickTargetEntity);
      await settle();

      report.ownPaneChanged = report.withGizmo[0] !== report.withoutGizmo[0];
      report.otherPanesUnchanged = inputSpecs.every((_pane, index) => index === 0
        || report.withGizmo[index] === report.withoutGizmo[index]);
      report.passesPerFrame = result.frameCount ? +(result.gpuRenderPasses!.start / result.frameCount).toFixed(3) : 0;
      report.ok = report.mode === "translate" && report.space === "world"
        && report.layerInCamera && report.ownPaneChanged && report.otherPanesUnchanged;
      result.gizmo = report;
      log(`gizmo 自检: 模式=${report.mode}/${report.space} 层在相机里=${report.layerInCamera} 本格变了=${report.ownPaneChanged} 其它格未变=${report.otherPanesUnchanged} pass/帧=${report.passesPerFrame}`);
    }

    if (options.inputHoldMs && input) {
      // 只挂监听、不改状态：等 CDP 派发**可信**鼠标事件，再回来读 rig/camera/active/lastPick。
      const live = {
        rects: () => inputSpecs.map((pane) => ({ id: pane.id, ...pane.viewport })),
        canvasRect: () => {
          const r = canvas.getBoundingClientRect();
          return { left: r.left, top: r.top, width: r.width, height: r.height };
        },
        rig: (paneId: string) => rigs.get(paneId) ?? null,
        camera: (paneId: string) => cameraTuple(paneId),
        active: () => input!.active(),
        compatEvents: () => ({ ...compatEvents }),
        interactions: () => interactions,
        // 可信点击拾取用：靶子的当前屏幕位置（相机可能已经被前面的步骤动过）与"空白角"
        pickTarget: () => {
          const camera = (bindings.entityFor("pane-0") as unknown as {
            camera?: { worldToScreen(point: unknown): { x: number; y: number } };
          } | null)?.camera;
          if (!camera) return null;
          // 往 -X 偏 0.45（盒半宽 0.6）：**避开 gizmo 手柄**。手柄会认领 pointerdown
          // （引擎的 transform:start），被认领的那次点击就不再是"选择"——这是与 three 侧
          // `pickSuppressedRef` 一致的产品行为，不是缺陷；所以测"点击选择"要挑手柄以外的点。
          const pivot = pickTargetEntity.getPosition();
          const screen = camera.worldToScreen({ x: pivot.x - 0.45, y: pivot.y, z: pivot.z });
          return { paneId: "pane-0", x: +screen.x.toFixed(2), y: +screen.y.toFixed(2) };
        },
        pickEmptyPoint: () => {
          const pane = inputSpecs[0]!;
          const cx = pane.viewport.left + pane.viewport.width / 2;
          const cy = pane.viewport.top + pane.viewport.height / 2;
          return {
            paneId: pane.id,
            x: +(cx + (cx < canvas.clientWidth / 2 ? -1 : 1) * (pane.viewport.width / 2 - 6)).toFixed(2),
            y: +(cy + (cy < canvas.clientHeight / 2 ? -1 : 1) * (pane.viewport.height / 2 - 6)).toFixed(2),
          };
        },
        lastPick: () => lastPick,
        pickError: () => lastPickError,
        pickTargetPosition: () => {
          const position = pickTargetEntity.getPosition();
          return [+position.x.toFixed(4), +position.y.toFixed(4), +position.z.toFixed(4)];
        },
        // —— 变换 gizmo：拖动前的读数 ——
        gizmoState: () => (gizmoHost
          ? {
            mode: gizmoHost.modeFor("pane-0"),
            space: gizmoHost.spaceFor("pane-0"),
            attached: gizmoHost.attachedEntity("pane-0") !== null,
            dragging: gizmoHost.dragging("pane-0"),
            starts: gizmoDragStarts,
            ends: gizmoDragEnds,
          }
          : null),
        gizmoHover: () => lastGizmoHoverName,
        /** 沿世界 +X 的候选点：手柄的屏幕等大比例用引擎 `_updateScale` 的公式算（perspective）。 */
        gizmoProbe: () => {
          const cameraEntity = bindings.entityFor("pane-0") as unknown as {
            getPosition(): { x: number; y: number; z: number };
            forward: { x: number; y: number; z: number };
            camera?: { fov?: number; worldToScreen(point: unknown): { x: number; y: number } };
          } | null;
          const camera = cameraEntity?.camera;
          if (!cameraEntity || !camera || !gizmoHost?.attachedEntity("pane-0")) return [];
          const pivot = pickTargetEntity.getPosition();
          const camPos = cameraEntity.getPosition();
          // 用**距离**而不是 `forward·(pivot-camPos)`：后者依赖 forward 已经刷新，实测会因为
          // 拿到过期的 forward 把候选点压得很近（探针里踩过）。手柄大致在视野中心，距离即深度。
          const depth = Math.hypot(pivot.x - camPos.x, pivot.y - camPos.y, pivot.z - camPos.z);
          const scale = Math.tan(0.5 * (camera.fov ?? 60) * Math.PI / 180) * depth * 0.3;
          return [0.2, 0.35, 0.5, 0.65, 0.8, 1.0].map((fraction) => {
            const screen = camera.worldToScreen({ x: pivot.x + scale * fraction, y: pivot.y, z: pivot.z });
            return { fraction, x: +screen.x.toFixed(2), y: +screen.y.toFixed(2) };
          });
        },
      };
      (window as unknown as Record<string, unknown>).__PC_INPUT__ = live;
      log(`输入监听保持 ${options.inputHoldMs}ms，等 CDP 派发可信事件（window.__PC_INPUT__）`);
      await new Promise((resolve) => setTimeout(resolve, options.inputHoldMs));
    }

    result.compatEvents = compatEvents;
    result.interactionCount = interactions;
    const allDrawn = result.panePixels.every((pane) => pane.nonBackgroundFraction > 0.01);
    const inputOk = !options.input || result.input?.ok === true;
    const pickingOk = !options.picking || result.picking?.ok === true;
    const gizmoOk = !options.gizmo || result.gizmo?.ok === true;
    result.renderedSomething = allDrawn;
    result.ok = result.errors.length === 0 && allDrawn && inputOk && pickingOk && gizmoOk
      && !lastPickError && device.isWebGPU && device.isWebGL2 === false;

    input?.detach();
    picker?.dispose();
    gizmoHost?.dispose();
    registry.dispose();
    bindings.dispose();
    handle.stopLoop();
  } catch (error) {
    result.errors.push(`fatal: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    result.ok = false;
  } finally {
    result.elapsedMs = Math.round(performance.now() - started);
  }
  return result;
}
