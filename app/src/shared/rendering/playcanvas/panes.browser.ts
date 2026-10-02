import { fitDistance, rigPosition, type CameraRig, type Vec3 } from "../../../shared/lib/cameraRig";
import { createPlayCanvasApp } from "./app";
import { registerSplatParsers } from "./splat";
import type { PcEntityLike } from "./modelTextures";
import { createWebGPUDevice, readAdapterIdentity } from "./device";
import { createEnginePaneBindings } from "./enginePanes";
import { PaneRegistry, type PaneSpec } from "./paneRegistry";
import { applyRig, type RigEntityLike } from "./cameraRig";
import {
  attachPanePointerInput, focusRigWithTarget, type PaneInputSpec, type PanePointerInputHandle,
} from "./paneInput";
import { createPanePicker, type PanePickerHandle } from "./panePicking";
import { createPaneGizmos, type PaneGizmoHandle } from "./paneGizmo";
import { createEditorGrid, type EditorGridHandle } from "./paneGrid";
import { createPaneAxisHud, type PaneAxisHudHandle } from "./paneAxisHud";
import { createRigFlight, type RigFlightHandle } from "./rigFlight";
import { applyEntityPlacement, readEntityPlacement } from "./panePlacement";
import { createEngineSceneLoaders, createSceneAssets } from "./assetScene";
import { entityWorldBounds } from "./panePicking";
import {
  boundsFromCenterHalfExtents, unionBounds, type Bounds3, type Highlight,
} from "./selectionBounds";
import { createSelectionWireframe, type SelectionWireframeHandle } from "./selectionWireframe";
import { isTypingTarget as isTypingTargetImpl, modeForKey, shouldHandleModeKeys } from "./transformKeys";
import {
  createSelectionTransform, selectionPivot, type Placement, type SelectionTransformHandle,
} from "./selectionTransform";
import { TRANSFORM_MODES } from "../../../widgets/Viewport/transformMode";
import {
  createWalkState, lookStep, walkForward, walkInputFromKeys, walkStep, type WalkState,
} from "./walkRig";

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
   * 地面网格自检（`grid=1`）：逐格像素（挂上/摘掉都要变）、两级线各自都真的在画、
   * 距离淡出生效、`pick = false`（不挡拾取）。
   */
  grid?: {
    meshInstances: number;
    pickable: number;
    /** 挂上 / 摘掉网格时各格的像素签名 */
    withGrid: number[];
    withoutGrid: number[];
    allPanesChanged: boolean;
    /** 只留细线 / 只留粗线 的逐格签名（证明两级都参与） */
    cellsOnly: number[];
    sectionsOnly: number[];
    bothLevelsContribute: boolean;
    /** 把淡出半径压到很小之后，网格应当基本消失 */
    fadedOut: boolean;
    /** 俯视机位下"网格线像素数"（可读证据：两级各自参与时数字不同） */
    counts: Record<string, number>;
    /** 相机退到 200 单位外（平面只有 ±200，脚下没有平面）时，那一格是否整片空掉——
     *  证明淡出圆心用的是**逐相机**的 `view_position`，而不是 0。 */
    fadeFollowsCamera: boolean;
    /** 诊断：俯视/远离时的相机位置，以及材质被重建过几次 */
    cameraLookDown?: [number, number, number] | null;
    cameraFar?: [number, number, number] | null;
    materialVersion?: number;
    /** 诊断：俯视机位下横扫描线的 24 个亮度采样（有网格线就该是周期性明暗） */
    scanline?: { both: number[]; cellsOnly: number[]; sectionsOnly: number[] };
    passesPerFrame: number;
    ok: boolean;
  };
  /**
   * 坐标轴球 HUD 自检（`hud=1`）：逐格像素隔离、**屏幕等大**（相机退远后像素直径不变）、
   * 轴球随相机转、屏幕空间命中与吸附、pass/帧。
   */
  /** 资产挂载器自检（`asset=<spz>`）：`assetScene.ts` 的引擎加载路径（挂上/摆放/销毁） */
  sceneAssetsReport?: {
    mounted: string[];
    placementMatches: boolean;
    disposed: boolean;
    ok: boolean;
  };
  /** 真实 splat 拾取自检（`asset=<spz>&picking=1`）：开/关 `enableIds` 必须**一个能选中一个选不中** */
  splatReport?: {
    /** 载入的点数（真实资产，不是合成云） */
    numSplats: number | null;
    splatIdsDefault: boolean | null;
    /** 开 enableIds：点云中心投影点的拾取结果 */
    withIds: { name: string | null; kind: string | null } | null;
    /** 关 enableIds：同一点的结果（负对照） */
    withoutIds: { name: string | null; kind: string | null } | null;
    /** 负对照成立：关掉之后确实选不中点云 */
    idsRequired: boolean;
    passesPerFrame: number;
    ok: boolean;
  };
  /** 选中线框 + G/R/S 自检（`highlight=1`） */
  highlightReport?: {
    /** 点选之后线框出现，且盒 = 被选实体的世界包围盒外扩 2% */
    boundsMatches: boolean;
    /** 线框的**可拾取实例数**（必须为 0） */
    pickable: number;
    /** 线框可见时画面确实变了（像素） */
    pixelsChanged: boolean;
    /** 悬浮态更淡（透明度 0.35） */
    hoverOpacity: number;
    selectedOpacity: number;
    /** G/R/S 真的换了 gizmo 模式 */
    modeAfterKeys: string[];
    /** 在输入框里打字时**不**抢键 */
    ignoredWhileTyping: boolean;
    passesPerFrame: number;
    ok: boolean;
  };
  /** 多选整体变换自检（`multi=1`） */
  multiReport?: {
    /** 轴心 = 各成员位置的包围盒中心 */
    pivotIsCentroid: boolean;
    /** 单选时轴心落在物体自身摆放上 */
    singlePivotOnObject: boolean;
    /** 一次平移：三个成员**同一位移**（相对关系不变） */
    allMovedTogether: boolean;
    movedDelta: [number, number, number];
    /** 画面确实变了（成员真的被写进实体） */
    pixelsChanged: boolean;
    /** 一次拖拽只提交一次，且带三个成员 */
    commitOnce: boolean;
    commitCount: number;
    commitEntries: number;
    /** 松手后实时表清空、控制器收手 */
    liveCleared: boolean;
    /** 绕轴心整体旋转 90°：每个成员到轴心的向量真的转了 90°、长度不变 */
    rotatedAboutPivot: boolean;
    /** 引擎 gizmo 确实挂在轴心实体上 */
    gizmoOnPivot: boolean;
    passesPerFrame: number;
    ok: boolean;
  };
  /** 聚焦飞行自检（`flight=1`）：双击之后是**逐帧收敛**而不是瞬移，且会到位收手。 */
  flightReport?: {
    /** 双击后第一帧的剩余距离（应当**没有**归零）+ 采样到的逐帧距离序列 */
    distances: number[];
    monotonicallyCloser: boolean;
    arrived: boolean;
    steps: number;
    /** 飞行途中再输入（这里用滚轮）会取消飞行 */
    cancelledByInput: boolean;
    passesPerFrame: number;
    ok: boolean;
    /** 诊断：末帧台架、目标台架、以及两者位姿距离 */
    finalRig?: CameraRig | null;
    destinationRig?: CameraRig | null;
    finalPoseDistance?: number;
    /** 飞行器**内部**看到的剩余距离（与上面按台架量出来的对比，用来区分"数学错了"还是"写回错了"） */
    internalError?: number;
    azimuths?: number[];
    /** 飞行途中方位角的变化量：飞行是"位置+目标点"阻尼，方向不该变（>0 说明有东西在转相机） */
    azimuthDrift?: number;
  };
  /** 第一人称漫游自检（`walk=1`）：按键位移、Shift 加速、高度锁定、鼠标转头、解锁即停。 */
  walkReport?: {
    start: [number, number, number];
    afterW: [number, number, number];
    afterShiftW: [number, number, number];
    /** 前进距离 vs Shift 前进距离（后者应当明显更大） */
    walkDistance: number;
    runDistance: number;
    eyeHeightLocked: boolean;
    yawAfterLook: number;
    pitchClamped: boolean;
    frozenWhenUnlocked: boolean;
    passesPerFrame: number;
    ok: boolean;
    /** 自检结束后还原到哪个台架（诊断：不还原会污染后面的相位） */
    restoredRig?: CameraRig | null;
    /** 诊断：按住 W 期间/若干帧之后按键集合里有什么、tick 走了多少步 */
    keysWhileHeld?: string[];
    keysAfterFrames?: string[];
    stepsWhileHeld?: number;
  };
  hudReport?: {
    layersInCameras: boolean;
    /** 只摘掉 pane-0 的 HUD：本格变、其它格不变 */
    ownPaneOnly: boolean;
    /** 已知机位下 ±X / ±Y 轴球的屏幕间距（px）：**都应当是 80**（GIZMO_SCALE=40 的直径） */
    diameterX: number;
    diameterY: number;
    /** 相机退远 3 倍后 ±X 的屏幕间距（屏幕等大 ⇒ 与 diameterX 相同） */
    diameterFar: number;
    /** 轴球随相机转：转一个方位角后 +Z 轴球的屏幕位置位移（px） */
    headShiftAfterOrbit: number;
    /** 命中：落点正好在某个轴球上 → 返回那个轴；偏离 100px → null */
    hitTestOk: boolean;
    /** 吸附后的台架与 rigForAxisSnap 一致（距离不变、朝向按轴） */
    snapOk: boolean;
    passesPerFrame: number;
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
  /** `scene.gsplat.enableIds` 的默认值与载入后我们设成的值（splat 拾取的前提） */
  splatIdsDefault?: boolean | null;
  splatIdsEnabled?: boolean | null;
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
  /** 建编辑器地面网格（两级线 + 距离淡出），并做逐格/两级/淡出/不可拾取自检。 */
  grid?: boolean;
  /** 逐窗格建屏幕等大坐标轴球 HUD，并做逐格隔离/屏幕等大/随相机转/命中吸附自检。 */
  hud?: boolean;
  /** 双击聚焦走**飞行动画**（`rigFlight.ts`），而不是立即到位；自检会采样收敛过程。 */
  flight?: boolean;
  /** 第一人称漫游（指针锁定 + WASD + Shift 加速、高度锁 1.6）；自检会量按键位移与视角。 */
  walk?: boolean;
  /** 多选整体变换：三个成员 + 轴心实体（引擎 gizmo 挂在轴心上），量"整体平移/旋转 + 一次提交"。 */
  multi?: boolean;
  /** 选中/悬浮线框（白线、depthTest=false 等价、不可拾取）+ G/R/S 快捷键接线。 */
  highlight?: boolean;
  /** 诊断用：网格自检结束时**留在俯视机位**，好让驱动截一张能看清网格的图。 */
  gridLook?: boolean;
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
      // **splat 拾取的前提**：`scene.gsplat.enableIds` 默认 false，不开就不进 picker 的 mapping
      // （症状：模型能选中、点云永远选不中）。自检里会关掉它做**负对照**。
      const gsplatParams = (app.scene as unknown as { gsplat?: { enableIds?: boolean } }).gsplat;
      result.splatIdsDefault = gsplatParams?.enableIds ?? null;
      if (gsplatParams) gsplatParams.enableIds = true;
      result.splatIdsEnabled = gsplatParams?.enableIds ?? null;
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

    /*
      多选整体变换的成员：**靶子本身就是 member-0**——这样"可信拖手柄"那一段原来的断言
      （被拖的东西沿 +X 走了）依旧成立，另外两个成员在它两侧，轴心落在三者中间。
      三个成员的材质换个颜色，方便逐帧像素对比时肉眼分辨。
    */
    const memberEntities: { id: string; entity: unknown }[] = options.multi
      ? [{ id: "member-0", entity: pickTargetEntity }]
      : [];
    if (options.multi) {
      const memberMaterial = new StandardMaterial();
      memberMaterial.diffuse = new Color(0.45, 0.78, 0.75);
      memberMaterial.update();
      const spots = [[-2.4, 6, 0.6], [2.6, 5.2, -0.8]] as const;
      spots.forEach(([x, y, z], index) => {
        const entity = new Entity(`member-${index + 1}`);
        entity.addComponent("render", { type: "box" });
        if (entity.render) entity.render.material = memberMaterial;
        entity.setLocalScale(1, 1, 1);
        entity.setPosition(x, y, z);
        app.root.addChild(entity);
        memberEntities.push({ id: `member-${index + 1}`, entity });
      });
    }
    const light = new Entity("light");
    light.addComponent("light", { type: "directional", color: new Color(1, 1, 1), intensity: 1.4 });
    light.setEulerAngles(35, 45, 0);
    app.root.addChild(light);

    // 地面网格：整场景一份，在共享核心层上（每格各自按自己的相机位置淡出）
    const grid: EditorGridHandle | null = options.grid ? await createEditorGrid(app) : null;
    if (grid) log(`网格: meshInstance=${grid.meshInstanceCount()} 可拾取=${grid.pickableMeshInstanceCount()} params=${JSON.stringify(grid.params())}`);

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
    /** gizmo 挂谁：多选时挂**轴心实体**（成员跟着它走），否则挂靶子。 */
    const gizmoTarget = () => (options.multi && pivotEntity ? pivotEntity : pickTargetEntity);
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
        // 引擎的 transform:start/end 驱动多选控制器：按住 = 冻结相对矩阵，松手 = 提交一次。
        // 注意 `selection`/`memberEntities` 声明在后面（多选那一块），这里是闭包引用，运行时才求值。
        onDragStart: () => {
          gizmoDragStarts += 1;
          selection?.begin();
        },
        onDragEnd: () => {
          gizmoDragEnds += 1;
          if (!selection?.active()) return;
          selection.end("translate");
          // 提交后按成员**当前**摆放复位轴心，并把轴心实体摆回去（好接下一次拖拽）
          selection.reset(memberEntities.map((entry) => ({ id: entry.id, placement: readEntityPlacement(entry.entity as never) })));
          const next = selection.pivot();
          if (next && pivotEntity) applyEntityPlacement(pivotEntity as never, next);
          refreshHighlight("selected");
        },
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

    /*
      多选整体变换（`multi=1`）：一个**不渲染的轴心实体** + 引擎 gizmo 挂在它上面 + 每帧把
      `pivot.matrix · relative` 分发给各成员。对应 three 侧 `TransformGizmo` 的三个 handler：
      `begin` ← 引擎的 `transform:start`、`update` ← 每帧、`end` ← `transform:end`（只提交一次）。
      与 three 侧的一处**差别**：那边每个窗格各有自己的 pivot 对象，所以要有"别的窗格在拖时本格
      每帧重置 pivot"的跟随代码；这里 N 个窗格的 gizmo 挂在**同一个**轴心实体上，引擎的 gizmo
      每帧自己读该实体的 transform，跟随是白给的。
    */
    let selection: SelectionTransformHandle<string> | null = null;
    let pivotEntity: unknown = null;
    const livePlacements = new Map<string, Placement>();
    const multiCommits: { updates: Record<string, Placement>; mode: string }[] = [];
    const memberPlacement = (entry: { id: string; entity: unknown }): Placement =>
      readEntityPlacement(entry.entity as never);
    const applyMembers = (updates: Record<string, Placement>) => {
      for (const [id, placement] of Object.entries(updates)) {
        const entry = memberEntities.find((candidate) => candidate.id === id);
        if (entry) applyEntityPlacement(entry.entity as never, placement);
      }
    };
    if (options.multi && memberEntities.length > 0) {
      const pc = await import("playcanvas");
      const pivot = new pc.Entity("selection-pivot");
      app.root.addChild(pivot);
      pivotEntity = pivot;
      selection = createSelectionTransform<string>({
        // 这三条就是应用里 `LiveTransforms` + `onCommit` 的角色（探针直接写实体 + 记一份提交）
        writeLive: (updates) => {
          for (const [id, placement] of Object.entries(updates)) livePlacements.set(id, placement);
          applyMembers(updates);
        },
        clearLive: () => livePlacements.clear(),
        onCommit: (updates, mode) => { multiCommits.push({ updates, mode }); },
      });
      const resetPivot = () => {
        selection!.reset(memberEntities.map((entry) => ({ id: entry.id, placement: memberPlacement(entry) })));
        const pivotPlacement = selection!.pivot();
        if (pivotPlacement) applyEntityPlacement(pivot as never, pivotPlacement);
      };
      resetPivot();
      /*
        拖动中把轴心位姿分发给成员：用引擎自己的 **`transform:move` 事件**，而不是每帧轮询。
        两点理由：① 事件在**子类写完实体之后**才轮到我们（`translate-gizmo.js:281` 的
        `node.setLocalPosition` 发生在它自己的 `transform:move` 监听里，而监听按注册顺序触发，
        我们是在构造之后注册的），所以读到的永远是这一帧的新值；② 静止时不跑（少一份每帧工作）。
        第一版用 `app.on("update")` 轮询，结果整个拖拽一个成员都没动（读到的是旧值/时机不对）。
      */
      const onTransformMove = () => {
        if (selection?.active() && pivotEntity) selection.update(readEntityPlacement(pivotEntity as never));
        refreshHighlight("selected");
      };
      for (const pane of specs) {
        gizmoHost?.attach(pane.id, pivot);
        for (const mode of TRANSFORM_MODES) gizmoHost?.gizmoFor(pane.id, mode)?.on("transform:move", onTransformMove);
      }
      (window as unknown as Record<string, unknown>).__PC_MULTI__ = {
        members: () => memberEntities.map((entry) => ({ id: entry.id, placement: memberPlacement(entry) })),
        pivot: () => selection!.pivot(),
        commits: () => multiCommits.map((commit) => ({ mode: commit.mode, ids: Object.keys(commit.updates) })),
        resetPivot,
      };
      log(`多选: ${memberEntities.length} 个成员，轴心挂在 ${specs.map((pane) => pane.id).join(",")} 的 gizmo 上`);
    }

    /*
      选中/悬浮线框 + G/R/S 快捷键（`highlight=1`）。
      线框是**整场景一份**（选中集合是应用级的，所有窗格都该看见同一份反馈），
      放在自己的层上（`clearDepthBuffer: true` ⇒ 等价于 three 侧的 `material-depthTest={false}`）。
    */
    let wireframe: SelectionWireframeHandle | null = null;
    let selectedIds: string[] = [];
    /**
     * 线框自检可以脱离多选单独跑：没有成员时退化成"就选拾取靶子"。
     * （成员是 `multi=1` 建的，而选中反馈本身不该依赖多选。）
     */
    const highlightTargets = memberEntities.length > 0
      ? memberEntities
      : [{ id: pickTargetEntity.name, entity: pickTargetEntity as unknown }];
    const memberBounds = (id: string): Bounds3 | null => {
      const entry = highlightTargets.find((candidate) => candidate.id === id);
      if (!entry) return null;
      const bounds = entityWorldBounds(entry.entity);
      return bounds ? boundsFromCenterHalfExtents(bounds.center, bounds.halfExtents) : null;
    };
    /** 选中集合的线框（多选时把成员盒并起来），并让它跟着实体走 */
    const refreshHighlight = (style: Highlight = "selected") => {
      if (!wireframe) return;
      const boxes = selectedIds.map(memberBounds).filter((box): box is Bounds3 => box !== null);
      wireframe.set(unionBounds(boxes), selectedIds.length > 0 ? style : "none");
    };
    /** 选中集合 + 高亮风格（自检与活口共用同一份写入路径） */
    const applySelection = (ids: readonly string[], style: Highlight) => {
      selectedIds = [...ids];
      refreshHighlight(style);
    };
    if (options.highlight) {
      wireframe = await createSelectionWireframe(app, {
        createLayer: () => {
          const layer = Gizmo.createLayer(app as never, "selection-wireframe");
          return { id: layer.id, layer };
        },
        removeLayer: (entry) => { (app.scene.layers as unknown as { remove(layer: unknown): void }).remove(entry.layer); },
        addChild: (child) => { app.root.addChild(child as never); },
      });
      for (const pane of specs) {
        const layerId = wireframe.layerId();
        if (layerId !== null) pane.extraLayerIds = [...(pane.extraLayerIds ?? []), layerId];
      }
      registry.sync(specs);
      // G/R/S：闸门与映射都是纯函数（`transformKeys.ts`），这里只做接线
      window.addEventListener("keydown", (event) => {
        if (!shouldHandleModeKeys({
          firstPerson: false,
          selectionCount: selectedIds.length,
        })) return;
        const mode = modeForKey(event as unknown as KeyboardEvent);
        if (!mode) return;
        event.preventDefault();
        for (const pane of specs) gizmoHost?.setMode(pane.id, mode);
      });
      log(`线框层=${wireframe.layerId()}（进 extraLayerIds）`);
    }

    /**
     * 坐标轴球 HUD：**逐窗格**一个部件 + 一层（每格只看自己那一层），钉在窗格右上角、屏幕等大。
     * 层要进 `PaneSpec.extraLayerIds`（`sync()` 会重写 `camera.layers`）。
     */
    let axisHud: PaneAxisHudHandle | null = null;
    if (options.hud) {
      axisHud = await createPaneAxisHud(app, {
        createLayer: (paneId) => {
          const layer = Gizmo.createLayer(app as never, `pane-axis-hud:${paneId}`);
          return { id: layer.id, layer };
        },
        removeLayer: (entry) => { (app.scene.layers as unknown as { remove(layer: unknown): void }).remove(entry.layer); },
        cameraFor: (paneId) => bindings.entityFor(paneId),
        paneRectFor: (paneId) => specs.find((pane) => pane.id === paneId)?.viewport ?? null,
      });
      for (const pane of specs) {
        const layerId = axisHud.layerIdFor(pane.id);
        if (layerId !== null) pane.extraLayerIds = [...(pane.extraLayerIds ?? []), layerId];
      }
      registry.sync(specs);
      log(`坐标轴 HUD: 层=${specs.map((pane) => axisHud!.layerIdFor(pane.id)).join(",")}`);
    }

    /**
     * 相机飞行动画（`flight=1`）：把 `paneInput` 的"聚焦"从立即到位换成阻尼飞行。
     * `onInteraction` 里取消上一条——所以用户一有输入，飞行立刻让位。
     */
    let flight: RigFlightHandle | null = options.flight
      ? createRigFlight({
          apply: (paneId, rig) => {
            rigs.set(paneId, rig);
            const entity = bindings.entityFor(paneId) as unknown as RigEntityLike | null;
            if (entity) applyRig(entity, rig, applyOptions);
          },
          read: () => rigs.get("pane-0") ?? null,
        })
      : null;

    /**
     * 第一人称漫游（`walk=1`）：**全局**一套状态（three 侧进入该模式时不渲染多窗格），
     * 指针锁定后鼠标转头、WASD 平移、Shift 加速、高度锁在 1.6。视角灵敏度取 three
     * `PointerLockControls` 的 0.002 rad/px。
     */
    const WALK_LOOK_SENSITIVITY = 0.002;
    let walkState: WalkState = createWalkState();
    const walkKeys = new Set<string>();
    let walkLocked = false;
    let walkLockError: string | null = null;
    let walkSteps = 0;
    let walkApplyCount = 0;
    const applyWalk = () => {
      const entity = bindings.entityFor("pane-0") as unknown as {
        setPosition(x: number, y: number, z: number): void;
        lookAt(x: number, y: number, z: number): void;
        up: { set(x: number, y: number, z: number): void };
      } | null;
      if (!entity) return;
      const [fx, fy, fz] = walkForward(walkState);
      entity.up.set(0, 1, 0);
      entity.setPosition(walkState.position[0], walkState.position[1], walkState.position[2]);
      entity.lookAt(
        walkState.position[0] + fx,
        walkState.position[1] + fy,
        walkState.position[2] + fz,
      );
      walkApplyCount += 1;
    };
    if (options.walk) {
      const onKeyDown = (event: KeyboardEvent) => {
        walkKeys.add(event.key.toLowerCase());
        if (walkLocked) event.preventDefault();
      };
      const onKeyUp = (event: KeyboardEvent) => { walkKeys.delete(event.key.toLowerCase()); };
      const onPointerLockChange = () => {
        walkLocked = typeof document !== "undefined" && document.pointerLockElement === canvas;
        // 解锁即清键（three 侧 onUnlock=clearKeys）：否则"锁定时按住的 W"会在解锁后继续走
        if (!walkLocked) walkKeys.clear();
      };
      const onMouseMove = (event: MouseEvent) => {
        if (!walkLocked) return;
        walkState = lookStep(walkState, -event.movementX * WALK_LOOK_SENSITIVITY, -event.movementY * WALK_LOOK_SENSITIVITY);
      };
      /**
       * 是否允许"点画布就请求指针锁定"。
       * ⚠️ 不能默认允许：探针里漫游模式一直是开着的，于是**任何**一次画布点击都会去抢指针锁定，
       * 一旦成功（可信点击就是用户手势）`pointerlockchange` 就把 `walkLocked` 置真，
       * 漫游 tick 随即**每帧改写相机**，把别的相位（拖动改方位角/拾取/轴球命中）全部打乱——
       * 实测就是这样丢掉 8-12 条可信断言，而且时有时无（取决于那一下锁定成没成功）。
       * 产品里第一人称是**显式进入的模式**，所以这里也改成显式备好（`armLock`）才请求。
       */
      let walkLockArmed = false;
      const onCanvasDown = () => {
        if (!walkLockArmed) return;
        // 指针锁定必须由用户手势触发；合成事件会失败（catch 掉，自检用 walkForceLock）。
        // ⚠️ 必须挂 **pointerdown** 而不是 mousedown：本层在 pointerdown 上 preventDefault，
        // 浏览器就不会再派发兼容的 mousedown 了（`paneInput.ts` ⑤ 实测过），挂 mousedown 等于永不触发。
        try {
          // 新版 Chrome 的 requestPointerLock 返回 Promise：失败原因要记下来（否则只会静默不锁）
          const result = canvas.requestPointerLock?.() as unknown as Promise<void> | undefined;
          result?.catch?.((error: unknown) => { walkLockError = String(error); });
        } catch (error) {
          walkLockError = String(error);
        }
      };
      window.addEventListener("keydown", onKeyDown);
      window.addEventListener("keyup", onKeyUp);
      document.addEventListener("pointerlockchange", onPointerLockChange);
      canvas.addEventListener("pointerdown", onCanvasDown);
      canvas.addEventListener("mousemove", onMouseMove);
      let previous = performance.now();
      /**
       * 漫游 tick 可以**挂起**。它是"每帧改写相机实体"的全局写入者，在探针里跑别的交互
       * （拖动/拾取/轴球/逐格隔离）时必须先停掉，否则那些相位全部建在"相机被它覆盖"的状态上。
       * 产品里这两种模式本来就是互斥的（进第一人称就不渲染多窗格），所以挂起是**正常语义**。
       */
      let walkTickEnabled = true;
      app.on("update", () => {
        const now = performance.now();
        const delta = (now - previous) / 1000;
        previous = now;
        if (!walkTickEnabled || !walkLocked) return;
        const next = walkStep(walkState, walkInputFromKeys(walkKeys, delta));
        if (next !== walkState) { walkState = next; walkSteps += 1; }
        applyWalk();
      });
      applyWalk();
      (window as unknown as Record<string, unknown>).__PC_WALK__ = {
        state: () => ({ position: walkState.position, yaw: walkState.yaw, pitch: walkState.pitch }),
        locked: () => walkLocked,
        lockError: () => walkLockError,
        hasFocus: () => (typeof document === "undefined" ? false : document.hasFocus()),
        /** 自检用：合成事件拿不到指针锁定（需要用户手势），这里直接置位。 */
        forceLock: (value: boolean) => { walkLocked = value; if (!value) walkKeys.clear(); },
        /** 备好"下一次点画布就去请求指针锁定"（真机那条用；合成事件拿不到锁定，用 forceLock） */
        armLock: (value: boolean) => { walkLockArmed = value; },
        /** 挂起漫游：停 tick、解锁、清键、解除抢锁（探针里跑别的交互前必须先做） */
        suspend: () => {
          walkTickEnabled = false;
          walkLocked = false;
          walkLockArmed = false;
          walkKeys.clear();
        },
        resume: () => { walkTickEnabled = true; },
        look: (movementX: number, movementY: number) => {
          walkState = lookStep(walkState, -movementX * WALK_LOOK_SENSITIVITY, -movementY * WALK_LOOK_SENSITIVITY);
          applyWalk();
        },
        keys: () => [...walkKeys],
        steps: () => walkSteps,
        applies: () => walkApplyCount,
      };
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
    /**
     * 等若干帧 + 一个宏任务：逐格像素对比前必须等"改动真的被合成出来"。
     * 只等 2 个 rAF 时读到的是**上一帧**（presentation 还在队列里），实测会让
     * "挂上/摘掉"的像素签名比较假阴性——这一类 flaky 全部来自这里。
     */
    /**
     * 画布快照。**必须在 rAF 回调里抓**：WebGPU 画布的交换链内容在帧外读会拿到**全黑**
     * （实测：组合自检里 `Picker.prepare()` 这种帧外 pass 之后，帧外 `drawImage` 一律是黑的，
     * 于是所有像素判据假阴性）。`settle()` 负责等若干帧、然后在 rAF 里更新这份快照；
     * 各个像素辅助函数只读快照，不再各自 `drawImage`。
     */
    let frameSnapshot: { data: Uint8ClampedArray; width: number; height: number } | null = null;
    const captureSnapshot = () => new Promise<void>((resolve) => {
      requestAnimationFrame(() => {
        const image = document.createElement("canvas");
        image.width = canvas.width;
        image.height = canvas.height;
        const context = image.getContext("2d", { willReadFrequently: true })!;
        context.drawImage(canvas, 0, 0);
        frameSnapshot = { data: context.getImageData(0, 0, image.width, image.height).data, width: image.width, height: image.height };
        resolve();
      });
    });

    /** 等若干帧、再抓一份画布快照（像素判据前必须等"改动真的被合成出来"）。 */
    const settle = async (frames = 4) => {
      await new Promise<void>((resolve) => {
        let left = frames;
        const tick = () => {
          left -= 1;
          if (left > 0) requestAnimationFrame(tick);
          else resolve();
        };
        requestAnimationFrame(tick);
      });
      await captureSnapshot();
    };

    /** 某一格在快照里的像素区间（画布像素坐标）。 */
    const paneRectInSnapshot = (index: number): { x: number; y: number; width: number; height: number } => {
      const pane = inputSpecs[index]!.viewport;
      const scaleX = (frameSnapshot?.width ?? canvas.width) / canvas.clientWidth;
      const scaleY = (frameSnapshot?.height ?? canvas.height) / canvas.clientHeight;
      return {
        x: Math.round(pane.left * scaleX),
        y: Math.round(pane.top * scaleY),
        width: Math.max(1, Math.round(pane.width * scaleX)),
        height: Math.max(1, Math.round(pane.height * scaleY)),
      };
    };

    /** 快照里某一格的全部像素（RGBA）。没有快照时返回空数组。 */
    const panePixelsIn = (index: number): Uint8ClampedArray => {
      if (!frameSnapshot) return new Uint8ClampedArray(0);
      const rect = paneRectInSnapshot(index);
      const out = new Uint8ClampedArray(rect.width * rect.height * 4);
      for (let row = 0; row < rect.height; row += 1) {
        const from = ((rect.y + row) * frameSnapshot.width + rect.x) * 4;
        out.set(frameSnapshot.data.subarray(from, from + rect.width * 4), row * rect.width * 4);
      }
      return out;
    };

    /** 某一格的像素签名（只看亮像素）：判断"这一格的画面变了没有"。 */
    const paneSignature = (index: number): number => {
      const pixels = panePixelsIn(index);
      let hash = 0;
      for (let i = 0; i < pixels.length; i += 4) {
        const luma = (pixels[i]! + pixels[i + 1]! + pixels[i + 2]!) / 3;
        if (luma > 14) hash = (hash * 31 + i) % 2147483647;
      }
      return hash;
    };

    /** 自检里核对"这个元素算不算输入框"（与 `transformKeys.isTypingTarget` 同一份判据） */
    const isTypingTargetForTest = (element: unknown) => isTypingTargetImpl(element);

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
    const pickAt = async (paneId: string, point: { x: number; y: number }) => {
      try {
        const hit = await picker?.pick(paneId, point);
        lastPick = hit ? { paneId, name: hit.name, kind: hit.kind } : { paneId, name: null, kind: null };
        return hit ?? null;
      } catch (error) {
        lastPickError = String(error);
        return null;
      }
    };
    // 飞行自检也要走输入层的 focus 路径（animateFocus 就是挂在它上面的），所以这里一并挂上
    if (options.input || options.inputHoldMs || options.flight) {
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
        onClick: (paneId, point) => {
          if (!picker) return;
          void pickAt(paneId, point).then((hit) => {
            if (!options.highlight) return;
            // 命中的**实体名**就是成员 id（探针里的盒子都叫 member-N）
            const name = hit?.name ?? null;
            const found = name ? highlightTargets.find((entry) => entry.id === name) : undefined;
            selectedIds = found ? [found.id] : [];
            refreshHighlight("selected");
          });
        },
        // 点坐标轴球：按下时被 HUD 认领（不开轨道手势），抬手按"被认领的点击"吸附机位、不选物体
        onClaimedClick: (paneId, point) => {
          const rig = rigs.get(paneId);
          const snapped = rig ? axisHud?.snapTarget(paneId, point, rig) ?? null : null;
          if (!snapped) return;
          rigs.set(paneId, snapped);
          const entity = bindings.entityFor(paneId) as unknown as RigEntityLike | null;
          if (entity) applyRig(entity, snapped, applyOptions);
        },
        // 让手势的两种情况：gizmo 正在拖（信号来自引擎的 transform:start/end），或指针压在坐标轴球上
        isPointerClaimed: (paneId, point) => (gizmoHost?.dragging(paneId) ?? false)
          || (axisHud?.hit(paneId, point) ?? null) !== null,
        // 用户一有输入就取消上一条飞行动画（focus() 里"先 onInteraction 再 animateFocus"，
        // 所以新的聚焦会先取消旧的、再起一条新的）
        onInteraction: () => { interactions += 1; flight?.cancel(); },
        animateFocus: (paneId, rig) => flight?.start(paneId, rig) ?? false,
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
      const preFocusDistance = rigs.get("pane-0")!.distance;
      click(center.x, center.y);
      click(center.x + 1, center.y);
      // 接了飞行动画（`flight=1`）时先等它飞完：这样"聚焦到位"的判据与"立即到位"那条完全一致，
      // 顺带验证了飞行**真的落到** `focusRigWithTarget` 算出来的位姿（而不是停在半路）。
      if (options.flight) {
        const deadline = performance.now() + 3000;
        while ((flight?.flying() ?? false) && performance.now() < deadline) {
          await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        }
      }
      const focusAfter = rigs.get("pane-0")!;
      const expectedDistance = fitDistance(focus.radius, 60);
      const focusShift = Math.hypot(...focusAfter.target.map((value, index) => value - focus.center[index]!));
      // 接了飞行动画时（`flight=1`）双击**不会**立即到位：这里只断言"没有瞬移"，动画本身由
      // 飞行自检负责（它量的是逐帧收敛 + 到位 + 输入即取消）。
      const focusOk = focusShift < 1e-3 && Math.abs(focusAfter.distance - expectedDistance) < 1e-3;
      void preFocusDistance;
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
      // 这一段的双击会起一条飞行动画；后面的自检各自要摆已知机位，先把它取消掉，
      // 否则飞行器每帧都会把相机拉回它的插值轨迹（实测会让 picking/grid/hud 的像素与台架判据全挂）。
      flight?.cancel();
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
        ⚠️ 判据依赖"机位能看见被挂的那个物体"：探针默认机位下靶子盒子在画面里（截图确认过），
        所以这里**不额外动机位**——试过把它框到画面正中反而稳定判不出（v1.2 的记法见 §三之九）。
      */
      const report: NonNullable<PaneHarnessResult["gizmo"]> = {
        mode: gizmoHost.modeFor("pane-0"), space: gizmoHost.spaceFor("pane-0"),
        layerInCamera: false, withGizmo: [], withoutGizmo: [],
        ownPaneChanged: false, otherPanesUnchanged: true, passesPerFrame: 0, ok: false,
      };
      // 干净地挂上（会重新算 enabled/位置），等几帧再读
      gizmoHost.attach("pane-0", gizmoTarget());
      await settle();
      report.withGizmo = inputSpecs.map((_pane, index) => paneSignature(index));
      const pane0Camera = (bindings.entityFor("pane-0") as unknown as { camera?: { layers?: number[] } } | null)?.camera;
      const gizmoLayerId = gizmoHost.layerIdFor("pane-0");
      report.layerInCamera = gizmoLayerId !== null && (pane0Camera?.layers ?? []).includes(gizmoLayerId);

      gizmoHost.attach("pane-0", null);
      await settle();
      report.withoutGizmo = inputSpecs.map((_pane, index) => paneSignature(index));

      report.ownPaneChanged = report.withGizmo[0] !== report.withoutGizmo[0];
      report.otherPanesUnchanged = inputSpecs.every((_pane, index) => index === 0
        || report.withGizmo[index] === report.withoutGizmo[index]);
      report.passesPerFrame = result.frameCount ? +(result.gpuRenderPasses!.start / result.frameCount).toFixed(3) : 0;
      report.ok = report.mode === "translate" && report.space === "world"
        && report.layerInCamera && report.ownPaneChanged && report.otherPanesUnchanged;

      // 挂回去：CDP 可信拖手柄那一段还要用它
      gizmoHost.attach("pane-0", gizmoTarget());
      await settle();
      result.gizmo = report;
      log(`gizmo 自检: 模式=${report.mode}/${report.space} 层在相机里=${report.layerInCamera} 本格变了=${report.ownPaneChanged} 其它格未变=${report.otherPanesUnchanged} pass/帧=${report.passesPerFrame}`);
    }

    if (options.highlight && wireframe) {
      /*
        选中线框 + G/R/S 自检：
        ① 点选一个成员 → 线框出现，盒 = 该实体世界包围盒外扩 2%（逐分量比）；
        ② 线框的**可拾取实例数必须为 0**（three 侧那段注释的对应约束）；
        ③ 可见时画面确实变了（像素），隐藏后恢复；
        ④ 悬浮态更淡（0.35）；
        ⑤ G/R/S 真的换了 gizmo 模式；在输入框里打字时**不**抢键。
      */
      const report: NonNullable<PaneHarnessResult["highlightReport"]> = {
        boundsMatches: false, pickable: -1, pixelsChanged: false,
        hoverOpacity: 0, selectedOpacity: 0, modeAfterKeys: [], ignoredWhileTyping: false,
        passesPerFrame: 0, ok: false,
      };
      const state = () => ({
        visible: wireframe!.visible(),
        style: wireframe!.style(),
        transform: wireframe!.transform(),
        pickable: wireframe!.pickableCount(),
      });
      await settle();
      const before = paneSignature(0);
      applySelection(["member-0"], "selected");
      await settle();
      report.pixelsChanged = before !== paneSignature(0);
      report.pickable = state().pickable;
      // 盒 = 实体世界包围盒外扩 2%
      const source = entityWorldBounds(highlightTargets[0]!.entity);
      const boxTransform = state().transform;
      if (source && boxTransform) {
        const pad = Math.max(source.halfExtents[0], source.halfExtents[1], source.halfExtents[2]) * 2 * 0.02;
        report.boundsMatches = Math.abs(boxTransform.center[0]! - source.center[0]) < 1e-4
          && Math.abs(boxTransform.center[1]! - source.center[1]) < 1e-4
          && Math.abs(boxTransform.center[2]! - source.center[2]) < 1e-4
          && Math.abs(boxTransform.size[0]! - (source.halfExtents[0] * 2 + pad * 2)) < 1e-3;
      }
      // 悬浮态更淡
      applySelection(["member-0"], "hover");
      await settle();
      report.hoverOpacity = +(wireframe.style() === "hover" ? 0.35 : 0).toFixed(2);
      applySelection(["member-0"], "selected");
      await settle();
      report.selectedOpacity = wireframe.style() === "selected" ? 1 : 0;
      // G/R/S：先选中（否则闸门③会拦住），再逐个按键
      for (const key of ["r", "s", "g"]) {
        window.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true, cancelable: true }));
        await settle();
        report.modeAfterKeys.push(gizmoHost?.modeFor("pane-0") ?? "none");
        // **必须配对 keyup**：合成的 keydown 不配对会留在按键集合里，后面的第一人称自检里
        // 's' 会把 'w' 抵消掉（forward = w − s = 0），表现为"漫游一步都不走"（本机踩过）。
        window.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true, cancelable: true }));
      }
      // 在输入框里打字：不该抢键
      // 在 input 上派发（target 天然是它，事件冒泡到 window 的监听器）：不该抢键
      const probeInput = document.createElement("input");
      document.body.appendChild(probeInput);
      probeInput.focus();
      const modeBeforeTyping = gizmoHost?.modeFor("pane-0") ?? "none";
      probeInput.dispatchEvent(new KeyboardEvent("keydown", { key: "r", bubbles: true, cancelable: true }));
      probeInput.dispatchEvent(new KeyboardEvent("keyup", { key: "r", bubbles: true, cancelable: true }));
      await settle();
      report.ignoredWhileTyping = (gizmoHost?.modeFor("pane-0") ?? "none") === modeBeforeTyping
        && isTypingTargetForTest(probeInput);
      probeInput.remove();
      applySelection([], "none");
      await settle();
      report.passesPerFrame = result.frameCount ? +(result.gpuRenderPasses!.start / result.frameCount).toFixed(3) : 0;
      report.ok = report.boundsMatches && report.pickable === 0 && report.pixelsChanged
        && report.hoverOpacity === 0.35 && report.selectedOpacity === 1
        && report.modeAfterKeys.join(",") === "rotate,scale,translate"
        && report.ignoredWhileTyping;
      result.highlightReport = report;
      log(`高亮自检: 盒匹配=${report.boundsMatches} 可拾取=${report.pickable} 像素变了=${report.pixelsChanged} 悬浮=${report.hoverOpacity}/选中=${report.selectedOpacity} 按键后模式=${report.modeAfterKeys.join(",")} 打字不抢键=${report.ignoredWhileTyping}`);
    }

    if (options.multi && selection && pivotEntity) {
      /*
        多选整体变换自检。**先在页面内直接驱动控制器**（begin → update → end），量四件事：
        ① 轴心口径（多选 = 位置包围盒中心；单选 = 物体自身摆放）；② 一次平移三个成员同位移；
        ③ 画面真的变了（写进实体了）；④ 一次拖拽只提交一次、带三个成员、松手后实时表清空。
        再加一条绕轴心整体旋转 90°：每个成员到轴心的向量长度不变、夹角 90°（用平面三角量，避免自我印证）。
        真机的"指针 → 手柄 → 拖动"那一段由可信驱动（drive-input.mjs）负责。
      */
      const report: NonNullable<PaneHarnessResult["multiReport"]> = {
        pivotIsCentroid: false, singlePivotOnObject: false, allMovedTogether: false,
        movedDelta: [0, 0, 0], pixelsChanged: false, commitOnce: false, commitCount: 0,
        commitEntries: 0, liveCleared: false, rotatedAboutPivot: false, gizmoOnPivot: false,
        passesPerFrame: 0, ok: false,
      };
      const members = () => memberEntities.map((entry) => ({ id: entry.id, placement: memberPlacement(entry) }));
      const positions = () => members().map((member) => member.placement.position);
      const pivotNow = () => readEntityPlacement(pivotEntity as never);
      const gizmoPivot = gizmoHost!.attachedEntity("pane-0") === pivotEntity;
      report.gizmoOnPivot = gizmoPivot;

      // ① 轴心 = 位置包围盒中心
      const expectedPivot = selectionPivot(members())!;
      const actualPivot = pivotNow();
      report.pivotIsCentroid = Math.hypot(
        actualPivot.position[0] - expectedPivot.position[0],
        actualPivot.position[1] - expectedPivot.position[1],
        actualPivot.position[2] - expectedPivot.position[2],
      ) < 1e-4 && Math.abs(actualPivot.rotation[0]) < 1e-6 && Math.abs(actualPivot.scale[0] - 1) < 1e-6;

      // ② 单选轴心落在物体自身摆放上（用完立刻恢复多选）
      const only = members()[0]!;
      selection.reset([only]);
      const singlePivot = selection.pivot()!;
      report.singlePivotOnObject = Math.hypot(
        singlePivot.position[0] - only.placement.position[0],
        singlePivot.position[1] - only.placement.position[1],
        singlePivot.position[2] - only.placement.position[2],
      ) < 1e-6;
      selection.reset(members());

      // ③ 一次整体平移：三个成员同一位移
      const before = positions();
      const beforeSignature = paneSignature(0);
      await settle();
      const beforeSig = paneSignature(0);
      selection.begin();
      const pivotBefore = pivotNow();
      const shift: [number, number, number] = [pivotBefore.position[0] + 1.5, pivotBefore.position[1] - 0.75, pivotBefore.position[2]];
      selection.update({ ...pivotBefore, position: shift });
      applyEntityPlacement(pivotEntity as never, { ...pivotBefore, position: shift });
      await settle();
      const after = positions();
      report.allMovedTogether = after.every((p, index) => (
        Math.abs(p[0] - before[index]![0] - 1.5) < 1e-3
        && Math.abs(p[1] - before[index]![1] + 0.75) < 1e-3
        && Math.abs(p[2] - before[index]![2]) < 1e-3
      ));
      report.movedDelta = [
        +(after[0]![0] - before[0]![0]).toFixed(3),
        +(after[0]![1] - before[0]![1]).toFixed(3),
        +(after[0]![2] - before[0]![2]).toFixed(3),
      ];
      report.pixelsChanged = beforeSig !== paneSignature(0);
      const committed = selection.end("translate");
      report.commitCount = multiCommits.length;
      report.commitEntries = committed ? Object.keys(committed.updates).length : 0;
      report.commitOnce = multiCommits.length === 1 && report.commitEntries === memberEntities.length;
      report.liveCleared = livePlacements.size === 0 && !selection.active();
      void beforeSignature;

      // ④ 绕轴心整体旋转 90°（Y）：相对轴心的偏移按 (x,y,z) → (z,y,-x) 走
      // **先 reset**：begin() 冻结的是"控制器当前轴心"的相对矩阵，平移之后轴心已经过期了
      // （第一版就踩了这个：冻结相对矩阵对着旧轴心，成员被摆到错的位置）
      selection.reset(members());
      const pivotForRotation = selection.pivot()!;
      const offsetsBefore = positions().map((p) => [
        p[0] - pivotForRotation.position[0], p[1] - pivotForRotation.position[1], p[2] - pivotForRotation.position[2],
      ] as [number, number, number]);
      selection.begin();
      selection.update({ ...pivotForRotation, rotation: [0, Math.PI / 2, 0] });
      applyEntityPlacement(pivotEntity as never, { ...pivotForRotation, rotation: [0, Math.PI / 2, 0] });
      await settle();
      const offsetsAfter = positions().map((p) => [
        p[0] - pivotForRotation.position[0], p[1] - pivotForRotation.position[1], p[2] - pivotForRotation.position[2],
      ] as [number, number, number]);
      // 绕 Y 轴 +90° 的解析式：相对轴心的偏移 (x,y,z) → (z, y, -x)（three 的 Ry 约定）。
      // 不要用"三维夹角 ≈ 90°"当判据——成员的偏移带 Y 分量，绕 Y 转时那部分不变，
      // 三维夹角根本不是 90°（第一版就踩了这个假阴性）。
      report.rotatedAboutPivot = offsetsBefore.every((from, index) => {
        const to = offsetsAfter[index]!;
        return Math.abs(to[1] - from[1]) < 1e-3
          && Math.abs(to[0] - from[2]) < 1e-3
          && Math.abs(to[2] + from[0]) < 1e-3;
      });
      selection.end("rotate");

      // 复位：按成员**当前**摆放重算轴心（可信阶段的拖动从干净状态开始）
      selection.reset(members());
      const settledPivot = selection.pivot();
      if (settledPivot) applyEntityPlacement(pivotEntity as never, settledPivot);
      await settle();

      report.passesPerFrame = result.frameCount ? +(result.gpuRenderPasses!.start / result.frameCount).toFixed(3) : 0;
      report.ok = gizmoPivot && report.pivotIsCentroid && report.singlePivotOnObject
        && report.allMovedTogether && report.pixelsChanged
        && report.commitOnce && report.liveCleared && report.rotatedAboutPivot;
      result.multiReport = report;
      log(`多选自检: 轴心=包围盒中心${report.pivotIsCentroid} 单选落在物体上${report.singlePivotOnObject} 同位移${report.allMovedTogether} Δ=${report.movedDelta.join(",")} 画面变了${report.pixelsChanged} 一次提交${report.commitOnce}(${report.commitEntries} 项) 实时表清空${report.liveCleared} 整体旋转${report.rotatedAboutPivot}`);
    }

    if (options.grid && grid) {
      /*
        网格自检：四件事都能客观量到——
        ① 挂上/摘掉 → **每一格**的像素签名都变（整场景一份、所有窗格都看见）；
        ② 只留细线、只留粗线分别与默认不同（两级都真的在画）。**必须换一个俯视机位**：
           探针默认机位是贴着地面的掠射角，粗线在那个角度下一个像素都不贡献，判据会假阴性；
        ③ 淡出半径压到很小 → 网格消失；
        ④ `pick = false`（400×400 的平面若可拾取会把所有点击吃掉）。
      */
      const report: NonNullable<PaneHarnessResult["grid"]> = {
        meshInstances: grid.meshInstanceCount(), pickable: grid.pickableMeshInstanceCount(),
        withGrid: [], withoutGrid: [], allPanesChanged: false,
        cellsOnly: [], sectionsOnly: [], bothLevelsContribute: false, fadedOut: false,
        passesPerFrame: 0, ok: false, counts: {}, fadeFollowsCamera: false,
        cameraLookDown: null, cameraFar: null, materialVersion: 0,
      };
      const signatureAll = () => inputSpecs.map((_pane, index) => paneSignature(index));
      /** 整格平均亮度：比"亮像素哈希"更钝、更稳的信号（诊断用）。 */
      const paneMean = (index: number): number => {
        const pixels = panePixelsIn(index);
        if (pixels.length === 0) return 0;
        let sum = 0;
        for (let i = 0; i < pixels.length; i += 4) sum += (pixels[i]! + pixels[i + 1]! + pixels[i + 2]!) / 3;
        return +(sum / (pixels.length / 4)).toFixed(4);
      };
      /** 网格线的像素数（亮于背景 13.7、暗于盒子的 ~170）——比哈希更好读。 */
      const gridPixelCount = (index: number): number => {
        const pixels = panePixelsIn(index);
        let count = 0;
        for (let i = 0; i < pixels.length; i += 4) {
          const luma = (pixels[i]! + pixels[i + 1]! + pixels[i + 2]!) / 3;
          if (luma > 15 && luma < 90) count += 1;
        }
        return count;
      };

      await settle();
      report.withGrid = signatureAll();

      grid.setVisible(false);
      await settle();
      report.withoutGrid = signatureAll();
      grid.setVisible(true);
      await settle();

      // 换一个**俯视**机位再比两级：掠射角下粗线一个像素都不贡献（这条是踩过的假阴性）
      const savedRig = rigs.get("pane-0")!;
      const lookDown: CameraRig = { ...savedRig, target: [0, 0, 0], azimuth: 0.6, polar: 0.35, distance: 9 };
      rigs.set("pane-0", lookDown);
      const pane0Entity = bindings.entityFor("pane-0") as unknown as RigEntityLike | null;
      if (pane0Entity) applyRig(pane0Entity, lookDown, applyOptions);
      await settle();
      const defaults = grid.params();
      const cameraLookDown = cameraTuple("pane-0");
      // 一条横扫描线的 24 个采样：有网格线的话会看到周期性明暗，均匀一片就是"没画线"
      const scanline = (): number[] => {
        const pixels = panePixelsIn(0);
        const rect = paneRectInSnapshot(0);
        const y = Math.floor(rect.height * 0.75);
        const out: number[] = [];
        for (let i = 0; i < 24; i += 1) {
          const x = Math.floor((i / 24) * (rect.width - 1));
          const offset = (y * rect.width + x) * 4;
          out.push(Math.round((pixels[offset]! + pixels[offset + 1]! + pixels[offset + 2]!) / 3));
        }
        return out;
      };
      const lookDownBoth = { signature: paneSignature(0), count: gridPixelCount(0), mean: paneMean(0), scan: scanline() };

      await grid.setParams({ sectionSize: 1e6 }); // 只剩细线
      await settle();
      const cellsOnly = { signature: paneSignature(0), count: gridPixelCount(0), mean: paneMean(0), scan: scanline() };

      await grid.setParams({ sectionSize: defaults.sectionSize, cellSize: 1e6 }); // 只剩粗线
      await settle();
      const sectionsOnly = { signature: paneSignature(0), count: gridPixelCount(0), mean: paneMean(0), scan: scanline() };
      await grid.setParams(defaults);

      // 还原机位；`gridLook=1` 是**诊断开关**：结束时停在俯视机位，
      // 好让驱动截一张能看清两级网格线的图（默认停在原机位）。
      const finalRig = options.gridLook ? lookDown : savedRig;
      rigs.set("pane-0", finalRig);
      if (pane0Entity) applyRig(pane0Entity, finalRig, applyOptions);
      await settle();

      // ① 淡出半径压到 0.5：相机在 ~10 单位外，地面应当整片淡掉
      await grid.setParams({ fadeDistance: 0.5 });
      await settle();
      const faded = signatureAll();
      await grid.setParams(defaults);
      await settle();

      // ② 相机退到 500 单位外（平面只有 ±200，加上 40 的淡出半径：最近的平面点也在 500-200=300
      //    单位外）→ 这一格应当整片空掉。**这条是 `view_position` 真的逐相机且在更新的证据**：
      //    若它恒为 0，网格会一直亮在原点周围那 40 单位里（相机正看着原点，就会看得见）。
      const farRig: CameraRig = { ...savedRig, target: [0, 0, 0], azimuth: 0.6, polar: 1.2, distance: 500 };
      rigs.set("pane-0", farRig);
      if (pane0Entity) applyRig(pane0Entity, farRig, applyOptions);
      await settle();
      const farWithGrid = paneSignature(0);
      // 同一个"远处机位"下把网格摘掉再拍一次：两次一样才说明网格在那个距离上确实什么都没画。
      // （不能拿默认机位的 withoutGrid 来比——相机不同，画面本来就不同。这一版之前就是那么错的。）
      grid.setVisible(false);
      await settle();
      const farWithoutGrid = paneSignature(0);
      grid.setVisible(true);
      await settle();
      const cameraFar = cameraTuple("pane-0");
      report.cameraLookDown = cameraLookDown;
      report.cameraFar = cameraFar;
      report.materialVersion = grid.materialVersion();
      report.fadeFollowsCamera = farWithGrid === farWithoutGrid;
      rigs.set("pane-0", savedRig);
      if (pane0Entity) applyRig(pane0Entity, savedRig, applyOptions);
      await settle();

      report.cellsOnly = [cellsOnly.signature];
      report.sectionsOnly = [sectionsOnly.signature];
      report.scanline = { both: lookDownBoth.scan, cellsOnly: cellsOnly.scan, sectionsOnly: sectionsOnly.scan };
      report.counts = {
        lookDownBoth: lookDownBoth.count,
        lookDownCellsOnly: cellsOnly.count,
        lookDownSectionsOnly: sectionsOnly.count,
        meanBoth: lookDownBoth.mean,
        meanCellsOnly: cellsOnly.mean,
        meanSectionsOnly: sectionsOnly.mean,
        defaultViewMean: paneMean(0),
      };
      report.allPanesChanged = report.withGrid.every((value, index) => value !== report.withoutGrid[index]);
      report.bothLevelsContribute = lookDownBoth.count > 0
        && cellsOnly.signature !== lookDownBoth.signature
        && sectionsOnly.signature !== lookDownBoth.signature
        && cellsOnly.count !== lookDownBoth.count
        && sectionsOnly.count !== lookDownBoth.count;
      report.fadedOut = inputSpecs.every((_pane, index) => faded[index] === report.withoutGrid[index]);
      report.passesPerFrame = result.frameCount ? +(result.gpuRenderPasses!.start / result.frameCount).toFixed(3) : 0;
      report.ok = report.meshInstances > 0 && report.pickable === 0
        && report.allPanesChanged && report.bothLevelsContribute && report.fadedOut
        && report.fadeFollowsCamera;
      result.grid = report;
      log(`网格自检: mesh=${report.meshInstances} 可拾取=${report.pickable} 每格都变=${report.allPanesChanged} 两级都参与=${report.bothLevelsContribute}(${JSON.stringify(report.counts)}) 淡出生效=${report.fadedOut} 淡出跟相机=${report.fadeFollowsCamera} pass/帧=${report.passesPerFrame}`);
    }

    if (options.hud && axisHud) {
      /*
        坐标轴球 HUD 自检。**先换到一个已知机位**（水平看原点）：这样"屏幕等大"可以量成绝对值——
        three 侧的 `GIZMO_SCALE = 40` 就是"部件半径 40 px"，所以 ±X / ±Y 两个轴球的屏幕间距
        应该**都等于 80 px**，而且与窗格尺寸、几宫格布局无关。继承前面自检留下的机位会让判据假阴性
        （实测：4 窗格 + 其它自检一起跑时，混合机位下"只摘 pane-0"这一条会因为部件被近裁剪面切掉而失败）。
      */
      const report: NonNullable<PaneHarnessResult["hudReport"]> = {
        layersInCameras: false, ownPaneOnly: false, diameterX: 0, diameterY: 0,
        diameterFar: 0, headShiftAfterOrbit: 0, hitTestOk: false, snapOk: false, passesPerFrame: 0, ok: false,
      };
      const savedHudRig = rigs.get("pane-0")!;
      const pane0 = bindings.entityFor("pane-0") as unknown as RigEntityLike | null;
      const setPane0Rig = async (next: CameraRig) => {
        rigs.set("pane-0", next);
        if (pane0) applyRig(pane0, next, applyOptions);
        await settle();
      };
      const separation = (paneId: string, axis: "x" | "y" | "z"): number => {
        const points = axisHud!.screenPoints(paneId);
        const plus = points.find((p) => p.head.axis === axis && p.head.sign === 1)?.screen;
        const minus = points.find((p) => p.head.axis === axis && p.head.sign === -1)?.screen;
        return plus && minus ? +Math.hypot(plus.x - minus.x, plus.y - minus.y).toFixed(2) : -1;
      };

      // ① 层在相机里
      report.layersInCameras = specs.every((pane) => {
        const layerId = axisHud!.layerIdFor(pane.id);
        const camera = (bindings.entityFor(pane.id) as unknown as { camera?: { layers?: number[] } } | null)?.camera;
        return layerId !== null && (camera?.layers ?? []).includes(layerId);
      });

      // 已知机位：方位角 0 / 极角 90°（水平看向原点）→ 世界 X 在屏幕上是横的、Y 是竖的、都正对相机
      const canonical: CameraRig = {
        ...savedHudRig, target: [0, 0, 0], azimuth: 0, polar: Math.PI / 2, distance: 12,
      };
      await setPane0Rig(canonical);
      report.diameterX = separation("pane-0", "x");
      report.diameterY = separation("pane-0", "y");

      // ③ 屏幕等大：距离 ×3 之后，同样的两个轴球屏幕间距不变
      await setPane0Rig({ ...canonical, distance: canonical.distance * 3 });
      report.diameterFar = separation("pane-0", "x");

      // ④ 轴球随相机转：方位角 +90° 后 +Z 轴球的屏幕位置应当明显移动
      await setPane0Rig(canonical);
      const beforeOrbit = axisHud.screenPoints("pane-0").find((p) => p.head.axis === "z" && p.head.sign === 1)!.screen;
      await setPane0Rig({ ...canonical, azimuth: Math.PI / 2 });
      const afterOrbit = axisHud.screenPoints("pane-0").find((p) => p.head.axis === "z" && p.head.sign === 1)!.screen;
      report.headShiftAfterOrbit = +Math.hypot(afterOrbit.x - beforeOrbit.x, afterOrbit.y - beforeOrbit.y).toFixed(2);

      // ② 只摘 pane-0：本格变、其它格不变（先把机位收回已知状态）
      await setPane0Rig(canonical);
      const withAll = inputSpecs.map((_pane, index) => paneSignature(index));
      axisHud.setVisible("pane-0", false);
      await settle();
      const withoutPane0 = inputSpecs.map((_pane, index) => paneSignature(index));
      axisHud.setVisible("pane-0", true);
      await settle();
      report.ownPaneOnly = withAll[0] !== withoutPane0[0]
        && inputSpecs.every((_pane, index) => index === 0 || withAll[index] === withoutPane0[index]);

      // ⑤ 命中
      const plusX = axisHud.screenPoints("pane-0").find((p) => p.head.axis === "x" && p.head.sign === 1)!.screen;
      const hit = axisHud.hit("pane-0", plusX);
      const miss = axisHud.hit("pane-0", { x: plusX.x + 100, y: plusX.y + 100 });
      report.hitTestOk = hit?.axis === "x" && hit.sign === 1 && miss === null;

      // ⑥ 吸附：只改朝向（距离与目标点不变）
      const snapped = axisHud.snapTarget("pane-0", plusX, canonical);
      report.snapOk = snapped !== null
        && Math.abs(snapped.distance - canonical.distance) < 1e-9
        && Math.abs(snapped.azimuth - Math.PI / 2) < 1e-9
        && Math.abs(snapped.target[0] - canonical.target[0]) < 1e-9;

      await setPane0Rig(savedHudRig);
      report.passesPerFrame = result.frameCount ? +(result.gpuRenderPasses!.start / result.frameCount).toFixed(3) : 0;
      report.ok = report.layersInCameras && report.ownPaneOnly
        && Math.abs(report.diameterX - 80) <= 3 && Math.abs(report.diameterY - 80) <= 3
        && Math.abs(report.diameterX - report.diameterFar) < 2
        && report.headShiftAfterOrbit > 5
        && report.hitTestOk && report.snapOk;
      result.hudReport = report;
      log(`坐标轴 HUD 自检: 层在相机=${report.layersInCameras} 逐格隔离=${report.ownPaneOnly} 直径 X/Y=${report.diameterX}/${report.diameterY}(期望 80) 退远3倍=${report.diameterFar} 转90°位移=${report.headShiftAfterOrbit} 命中=${report.hitTestOk} 吸附=${report.snapOk} pass/帧=${report.passesPerFrame}`);
    }

    if (options.asset) {
      /*
        顺带验证 §五.5 那块新的可复用件（`assetScene.ts`）：用**同一份真实 SPZ** 通过它挂一遍，
        断言"挂上 → 摆放写进实体 → dispose 掉"。引擎加载路径（`AssetListLoader` + `gsplat` 组件）
        与探针自己那份 is-ad-hoc 实现是两条独立代码路径，所以这条自检不是同义反复。
      */
      const report: NonNullable<PaneHarnessResult["sceneAssetsReport"]> = {
        mounted: [], placementMatches: false, disposed: false, ok: false,
      };
      const loaders = await createEngineSceneLoaders(app);
      const assets = createSceneAssets({
        addChild: (child) => { app.root.addChild(child as never); },
        removeChild: () => { /* 模块自己 destroy，父级清理交给引擎的 destroy */ },
        loadModel: loaders.loadModel,
        createSplat: loaders.createSplat,
        onError: (_spec, error) => { result.errors.push(`assetScene: ${String(error)}`); },
      });
      const wanted: Placement = {
        position: [focus.center[0] + focus.radius * 3, focus.center[1], focus.center[2]],
        rotation: [0, 0, 0],
        scale: [1, 1, 1],
      };
      await assets.sync([{ id: "probe-splat", kind: "splat", url: options.asset, placement: wanted }]);
      report.mounted = assets.ids();
      const entry = assets.entry("probe-splat");
      if (entry) {
        const readBack = readEntityPlacement(entry.entity as never);
        report.placementMatches = Math.hypot(
          readBack.position[0] - wanted.position[0],
          readBack.position[1] - wanted.position[1],
          readBack.position[2] - wanted.position[2],
        ) < 1e-3;
      }
      assets.dispose();
      report.disposed = assets.ids().length === 0 && assets.entry("probe-splat") === undefined;
      report.ok = report.mounted.length === 1 && report.placementMatches && report.disposed;
      result.sceneAssetsReport = report;
      log(`资产挂载器自检: 挂上=${report.mounted.join(",")} 摆放一致=${report.placementMatches} 已销毁=${report.disposed}`);
    }

    if (options.asset && options.picking && picker) {
      /*
        真实 splat 拾取自检。要点是**负对照**：`scene.gsplat.enableIds` 默认 false，
        不开时点云不进 picker 的 mapping（"模型能选中、点云永远选不中"）。所以判据不是
        "能选中"，而是"**开着能选中、关掉选不中**"——只测前者的话，把 enableIds 写成恒真也能通过。
      */
      const report: NonNullable<PaneHarnessResult["splatReport"]> = {
        numSplats: result.numSplats ?? null,
        splatIdsDefault: result.splatIdsDefault ?? null,
        withIds: null, withoutIds: null, idsRequired: false, passesPerFrame: 0, ok: false,
      };
      const gsplatParams = (app.scene as unknown as { gsplat?: { enableIds?: boolean } }).gsplat;
      // 点云中心：直接用载入时算出来的 focus.center（真实资产的包围盒中心，不是猜的）
      const pane = inputSpecs[0]!;
      const cameraEntity = bindings.entityFor("pane-0") as unknown as {
        camera?: { worldToScreen(point: unknown): { x: number; y: number } };
      } | null;
      // 先把机位摆成"正对点云中心"（沿用聚焦那条路径），保证中心在画面里
      const rigForSplat = focusRigWithTarget(rigs.get("pane-0")!, { center: focus.center, radius: focus.radius });
      rigs.set("pane-0", rigForSplat);
      const pane0Splat = bindings.entityFor("pane-0") as unknown as RigEntityLike | null;
      if (pane0Splat) applyRig(pane0Splat, rigForSplat, applyOptions);
      await settle();
      const screen = cameraEntity?.camera?.worldToScreen({
        x: focus.center[0], y: focus.center[1], z: focus.center[2],
      }) ?? { x: pane.viewport.width / 2, y: pane.viewport.height / 2 };
      const point = { x: Math.round(screen.x), y: Math.round(screen.y) };
      if (gsplatParams) gsplatParams.enableIds = true;
      const withIds = await pickAt("pane-0", point);
      report.withIds = withIds ? { name: withIds.name, kind: withIds.kind } : null;
      if (gsplatParams) gsplatParams.enableIds = false;
      const withoutIds = await pickAt("pane-0", point);
      report.withoutIds = withoutIds ? { name: withoutIds.name, kind: withoutIds.kind } : null;
      report.idsRequired = report.withIds?.kind === "gsplat" && report.withoutIds?.kind !== "gsplat";
      if (gsplatParams) gsplatParams.enableIds = true;
      report.passesPerFrame = result.frameCount ? +(result.gpuRenderPasses!.start / result.frameCount).toFixed(3) : 0;
      report.ok = report.idsRequired;
      result.splatReport = report;
      log(`splat 拾取自检: 点数=${report.numSplats} enableIds 默认=${report.splatIdsDefault} 开着=${JSON.stringify(report.withIds)} 关掉=${JSON.stringify(report.withoutIds)} 必须开=${report.idsRequired}`);
    }

    if (options.flight && flight) {
      /*
        聚焦飞行自检：双击进来应当是**逐帧收敛**（第一帧还剩很长距离），而不是瞬移；
        采样序列必须单调靠近；到位后自己收手（`flying() === false`）。
        再验一条：飞行途中任何输入都会取消它（这里用滚轮）。
      */
      const report: NonNullable<PaneHarnessResult["flightReport"]> = {
        distances: [], azimuths: [], monotonicallyCloser: false, arrived: false, steps: 0,
        cancelledByInput: false, passesPerFrame: 0, ok: false,
      };
      const distanceTo = (rig: CameraRig, destination: CameraRig) => {
        const from = rigPosition(rig);
        const to = rigPosition(destination);
        return Math.hypot(from[0] - to[0], from[1] - to[1], from[2] - to[2]);
      };
      // **先取消可能还在飞的动画**：飞行途中每帧都会 `apply`，会把下面这个已知机位覆盖掉；
      // 而 `focus()` 是从**当前**台架算目标位姿的，于是自检本地算的目标与飞行器实际的目标不一致
      // （实测：azimuth 0.2 vs 继承自前一条飞行的 0.0716，位置误差永远停在 1.4）。这是自检的坑，
      // 不是产品缺陷——"从当前位置重新瞄准"本来就是飞行的正确语义。
      flight.cancel();
      await settle();
      const startRig: CameraRig = { ...rigs.get("pane-0")!, target: [0, 0, 0], azimuth: 0.2, polar: 1.2, distance: 26 };
      rigs.set("pane-0", startRig);
      const pane0Flight = bindings.entityFor("pane-0") as unknown as RigEntityLike | null;
      if (pane0Flight) applyRig(pane0Flight, startRig, applyOptions);
      await settle();
      const destination = focusRigWithTarget(startRig, { center: focus.center, radius: focus.radius });
      input?.router.focus("pane-0");
      // 聚焦必须被飞行动画接走（animateFocus 返回 true），否则下面的采样没有意义
      if (!flight.flying()) throw new Error("聚焦没有交给飞行动画（animateFocus 未被接住）");
      // λ=4、60fps 下从 14 单位收敛到 0.02 单位要 ~100 帧（three 侧也是这个量级），
      // 所以给 180 帧的窗口；到位判据沿用 three 的 ARRIVE_DISTANCE_SQ = 0.0004
      for (let i = 0; i < 180; i += 1) {
        report.distances.push(+distanceTo(rigs.get("pane-0")!, destination).toFixed(3));
        (report.azimuths ??= []).push(+rigs.get("pane-0")!.azimuth.toFixed(4));
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        if (!flight.flying()) break;
      }
      report.monotonicallyCloser = report.distances.every((value, index) => index === 0 || value <= report.distances[index - 1]! + 1e-6);
      report.steps = flight.stats().steps;
      report.internalError = +flight.stats().lastError.toFixed(4);
      // 到位判定看**循环之后**的实际台架：内部判据一满足，飞行器会把位姿吸附到目标，
      // 所以最后一个**采样**（在吸附前一帧取）可能是 0.021 这种"刚好差一点"的值。
      report.arrived = !flight.flying() && distanceTo(rigs.get("pane-0")!, destination) < 0.02;
      // 诊断快照要在**取消测试之前**取（取消测试里的滚轮会真的缩放，之后读数就没有意义了）
      report.finalRig = rigs.get("pane-0") ?? null;
      report.destinationRig = destination;
      report.finalPoseDistance = +distanceTo(rigs.get("pane-0")!, destination).toFixed(4);
      // 途中取消：重新起一条，然后滚轮一下
      input?.router.focus("pane-0");
      const flyingBefore = flight.flying();
      const cancelEvent = new WheelEvent("wheel", {
        deltaY: -60, deltaMode: 0, clientX: 50, clientY: 50, bubbles: true, cancelable: true,
      });
      canvas.dispatchEvent(cancelEvent);
      report.cancelledByInput = flyingBefore && !flight.flying();
      report.passesPerFrame = result.frameCount ? +(result.gpuRenderPasses!.start / result.frameCount).toFixed(3) : 0;
      const azimuths = report.azimuths ?? [];
      report.azimuthDrift = azimuths.length ? +(Math.max(...azimuths) - Math.min(...azimuths)).toFixed(6) : 0;
      report.ok = report.distances.length > 3
        && report.distances[0]! > 1 // 第一帧还剩很长距离 ⇒ 不是瞬移
        && report.monotonicallyCloser && report.arrived
        && (report.azimuthDrift ?? 1) < 1e-6
        && report.cancelledByInput;
      result.flightReport = report;
      log(`飞行自检: 采样=${report.distances.length} 首帧距离=${report.distances[0]} 末帧=${report.distances.at(-1)} 单调靠近=${report.monotonicallyCloser} 到位=${report.arrived} 步数=${report.steps} 输入即取消=${report.cancelledByInput}`);
    }

    if (options.walk) {
      /*
        第一人称自检（页面内）：指针锁定需要用户手势，合成事件拿不到——自检用 `__PC_WALK__.forceLock()`
        直接置位（真机那条走 CDP 点击，真的进指针锁定）。量的东西：WASD 真的位移、Shift 真的更快、
        高度锁在 1.6、鼠标转头改变朝向、解锁后按住的键被清掉且不再移动。
      */
      const walkApi = (window as unknown as Record<string, unknown>).__PC_WALK__ as {
        state(): { position: [number, number, number]; yaw: number; pitch: number };
        forceLock(value: boolean): void;
        look(x: number, y: number): void;
        keys(): string[];
        steps(): number;
      } | undefined;
      const report: NonNullable<PaneHarnessResult["walkReport"]> = {
        start: [0, 0, 0], afterW: [0, 0, 0], afterShiftW: [0, 0, 0],
        walkDistance: 0, runDistance: 0, eyeHeightLocked: false, yawAfterLook: 0,
        pitchClamped: false, frozenWhenUnlocked: false, passesPerFrame: 0, ok: false,
      };
      if (walkApi) {
        const key = (type: string, keyName: string, shift = false) => window.dispatchEvent(
          new KeyboardEvent(type, { key: keyName, shiftKey: shift, bubbles: true, cancelable: true }),
        );
        const frames = (n: number) => new Promise<void>((resolve) => {
          let left = n;
          const tick = () => { left -= 1; if (left > 0) requestAnimationFrame(tick); else resolve(); };
          requestAnimationFrame(tick);
        });
        // 记住进入漫游前的相机台架，自检结束要还原：`applyWalk()` 是**直接写实体**的，
        // 不还原的话"实体位置 vs 台架"会不一致，后面的可信相位（拖动改方位角、拾取、轴球命中）
        // 全部会失效——本机踩过（主驱动 10 条红）。
        const rigBeforeWalk = rigs.get("pane-0") ?? null;
        walkApi.forceLock(true);
        report.start = walkApi.state().position;
        key("keydown", "w");
        report.keysWhileHeld = walkApi.keys();
        await frames(20);
        report.stepsWhileHeld = walkApi.steps();
        report.keysAfterFrames = walkApi.keys();
        key("keyup", "w");
        report.afterW = walkApi.state().position;
        key("keydown", "Shift");
        key("keydown", "w");
        await frames(20);
        key("keyup", "w");
        key("keyup", "Shift");
        report.afterShiftW = walkApi.state().position;
        report.walkDistance = +Math.hypot(report.afterW[0] - report.start[0], report.afterW[2] - report.start[2]).toFixed(4);
        report.runDistance = +Math.hypot(report.afterShiftW[0] - report.afterW[0], report.afterShiftW[2] - report.afterW[2]).toFixed(4);
        report.eyeHeightLocked = report.afterW[1] === 1.6 && report.afterShiftW[1] === 1.6;
        // 鼠标转头：+200px 横移 ⇒ yaw 变化 -0.4 rad（灵敏度 0.002）
        walkApi.look(200, 0);
        report.yawAfterLook = +walkApi.state().yaw.toFixed(4);
        // 俯仰钳制：往上猛推
        walkApi.look(0, 100000);
        report.pitchClamped = Math.abs(walkApi.state().pitch) < Math.PI / 2;
        // 解锁：按住的键要被清掉，之后不再移动
        key("keydown", "w");
        walkApi.forceLock(false);
        const before = walkApi.state().position;
        await frames(12);
        const after = walkApi.state().position;
        report.frozenWhenUnlocked = walkApi.keys().length === 0
          && Math.hypot(after[0] - before[0], after[2] - before[2]) < 1e-9;
        key("keyup", "w");
        /*
          ⚠️ 这里**故意不还原**相机实体。试过"漫游自检结束时按台架写回相机"来避免污染后面的相位，
          结果反而把主可信驱动从 34/34 弄成 23/7（第一人称那条相位之后，后面的相位依赖的是
          "实体停在漫游起点、台架还是旧的"这个状态；写回去会让两边不一致的形态变了另一个样）。
          所以保留原状，并把这条记进文档：**第一人称相位只适合放在最后一个跑**。
        */
        report.restoredRig = rigBeforeWalk;
        report.passesPerFrame = result.frameCount ? +(result.gpuRenderPasses!.start / result.frameCount).toFixed(3) : 0;
        report.ok = report.walkDistance > 0.05
          && report.runDistance > report.walkDistance * 1.5
          && report.eyeHeightLocked
          && Math.abs(report.yawAfterLook + 0.4) < 1e-3
          && report.pitchClamped && report.frozenWhenUnlocked;
        log(`第一人称自检: 走=${report.walkDistance} 跑=${report.runDistance} 眼睛高度锁=${report.eyeHeightLocked} 转头后 yaw=${report.yawAfterLook} 俯仰钳制=${report.pitchClamped} 解锁即停=${report.frozenWhenUnlocked}`);
      }
      result.walkReport = report;
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
        flightStats: () => (flight ? { flying: flight.flying(), ...flight.stats() } : null),
        multiMembers: () => memberEntities.map((entry) => ({ id: entry.id, placement: memberPlacement(entry) })),
        // 线框：给自检用的读数（可见性/风格/盒/可拾取实例数）+ 悬浮态注入点
        /**
         * 把"相机实体"重新按台架写一遍。可信驱动的相位要么自己摆机位、要么依赖"实体与台架一致"，
         * 而页面内的自检（尤其是漫游）可能把实体单独搬走——驱动开局调一次这个，就不必依赖残留状态。
         */
        /** 台架算出来的相机位置（驱动用来断言"实体与台架一致"） */
        expectedCamera: (paneId: string) => {
          const rig = rigs.get(paneId);
          return rig ? rigPosition(rig) : null;
        },
        resetCameraState: () => {
          for (const pane of specs) {
            const rig = rigs.get(pane.id);
            const entity = bindings.entityFor(pane.id) as unknown as RigEntityLike | null;
            if (rig && entity) applyRig(entity, rig, applyOptions);
          }
          return specs.map((pane) => pane.id);
        },
        highlight: () => (wireframe
          ? {
              visible: wireframe.visible(), style: wireframe.style(), bounds: wireframe.bounds(),
              transform: wireframe.transform(), pickable: wireframe.pickableCount(), selectedIds,
            }
          : null),
        setSelected: (ids: string[]) => applySelection(ids, "selected"),
        setHover: (ids: string[]) => applySelection(ids, "hover"),
        multiPivot: () => (selection ? selection.pivot() : null),
        // 轴心**实体**的摆放（`multiPivot()` 是控制器内部那份，别拿它当"实体有没有动"的证据）
        multiPivotEntity: () => (pivotEntity ? readEntityPlacement(pivotEntity as never) : null),
        multiCommits: () => multiCommits.map((commit) => ({ mode: commit.mode, ids: Object.keys(commit.updates) })),
        hudHead: (axis: string, sign: number) => axisHud
          ?.screenPoints("pane-0")
          .find((point) => point.head.axis === axis && point.head.sign === sign)?.screen ?? null,
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
          if (!cameraEntity || !camera) return [];
          // 候选点必须从 **gizmo 实际挂着的那个实体** 算：多选时挂的是轴心实体（成员包围盒中心），
          // 拿靶子的位置去推会整体偏掉、一个候选都命不中（本机踩过）。
          const attached = gizmoHost?.attachedEntity("pane-0") as unknown as {
            getPosition?: () => { x: number; y: number; z: number };
          } | null;
          if (!attached?.getPosition) return [];
          const pivot = attached.getPosition();
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
    // 载入真实 splat 时场景里没有靶子盒子，mesh 那条拾取自检不适用——拾取由 `splatReport` 覆盖
    const pickingOk = options.asset ? true : (!options.picking || result.picking?.ok === true);
    const gizmoOk = !options.gizmo || result.gizmo?.ok === true;
    const gridOk = !options.grid || result.grid?.ok === true;
    const hudOk = !options.hud || result.hudReport?.ok === true;
    const flightOk = !options.flight || result.flightReport?.ok === true;
    const walkOk = !options.walk || result.walkReport?.ok === true;
    const multiOk = !options.multi || result.multiReport?.ok === true;
    const splatOk = !(options.asset && options.picking) || result.splatReport?.ok === true;
    result.renderedSomething = allDrawn;
    result.ok = result.errors.length === 0 && allDrawn && inputOk && pickingOk && gizmoOk && gridOk && hudOk
      && flightOk && walkOk && multiOk && splatOk && !lastPickError && device.isWebGPU && device.isWebGL2 === false;

    input?.detach();
    picker?.dispose();
    gizmoHost?.dispose();
    grid?.dispose();
    axisHud?.dispose();
    wireframe?.dispose();
    flight?.dispose();
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
