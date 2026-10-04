import { type ReactNode, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { LibraryAsset } from "../../shared/lib/libraryApi";
import type { CameraRig } from "../../shared/lib/cameraRig";
import { createEnginePaneBindings, type EnginePaneBindings } from "../../shared/rendering/playcanvas/enginePanes";
import { PaneRegistry, type PaneSpec as RegistryPaneSpec } from "../../shared/rendering/playcanvas/paneRegistry";
import { applyRig, ORTHO_UP, type RigEntityLike } from "../../shared/rendering/playcanvas/cameraRig";
import { createPaneAxisHud, type PaneAxisHudHandle } from "../../shared/rendering/playcanvas/paneAxisHud";
import { createEditorGrid, type EditorGridHandle } from "../../shared/rendering/playcanvas/paneGrid";
import { attachPanePointerInput, type PanePointerInputHandle } from "../../shared/rendering/playcanvas/paneInput";
import { createPanePicker, entityWorldBounds, type PanePickerHandle } from "../../shared/rendering/playcanvas/panePicking";
import { createPaneGizmos, type PaneGizmoHandle } from "../../shared/rendering/playcanvas/paneGizmo";
import {
  createSelectionTransform,
  type Member as SelectionMember,
  type Placement,
  type SelectionTransformHandle,
} from "../../shared/rendering/playcanvas/selectionTransform";
import { readEntityPlacement, applyEntityPlacement } from "../../shared/rendering/playcanvas/panePlacement";
import { boundsCenter, boundsFromCenterHalfExtents, boundsSize, unionBounds, type Bounds3 } from "../../shared/rendering/playcanvas/selectionBounds";
import { createSelectionWireframe, type SelectionWireframeHandle } from "../../shared/rendering/playcanvas/selectionWireframe";
import { useRendererSession } from "../../shared/rendering/playcanvas/useRendererSession";
import { createEngineSceneLoaders, createSceneAssets, type SceneAssetsHandle } from "../../shared/rendering/playcanvas/assetScene";
import { viewportSceneSpecs } from "../../shared/rendering/playcanvas/viewportSceneSpecs";
import { captureInspectionSheet } from "../../shared/rendering/playcanvas/inspectionCapture";
import {
  createSceneLighting,
  environmentCandidates,
  type SceneLightingHandle,
} from "../../shared/rendering/playcanvas/sceneLighting";
import { registerSplatParsers } from "../../shared/rendering/playcanvas/splat";
import { libraryUrl } from "../../shared/lib/libraryApi";
import {
  createWalkState, EYE_HEIGHT, MAX_FRAME_DELTA, walkForward, walkInputFromKeys, walkVelocity, lookStep, type WalkState,
} from "../../shared/rendering/playcanvas/walkRig";
import { rigPosition } from "../../shared/lib/cameraRig";
import { clearViewportDebug, viewportDebugEnabled } from "../../shared/rendering/playcanvas/viewportDebug";
import { applyMaterialOverrides, createOverrideTextureLoader, restoreMaterialOverrides } from "../../shared/rendering/playcanvas/materialOverride";
import { collectMaterials } from "../../shared/rendering/playcanvas/modelTextures";
import { isTypingTarget, modeForKey, shouldHandleModeKeys } from "../../shared/rendering/playcanvas/transformKeys";
import { applyWireframeShading, collectMeshInstances, restoreWireframeShading } from "../../shared/rendering/playcanvas/wireframeShading";
import { computeSceneLayout } from "./scenePlacement";
import { LAYOUTS, type Projection } from "./paneLayouts";
import { rigForPaneCamera } from "../../shared/rendering/playcanvas/paneRigPresets";
import type { TransformMode, TransformSpace } from "./transformMode";
import { ViewportChrome } from "./ViewportChrome";
import type { ViewportProps } from "./index";

/**
 * 已挂上场景的资产（chrome 与诊断读它）：`world` 决定它算不算"物件"、参不参与变换工具组。
 * 记的是**真实挂载结果**（`SceneAssetsHandle.ids()`），不是 `props.assets` 的意愿清单——
 * 加载失败的资产不该出现在"几件物件"里，也不该让变换工具组冒出来。
 */
/**
 * 第一人称的物理角色参数。与 three 侧 `widgets/Viewport/physics.ts` **逐项一致**
 * （两侧手感必须同源）：
 * 胶囊半径 0.25、总高 1.6、眼高 = 身高一半、跳起初速 4.2、向下探地 0.92。
 */
const CHARACTER_RADIUS = 0.25;
const CHARACTER_HEIGHT = 1.6;
const CHARACTER_EYE_OFFSET = CHARACTER_HEIGHT / 2;
const CHARACTER_SPAWN_Y = CHARACTER_EYE_OFFSET + 0.2;
const JUMP_VELOCITY = 4.2;
const GROUND_PROBE_DEPTH = CHARACTER_HEIGHT / 2 + 0.12;
/** 准星抓取：与 three 侧 `physics.ts` 的 GRAB_* 逐项一致（手感同源） */
const GRAB_MAX_DISTANCE = 3;
const GRAB_LINEAR_LIMIT = 5;
const GRAB_ANGULAR_LIMIT = 10;

interface MountedAsset {
  id: string;
  /** `"collider"` 是世界的碰撞网格（不可见、只做物理），不是"一件资产" */
  kind: "model" | "splat" | "collider";
  world: boolean;
}

/**
 * PlayCanvas 版视口——**§五.5 的第一个增量**（只有 `?pcViewport=1` 时才挂载，three 仍是默认）。
 *
 * ### 这一增量做了什么
 * **1/2/4 窗格**（`LAYOUTS[layout]`，逐格像素视口 + 逐格相机/台架/HUD/gizmo）+
 * 项目里的**模型资产**（`assetScene` +
 * `viewportSceneSpecs`）+ 地面网格 + 坐标轴球 HUD + 每格指针输入（轨道 / 滚轮 / 右键平移 /
 * 双击聚焦）+ 点击拾取回调（`onSelectAsset` / `onClearSelection`）。
 *
 * ### 这一增量又接了（增量 2）
 * 变换 gizmo（引擎 `Translate/Rotate/ScaleGizmo`）+ **多选整体变换**（`selectionTransform` 的
 * 冻结相对矩阵）+ 拖动写**应用那张** `live` + 松手 `onTransformCommit` + 选中线框。
 *
 * ### 这一增量又接了（增量 3）
 * **G/R/S 切变换模式**（四道闸门按 `transformKeys` 的契约）。
 *
 * ### 刻意没做（下一增量；这些都在探针里验证过了，缺的只是接线）
 * 工具栏 UI（布局切换 / 网格开关 / 线框着色 / history 撤销重做按钮——那是应用外壳的事，
 * 现在 `?pcViewport=1` 这条分支没有工具栏）、**逐格的机位预设**（`CameraKind` 的
 * top/front/right 正交机位：现在所有格都是同一份透视默认机位）、
 * skybox / world 背景 splat、材质覆盖、检查图、第一人称。
 * **"能渲染"不等于"已迁移"**。
 *
 * ### 两条装配约定（都是踩过的）
 * ① **层 id 必须进 `PaneSpec.extraLayerIds` 再 `registry.sync`**：`sync()` 每次都重写
 *    `camera.layers`，外部 concat 的层下一次就被抹掉（症状：HUD 突然不画、零报错）。
 * ② 摘引擎资源的清理用 **`useLayoutEffect`**（见 `useRendererSession` 文件头）：passive 清理
 *    排在父组件销毁 `app` 之后，那时 `app.root` 已经是 null。
 */

export function PlayCanvasViewport(props: ViewportProps & { layout?: 1 | 2 | 4 }): ReactNode {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const session = useRendererSession({ canvasRef });
  const [ready, setReady] = useState(false);
  const [fatal, setFatal] = useState<string | null>(null);

  const bindingsRef = useRef<EnginePaneBindings | null>(null);
  const registryRef = useRef<PaneRegistry | null>(null);
  const gridRef = useRef<EditorGridHandle | null>(null);
  /**
   * 默认光照（环境光 + 两盏平行光）。**不接它整个场景就是黑的**：引擎 `scene.ambientLight`
   * 默认 `(0,0,0)`，而 GLB 不带灯——症状是"挂载成功、贴图也挂上了、画面上只有黑色剪影"。
   * 数值与 three 侧同一份契约，见 `sceneLighting.ts` 文件头。
   */
  const lightingRef = useRef<SceneLightingHandle | null>(null);
  const hudRef = useRef<PaneAxisHudHandle | null>(null);
  const inputRef = useRef<PanePointerInputHandle | null>(null);
  const pickerRef = useRef<PanePickerHandle | null>(null);
  const assetsRef = useRef<SceneAssetsHandle | null>(null);
  const gizmoHostRef = useRef<PaneGizmoHandle | null>(null);
  const transformRef = useRef<SelectionTransformHandle<string> | null>(null);
  const pivotEntityRef = useRef<unknown>(null);
  const wireframeRef = useRef<SelectionWireframeHandle | null>(null);
  const rigsRef = useRef<Map<string, CameraRig>>(new Map());
  const applyOptionsRef = useRef<{ perspective: number; orthographic: number } | null>(null);

  /*
    布局与网格显隐是**视口自己的状态**（`props.layout` 只作初值）：chrome 由 `ViewportChrome`
    渲染（**与 three 分支同一个组件**，见那个文件头），状态仍住在这里——默认路径零风险。
    `aria-label` 与 three 侧同一套文案，探针/可信点击都按它找按钮。
  */
  const [layoutMode, setLayoutMode] = useState<1 | 2 | 4>(props.layout ?? 1);
  const [gridVisible, setGridVisible] = useState(true);
  /*
    投影切换（**只在单窗格时出现**，与 three 侧 `singlePane` 的口径一致）：多窗格下每格是按
    `CameraKind` 定的轴测机位，整体翻转会把俯视/前视/右视全变成透视，那没有意义。
  */
  const [projection, setProjection] = useState<"perspective" | "orthographic" | null>(null);
  /** 线框着色（对齐 three 侧 `Shift+Z`）：换材质实例，不改标志位。 */
  const [wireframe, setWireframe] = useState(false);
  /*
    变换模式/参考系：**React 状态是权威**，再由 2b-2 那个 effect 推给各格的引擎 gizmo。
    以前只有 G/R/S 一条路直接写引擎（`gizmos.setMode`），于是工具栏没有按钮可点、也没有地方
    读"当前是哪个模式"。口径与 three 侧一致（`translate/rotate/scale` × `world/local`）；
    缩放模式下引擎强制走 local，所以参考系按钮在那时要禁用（`ViewportChrome` 里那条）。
  */
  const [transformMode, setTransformMode] = useState<TransformMode>("translate");
  const [transformSpace, setTransformSpace] = useState<TransformSpace>("world");
  /** gizmo 是**异步**建好的：创建那一刻要按"当前"模式摆好，而创建期间状态可能已经变了 */
  const transformStateRef = useRef({ mode: transformMode, space: transformSpace });
  /*
    **已挂上的资产**（见 `MountedAsset`）。存在的理由有两个，都是"必须有这个信号"：
    ① 材质/线框这些 effect **同步**跑在资产 effect（异步）前面，那时 `ids()` 还是空的，
       于是"什么都没做、也不报错"（同一族踩过三次：gizmo 轴心、线框、材质覆盖）；
    ② chrome 要按**真实挂载结果**决定出不出变换工具组、徽章写几件、有没有点云背景。
  */
  const [mountedAssets, setMountedAssets] = useState<readonly MountedAsset[]>([]);
  /** 第一人称：进入即请求指针锁定（挂在 `pointerdown` 上，见硬约束），退出回到台架 */
  const [firstPerson, setFirstPerson] = useState(false);
  /** 检查图（`inspect`）只拍一次：记住已处理过的请求 id */
  const inspectionDoneRef = useRef<string | null>(null);
  /** skybox 接线结果（诊断用；应用不读它） */
  const skyboxInfoRef = useRef<{ url: string; applied: boolean; error: string | null } | null>(null);
  /**
   * 变换控制器句柄。**本地 ref 是权威**：组件内部"资产就绪后再复位轴心"必须走它，
   * 不能绕 `window` 上那个诊断口——带上 `pcDebug` 开关后生产路径读不到诊断口，
   * `syncSelection()` 会静默不跑（轴心恒 null、gizmo 拖不动）。
   */
  const transformApiRef = useRef<{ syncSelection(): void } | null>(null);
  /** 材质覆盖的记账表（材质 → 槽位原值），卸载时整表还原 */
  const materialLedgerRef = useRef(new Map());
  /*
    诊断口**只在开发构建 + `?pcDebug=1` 时**才装：它们原先无条件挂到 `window` 上，真实业务页面
    也会被装上——诊断不该跟着产品页面走，而且那是全局可变状态。探针与驱动都显式带 `pcDebug=1`。
  */
  const debugEnabledRef = useRef<boolean | null>(null);
  if (debugEnabledRef.current === null) {
    debugEnabledRef.current = viewportDebugEnabled(typeof window === "undefined" ? null : window.location.search);
  }
  const setDebug = (name: string, value: unknown) => {
    if (typeof window === "undefined") return;
    if (debugEnabledRef.current !== true) return;
    (window as unknown as Record<string, unknown>)[name] = value;
  };
  const walkRef = useRef<{ state: WalkState; keys: Set<string>; locked: boolean; steps: number; forced: boolean }>({
    state: createWalkState(), keys: new Set(), locked: false, steps: 0, forced: false,
  });
  const wireframeStyleRef = useRef<number | null>(null);
  const savedMaterialsRef = useRef(new Map());
  /** 诊断用：线框那几个量（状态/遍历到的 mesh 数/改了几个/前几个样式） */
  const wireframeInfoRef = useRef({ wireframe: false, found: 0, applied: 0, styles: [] as (number | undefined)[] });
  const paneSpecs = useMemo(() => LAYOUTS[layoutMode], [layoutMode]);

  /**
   * 逐窗格的**像素视口**（与相机 `rect` 同源）：1 = 整块；2 = 左右各半；4 = 2×2 四象限。
   * `LAYOUTS[4]` 的 DOM 顺序就是 2×2 网格的左上/右上/左下/右下，所以 `index % 2` 是列、
   * `index / 2` 是行。**分母必须是画布的 CSS 尺寸**（归一化后 DPR 自然抵消）。
   */
  const paneRects = useCallback(() => {
    const canvas = canvasRef.current;
    if (!canvas) return [];
    const width = canvas.clientWidth;
    const height = canvas.clientHeight;
    const count = paneSpecs.length;
    return paneSpecs.map((spec, index) => {
      const viewport = count === 1
        ? { left: 0, top: 0, width, height }
        : count === 2
          ? { left: (index * width) / 2, top: 0, width: width / 2, height }
          : { left: (index % 2) * (width / 2), top: Math.floor(index / 2) * (height / 2), width: width / 2, height: height / 2 };
      return { id: spec.id, viewport };
    });
  }, [paneSpecs]);
  const rectFor = useCallback(
    (id: string) => paneRects().find((entry) => entry.id === id)?.viewport ?? null,
    [paneRects],
  );

  /**
   * **相机 layers 的唯一合成点**（逐格的 HUD + gizmo + 线框）。
   *
   * 为什么必须是"一次 `sync` 写全部窗格"：`PaneRegistry.sync()` 每次都重写**每一个**窗格的
   * `camera.layers`（`enginePanes.applyCamera`：`camera.layers = o.layers`）。所以
   * **"循环逐格 sync"是错的**——后一次会把前一次格子里的层抹掉：这里以前写成
   * `for (const id of paneIds) registry.sync(...)`，最终只剩**最后一格**留着 HUD/gizmo/线框层。
   *
   * 它当时被另一个 bug 掩盖着：坐标轴 HUD 的 mesh 因为 `entity.layers` 是无人读的自有属性而留在
   * World 层（见 `paneAxisHud.ts` 的 `createAxisHudWidget`），所有相机都看得见，所以"每格都有坐标轴"。
   * 修掉层归属之后，**不同时修这里就会有 3 格直接不画坐标轴**。
   */
  const syncPaneLayers = useCallback((override?: { index: number; projection: Projection }) => {
    const registry = registryRef.current;
    if (!registry) return;
    const hud = hudRef.current;
    const gizmos = gizmoHostRef.current;
    const wireframeLayerId = wireframeRef.current?.layerId() ?? null;
    const specs: RegistryPaneSpec[] = paneSpecs.flatMap((spec, index) => {
      const viewport = rectFor(spec.id);
      if (!viewport) return []; // 还没量到尺寸的窗格这一帧不画（与 `sync` 自己的口径一致）
      const extraLayerIds = [
        hud?.layerIdFor(spec.id) ?? null,
        gizmos?.layerIdFor(spec.id) ?? null,
        wireframeLayerId,
      ].filter((value): value is number => value !== null);
      return [{
        id: spec.id,
        viewport,
        projection: override?.index === index ? override.projection : rigForPaneCamera(spec.camera).projection,
        extraLayerIds,
      }];
    });
    if (specs.length > 0) registry.sync(specs);
  }, [paneSpecs, rectFor]);

  // 1) 设备 + app + 窗格相机 + 网格 + HUD
  useLayoutEffect(() => {
    const app = session.app;
    const canvas = canvasRef.current;
    if (session.status !== "ready" || !app || !canvas) return;
    let cancelled = false;
    void (async () => {
      try {
        const pc = await import("playcanvas");
        wireframeStyleRef.current = pc.RENDERSTYLE_WIREFRAME as unknown as number;
        applyOptionsRef.current = {
          perspective: pc.PROJECTION_PERSPECTIVE as unknown as number,
          orthographic: pc.PROJECTION_ORTHOGRAPHIC as unknown as number,
        };
        const bindings = await createEnginePaneBindings(canvas, app);
        const registry = new PaneRegistry({
          ...bindings,
          canvasSize: () => ({ width: canvas.clientWidth, height: canvas.clientHeight }),
        });
        if (cancelled) { bindings.dispose(); return; }
        bindingsRef.current = bindings;
        registryRef.current = registry;

        const rects = paneRects();
        if (rects.length === 0) return;
        // **逐格机位**：透视格用总览机位，top/front/right 用正交轴测机位（`projection` 也要进 registry）
        const specs: RegistryPaneSpec[] = rects.map((entry, index) => ({
          id: entry.id,
          viewport: entry.viewport,
          projection: rigForPaneCamera(paneSpecs[index]!.camera).projection,
        }));
        registry.sync(specs);
        for (const [index, entry] of specs.entries()) {
          const kind = paneSpecs[index]!.camera;
          const rig = rigForPaneCamera(kind);
          rigsRef.current.set(entry.id, rig);
          const cameraEntity = bindings.entityFor(entry.id) as unknown as RigEntityLike | null;
          // **俯视格的 up 必须是 `[0,0,-1]`**：正上方时视线与默认 up `(0,1,0)` 共线，
          // `lookAt` 退化 → 相机朝向是垃圾 → 该格几乎全空（本机踩过：只剩 94 个亮像素）。
          if (cameraEntity) {
            applyRig(cameraEntity, rig, { ...(applyOptionsRef.current ?? { perspective: 0, orthographic: 1 }), up: kind === "perspective" ? undefined : ORTHO_UP[kind] });
          }
        }

        const grid = await createEditorGrid(app);
        if (cancelled) { grid.dispose(); bindings.dispose(); return; }
        gridRef.current = grid;

        /*
          **默认光照必须在 `app.start()` 之前就位**（引擎对灯的数量没有"首帧之后再收"的限制，
          但放在这里能让"第一帧就是亮的"成为确定性行为，而不是看 rAF 与这段异步谁先跑完）。
          漏了它的症状是整场景黑剪影、零报错——`scene.ambientLight` 默认 `(0,0,0)` 且 GLB 不带灯。
        */
        const lighting = await createSceneLighting(app as never);
        if (cancelled) { lighting.dispose(); grid.dispose(); bindings.dispose(); return; }
        lightingRef.current = lighting;

        /*
          **SPZ 解析器必须显式注册**（2026-10-02 修）。引擎的 `gsplat` handler 内置只有
          `ply` / `sog` / `lod-meta.json`：SPZ 要 `addParser(new SpzParser(app))`，ZSTD 解码器
          还得先 `WasmModule.setConfig('ZstdDecoderModule', …)`（两件事封在 `splat.ts` 里）。
          探针一直在调它（`panes.browser.ts`），**产品路径此前漏了**——症状是资产稳定报
          `No parser found for resource: …spz`，而且**v4 也一样报**（与"产物是不是 v4"无关）。
          必须在 `setReady(true)` 之前完成，否则资产 effect 会先拿 gsplat 资产去加载。
        */
        await registerSplatParsers(app);
        if (cancelled) { lighting.dispose(); grid.dispose(); bindings.dispose(); return; }

        const hud = await createPaneAxisHud(app, {
          createLayer: (id) => {
            const layer = pc.Gizmo.createLayer(app as never, `viewport-hud:${id}`);
            return { id: layer.id, layer };
          },
          removeLayer: (entry) => { (app.scene.layers as unknown as { remove(l: unknown): void }).remove(entry.layer); },
          cameraFor: (id) => bindings.entityFor(id),
          paneRectFor: (id) => rectFor(id),
        });
        if (cancelled) { hud.dispose(); grid.dispose(); bindings.dispose(); return; }
        hudRef.current = hud;
        /*
          **渲染循环要自己启**：`RendererSession` 只负责建/销毁设备与 app（它提供了 `stopLoop()`
          用来取消 rAF），**不会**替你 `app.start()`——探针里也是自己调的。
          漏了它的症状是"组件挂载成功、没有报错、画布全黑"（本机踩过）。
        */
        (app as unknown as { start(): void }).start();
        /*
          ① HUD 层必须进 `extraLayerIds`（`sync` 每次都会重写 `camera.layers`），**每格都要**。
          走 `syncPaneLayers()` 而不是自己拼一遍：相机 layers 只能有**一个**合成点，
          否则某一处漏了 gizmo/线框层就会被下一次 sync 抹掉（这正是这里以前的问题）。
        */
        syncPaneLayers();
        setReady(true);
      } catch (error) {
        if (!cancelled) setFatal(error instanceof Error ? error.message : String(error));
      }
    })();
    return () => {
      cancelled = true;
      inputRef.current?.detach();
      pickerRef.current?.dispose();
      restoreWireframeShading(savedMaterialsRef.current);
      transformRef.current?.abort();
      gizmoHostRef.current?.dispose();
      wireframeRef.current?.dispose();
      assetsRef.current?.dispose();
      hudRef.current?.dispose();
      gridRef.current?.dispose();
      lightingRef.current?.dispose();
      bindingsRef.current?.dispose();
      inputRef.current = null;
      pickerRef.current = null;
      transformRef.current = null;
      gizmoHostRef.current = null;
      wireframeRef.current = null;
      pivotEntityRef.current = null;
      assetsRef.current = null;
      hudRef.current = null;
      gridRef.current = null;
      lightingRef.current = null;
      bindingsRef.current = null;
      registryRef.current = null;
      setReady(false);
    };
  }, [session.status, session.app, paneRects, paneSpecs, rectFor, syncPaneLayers]);

  // 卸载时按名单卸掉诊断口（它们只在 `?pcDebug=1` 下装过；真实页面上不该留全局可变状态）
  useEffect(() => () => { clearViewportDebug(); }, []);

  /*
    **场景签名**：`props.assets` 每次父组件渲染都可能换一个数组身份，直接把它放进 effect 依赖
    会让资产 effect **每渲染重跑一次**——每次都新建 `createSceneAssets` 再 `dispose` 旧的，
    网络稍慢就永远挂不上（真机症状：`ids: []`，诊断里只看到一次加载错误）。
    所以按"内容"算一个签名字符串，effect 只依赖它。
  */
  const sceneKey = useMemo(() => JSON.stringify({
    assets: props.assets.map((asset) => [asset.id, asset.modelPath, asset.spzPath, (asset as { resourceRevision?: number }).resourceRevision ?? null]),
    world: props.currentWorld ?? null,
    transforms: props.transforms ?? null,
  }), [props.assets, props.currentWorld, props.transforms]);

  const sceneSpecs = useMemo(() => {
    const layoutMap = computeSceneLayout(props.assets, props.transforms);
    return viewportSceneSpecs({
      assets: props.assets, layout: layoutMap,
      currentWorld: props.currentWorld, transforms: props.transforms,
      // **逻辑路径 → 可 fetch 的 URL**：漏了这一步会命中 SPA 回退、拿到 index.html。
      // 已经是绝对 URL/路径（探针的 `/@fs/…`）就直接用。
      urlFor: (logicalPath) => (/^(https?:)?\//.test(logicalPath) ? logicalPath : libraryUrl(logicalPath)),
      revisionFor: (asset) => (asset as { resourceRevision?: number }).resourceRevision ?? null,
    });
    // `sceneKey` 是内容的稳定指纹；`props.*` 只作为读取来源
  }, [sceneKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // 2) 资产：ViewportProps → 场景规格 → 挂载（`sync` 幂等，按 id 比对）
  useLayoutEffect(() => {
    const app = session.app;
    if (!ready || !app) return;
    let cancelled = false;
    void (async () => {
      const loaders = await createEngineSceneLoaders(app);
      if (cancelled) return;
      const { specs } = sceneSpecs;
      const next = createSceneAssets({
        addChild: (child) => { (app as { root: { addChild(c: unknown): void } }).root.addChild(child); },
        loadModel: loaders.loadModel,
        createSplat: loaders.createSplat,
        loadCollider: loaders.loadCollider,
        onError: (spec, error) => { console.warn(`[pcViewport] 资产 ${spec.id} 加载失败`, error); },
      });
      await next.sync(specs);
      if (cancelled) { next.dispose(); return; }
      assetsRef.current?.dispose();
      assetsRef.current = next;
      // chrome 读的是**真实挂载结果**：种类用来分"点云背景 / 物件"，world 用来把它排除在物件数外
      const kinds = new Map(specs.map((spec) => [spec.id, spec.kind]));
      const worldIds = new Set(props.assets.filter((asset) => asset.kind === "world").map((asset) => asset.id));
      setMountedAssets(next.ids().map((id) => ({
        id,
        kind: kinds.get(id) ?? "model",
        world: worldIds.has(id),
      })));
      /*
        **资产是异步挂上的，而 gizmo/控制器那个 effect 是同步跑在它前面的**：那一刻
        `members()` 还是空集（实体不存在）→ 轴心为 null → gizmo 无处可挂、"拖手柄"永远不触发。
        所以资产就绪后必须再复位一次轴心与线框（本机踩过：`pivotScreen()` 一直是 null）。
      */
      transformApiRef.current?.syncSelection();
    })();
    return () => { cancelled = true; };
  }, [ready, session.app, sceneSpecs]);

  /*
    2b) 变换 gizmo + 选中线框 + 拖动写 `live` + 松手 `onTransformCommit`。
    对应 three 侧 `TransformGizmo` 的三个 handler：begin（冻结相对矩阵）/ update（写实时表）/
    end（提交一次）。**两条接线约束**（都在探针里踩过）：
    ① gizmo/线框的层必须进 `PaneSpec.extraLayerIds` 再 `registry.sync`，否则下次 sync 被抹掉；
    ② 拖动由引擎的 `transform:start/end` 驱动控制器——引擎**不会**替你通知控制器。
  */
  useLayoutEffect(() => {
    const app = session.app;
    const bindings = bindingsRef.current;
    const registry = registryRef.current;
    const canvas = canvasRef.current;
    if (!ready || !app || !bindings || !registry || !canvas) return;
    let cancelled = false;
    let wireframe: SelectionWireframeHandle | null = null;
    let gizmos: PaneGizmoHandle | null = null;
    let transform: SelectionTransformHandle<string> | null = null;
    let pivot: { setPosition(x: number, y: number, z: number): void } | null = null;
    let detachModeKey: (() => void) | null = null;

    void (async () => {
      const pc = await import("playcanvas");
      if (cancelled) return;
      const pivotEntity = new pc.Entity("viewport-pivot"); // 不渲染，只给 gizmo 当挂点
      (app as { root: { addChild(c: unknown): void } }).root.addChild(pivotEntity);
      pivot = pivotEntity as unknown as { setPosition(x: number, y: number, z: number): void };
      pivotEntityRef.current = pivotEntity;

      // 成员 = 当前选中的资产实体；摆放读**实体**（与画面一致）
      const members = (): SelectionMember<string>[] => {
        const assets = assetsRef.current;
        if (!assets) return [];
        return [...props.selectedIds].flatMap((id) => {
          const entity = assets.entry(id)?.entity;
          if (!entity) return [];
          return [{ id, placement: readEntityPlacement(entity as never) }];
        });
      };
      const applyToEntities = (updates: Record<string, Placement>) => {
        for (const [id, placement] of Object.entries(updates)) {
          const entity = assetsRef.current?.entry(id)?.entity;
          if (entity) applyEntityPlacement(entity as never, placement);
          // 写**应用那张**实时表：右侧栏订阅它才能让数字跟着手走
          props.live.set(id, placement as never);
        }
      };

      transform = createSelectionTransform<string>({
        writeLive: applyToEntities,
        clearLive: () => { props.live.clear(); },
        onCommit: (updates, mode) => { props.onTransformCommit?.(updates as never, mode as never); },
      });
      transformRef.current = transform;

      gizmos = await createPaneGizmos({
        createLayer: (paneId) => {
          const layer = pc.Gizmo.createLayer(app as never, `viewport-gizmo:${paneId}`);
          return { id: layer.id, layer };
        },
        removeLayer: (entry) => { (app.scene.layers as unknown as { remove(l: unknown): void }).remove(entry.layer); },
        cameraFor: (paneId) => (bindings.entityFor(paneId) as { camera?: unknown } | null)?.camera ?? null,
        onDragStart: () => { transform?.begin(); },
        onDragEnd: () => {
          if (!transform?.active()) return;
          // 模式是全局的（`setMode` 对所有格生效），取第一格即可
          transform.end(gizmos?.modeFor(paneSpecs[0]!.id) ?? "translate");
          // 提交后按成员**当前**摆放复位轴心（含轴心实体），好接下一次拖拽
          transform.reset(members());
          const next = transform.pivot();
          if (next && pivot) pivot.setPosition(next.position[0], next.position[1], next.position[2]);
        },
      });
      if (cancelled) { gizmos.dispose(); return; }
      gizmoHostRef.current = gizmos;

      wireframe = await createSelectionWireframe(app, {
        createLayer: () => {
          const layer = pc.Gizmo.createLayer(app as never, "viewport-wireframe");
          return { id: layer.id, layer };
        },
        removeLayer: (entry) => { (app.scene.layers as unknown as { remove(l: unknown): void }).remove(entry.layer); },
        addChild: (child) => { (app as { root: { addChild(c: unknown): void } }).root.addChild(child); },
        /*
          线框层是**懒建**的（第一次 `set()` 才建），所以这里拿到的 id 才是真的：
          层 id 不补进各格相机的 `layers`，线框就永远不画（以前靠 World 层的 bug 歪打正着）。
        */
        onLayerCreated: () => { syncPaneLayers(); },
      });
      if (cancelled) { wireframe.dispose(); return; }
      wireframeRef.current = wireframe;

      // 拖动中把轴心位姿分发给成员（引擎写完实体之后才轮到我们，见探针里的说明）
      const onTransformMove = () => {
        if (!transform?.active() || !pivotEntityRef.current) return;
        transform.update(readEntityPlacement(pivotEntityRef.current as never));
        refreshWireframe();
      };
      const refreshWireframe = () => {
        if (!wireframe) return;
        const boxes = members().flatMap((member) => {
          const entity = assetsRef.current?.entry(member.id)?.entity;
          const bounds = entity ? entityWorldBounds(entity) : null;
          return bounds ? [boundsFromCenterHalfExtents(bounds.center, bounds.halfExtents)] : [];
        }) as Bounds3[];
        wireframe.set(unionBounds(boxes), members().length > 0 ? "selected" : "none");
      };

      /*
        每格各挂一个 gizmo（`attach` 会把这一格的 gizmo 层与三种模式**懒建**出来），
        然后**一次**把相机 layers 合成好：**不要**在循环里逐格 `registry.sync`——
        `sync` 重写所有窗格的 `camera.layers`，后一格会把前一格的层抹掉（见 `syncPaneLayers`）。
      */
      for (const id of paneSpecs.map((spec) => spec.id)) {
        gizmos.attach(id, pivotEntity);
        for (const mode of ["translate", "rotate", "scale"] as const) {
          gizmos.gizmoFor(id, mode)?.on("transform:move", onTransformMove);
        }
      }
      syncPaneLayers();
      /*
        引擎里新建的 gizmo 一律是 `translate`/`world`；把**当前**模式与参考系推一遍，
        免得"工具栏上写着 rotate、手柄却是移动"。读 ref 而不是闭包里的状态：这段是异步的，
        从 effect 起跑到这里已经过了好几个 await。
      */
      for (const spec of paneSpecs) {
        gizmos.setMode(spec.id, transformStateRef.current.mode);
        gizmos.setSpace(spec.id, transformStateRef.current.space);
      }

      /*
        G/R/S 切变换模式（对齐 three 侧 `index.tsx:570-586` 的四道闸门，契约在 `transformKeys`）：
        ① 焦点在输入框/contentEditable 不管；② 带 meta/ctrl/alt 不管；③ 没有选中不管；
        ④ 第一人称不管（那个模式的键位属于漫游；本视口还没接第一人称，按 false 传）。
        **不 `preventDefault` 非键位表内的按键**——否则会把别的快捷键吃掉。
      */
      const onModeKey = (event: KeyboardEvent) => {
        if (!shouldHandleModeKeys({ firstPerson: false, selectionCount: members().length })) return;
        const next = modeForKey(event);
        if (!next) return;
        event.preventDefault();
        // **只改 React 状态**：引擎那侧由 2b-2 的 effect 统一推（工具栏按钮走同一条路）
        setTransformMode(next);
      };
      window.addEventListener("keydown", onModeKey);
      /*
        `Shift+Z` 切线框（Blender 里就是它）。与 G/R/S 同一族闸门：**不按 Shift 的 Z 不管**
        （那是别的快捷键）、带 meta/ctrl/alt 不管（`Cmd+Shift+Z` 是重做，必须让路）、
        输入框里不管。第一人称**不**禁——看的是同一条场景。
      */
      const onShadingKey = (event: KeyboardEvent) => {
        if (!event.shiftKey || event.metaKey || event.ctrlKey || event.altKey) return;
        if (event.key.toLowerCase() !== "z") return;
        if (isTypingTarget(event.target)) return;
        event.preventDefault();
        setWireframe((value) => !value);
      };
      window.addEventListener("keydown", onShadingKey);
      detachModeKey = () => {
        window.removeEventListener("keydown", onModeKey);
        window.removeEventListener("keydown", onShadingKey);
      };

      // 选中集合变了 → 复位轴心 + 摆好 gizmo 与线框
      const syncSelection = () => {
        if (!transform || !pivot) return;
        const current = members();
        transform.reset(current);
        const next = transform.pivot();
        if (next) pivot.setPosition(next.position[0], next.position[1], next.position[2]);
        /*
          **没有选中就摘掉 gizmo**：引擎的 `enabled` 只看 `nodes.length > 0 && 距离 > eps`，
          所以"挂着但没选中"时手柄照样画、照样**抢点击**（症状：点空白既不清空选中也不触发拾取）。
          `attach(null)` 就是 detach（`paneGizmo` 文件头 ④）。本机在 `--select` 那轮踩到。
        */
        // 每格都挂/摘（没选中就摘掉，否则手柄照样画、照样抢点击）
        for (const spec of paneSpecs) {
          gizmos?.attach(spec.id, current.length > 0 ? pivotEntityRef.current : null);
        }
        refreshWireframe();
      };
      syncSelection();
      // 暴露给探针/诊断（真实应用里不需要）
      /*
        仅诊断用（真实应用不读它）：把"轴心在屏幕上的位置"和"引擎自己的 hover 判定"暴露出来，
        这样探针能像 `pc-panes.html` 那条可信驱动一样**先用手柄命中再按下**，
        而不是猜一个像素坐标（猜错过：轴心在画布中心下方约 40px，而箭杆只有几个像素粗）。
      */
      const pivotScreen = () => {
        const camera = (bindings.entityFor(paneSpecs[0]!.id) as unknown as {
          camera?: { worldToScreen(p: unknown): { x: number; y: number } };
        } | null)?.camera;
        const current = transform?.pivot();
        if (!camera || !current) return null;
        return camera.worldToScreen({ x: current.position[0], y: current.position[1], z: current.position[2] });
      };
      setDebug("__PC_VIEWPORT_WIREFRAME__", () => ({
        ...wireframeInfoRef.current,
        wireframeStyle: wireframeStyleRef.current,
        label: document.querySelector('[data-pc-toolbar="1"] button[aria-pressed]')?.getAttribute("aria-label") ?? null,
        labels: [...document.querySelectorAll('[data-pc-toolbar="1"] button')].map((b) => b.getAttribute("aria-label")),
      }));
      const transformApi = {
        syncSelection,
        pivot: () => transform?.pivot() ?? null,
        active: () => transform?.active() ?? false,
        members: () => members(),
        pivotScreen,
        /** 当前变换模式（诊断/判据用） */
        mode: () => gizmos?.modeFor(paneSpecs[0]!.id) ?? null,
        /** 当前变换参考系（诊断/判据用）：chrome 上的"世界/局部"按钮写的就是它 */
        space: () => gizmos?.spaceFor(paneSpecs[0]!.id) ?? null,
        /** 引擎内部的 hover 轴（`_hoverAxis`）；只给探针用 */
        hoverAxis: () => {
          const gizmo = gizmos?.gizmoFor(paneSpecs[0]!.id, "translate") as unknown as { _hoverAxis?: string } | null;
          return gizmo?._hoverAxis ?? null;
        },
      };
      /*
        **本地 ref 是权威**，`window` 只是给探针的发布口。
        组件自己那两处"资产就绪后再复位轴心"必须走本地 ref：走全局的话，没带 `pcDebug=1`
        的真实页面就读不到它 → `syncSelection()` 静默不跑 → 轴心恒 null、**gizmo 拖不动**（纯生产缺陷）。
      */
      transformApiRef.current = transformApi;
      setDebug("__PC_VIEWPORT_TRANSFORM__", transformApi);
    })();

    return () => {
      cancelled = true;
      detachModeKey?.();
      restoreWireframeShading(savedMaterialsRef.current);
      transformRef.current?.abort();
      gizmoHostRef.current?.dispose();
      wireframeRef.current?.dispose();
      gizmoHostRef.current = null;
      wireframeRef.current = null;
      transformRef.current = null;
      transformApiRef.current = null;
      setDebug("__PC_VIEWPORT_TRANSFORM__", undefined);
    };
    // `props.selectedIds` 变化由下面那个 effect 调 `syncSelection`（避免整块重建）
  }, [ready, session.app, paneSpecs, rectFor, props, syncPaneLayers]);

  /*
    2b-2) 变换模式/参考系 → 引擎 gizmo 的**唯一写入点**（工具栏按钮、G/R/S、布局切换都汇到这里）。
    状态与引擎两边必须同向：`transformStateRef` 给"创建那一刻"用，这个 effect 给"之后的变化"用。
  */
  useLayoutEffect(() => {
    transformStateRef.current = { mode: transformMode, space: transformSpace };
    const gizmos = gizmoHostRef.current;
    if (!ready || !gizmos) return;
    for (const spec of paneSpecs) {
      gizmos.setMode(spec.id, transformMode);
      gizmos.setSpace(spec.id, transformSpace);
    }
  }, [ready, paneSpecs, transformMode, transformSpace]);

  // 2c) 选中集合变化：只复位轴心与线框，不重建引擎资源
  useLayoutEffect(() => {
    transformApiRef.current?.syncSelection();
  }, [props.selectedIds, props.assets]);

  // 2d) 网格显隐（网格是共享层上的一份，整场景一份；用 `entity.enabled` 开关）
  useLayoutEffect(() => {
    if (!ready) return;
    const entity = gridRef.current?.entity as { enabled?: boolean } | undefined;
    if (entity) entity.enabled = gridVisible;
  }, [ready, gridVisible]);

  // 2e) 投影切换（单窗格）：台架 → 相机 → registry 三处都要改（registry 会重写 camera.projection）
  useLayoutEffect(() => {
    if (!ready || !projection) return;
    const bindings = bindingsRef.current;
    const kind = paneSpecs[0]!.camera;
    const base = rigForPaneCamera(kind);
    const rig: CameraRig = { ...base, projection };
    rigsRef.current.set(paneSpecs[0]!.id, rig);
    const entity = bindings?.entityFor(paneSpecs[0]!.id) as unknown as RigEntityLike | null;
    if (entity) {
      applyRig(entity, rig, {
        ...(applyOptionsRef.current ?? { perspective: 0, orthographic: 1 }),
        up: projection === "perspective" || kind === "perspective" ? undefined : ORTHO_UP[kind],
      });
    }
    // 只覆盖这一格的投影；**其余层照旧走唯一合成点**（以前这里只补 HUD 层，会把 gizmo/线框层抹掉）
    syncPaneLayers({ index: 0, projection });
  }, [ready, projection, paneSpecs, syncPaneLayers]);

  /*
    2f) 线框着色：**PlayCanvas 的线框是 `meshInstance.renderStyle`**（`RENDERSTYLE_WIREFRAME`），
    不是材质标志位——`StandardMaterial` 上根本没有 `wireframe`，引擎为每个 mesh 备了线框索引缓冲。
    换/还是纯逻辑（`wireframeShading.ts`，5 条单测钉住"连开两次再关"的记账陷阱），
    作用面**只有模型资产**（从 `assetScene` 拿实体），网格/天空盒/HUD/点云都不动。
  */
  useLayoutEffect(() => {
    const assets = assetsRef.current;
    const wireframeStyle = wireframeStyleRef.current;
    if (!ready || !assets || wireframeStyle === null) return;
    const entities = assets.ids().map((id) => assets.entry(id)?.entity);
    const found = collectMeshInstances(entities);
    const applied = wireframe
      ? applyWireframeShading(entities, wireframeStyle, savedMaterialsRef.current)
      : restoreWireframeShading(savedMaterialsRef.current);
    wireframeInfoRef.current = {
      wireframe, found: found.length, applied,
      styles: found.slice(0, 4).map((instance) => instance.renderStyle),
    };
  }, [ready, wireframe, sceneKey]);

  /*
    2g) 检查图（agent 的 `inspect` 工具）：`ViewportProps.inspection` 一来就拍一组四视角 PNG 回传。
    **同一个请求 id 只拍一次**（否则每次渲染都重拍，agent 会收到一堆重复图）；失败回 `null`，
    别让 agent 干等（`captureInspectionSheet` 自己抛错，这里接住）。
    取景：`asset` 用选中资产的世界包围盒；`scene` 用所有已挂资产的并集（退化成原点 + 最小半径）。

    ⚠️ **`target="closeup"`（贴近检查）在 PlayCanvas 视口上还没接**：它要的是"相机真的飞过去、
    从那个机位拍"，而这一层的相机聚焦/飞行（`paneInput.focus` + `rigFlight`）只存在于探针里，
    产品组件根本没有接线（连双击聚焦都没有）。这里如实回 `null` 让 agent 收到失败，
    **不能**退化成四视角——那是"单独看模型"，拿它回答"摆得对不对"会得出错误结论。
    缺口记在 PLAYCANVAS_MIGRATION.md 的未完成清单里。
  */
  useLayoutEffect(() => {
    const request = props.inspection;
    const app = session.app;
    if (!ready || !app || !request || !props.onInspectionCaptured) return;
    if (inspectionDoneRef.current === request.id) return;
    inspectionDoneRef.current = request.id;
    let cancelled = false;
    if (request.target === "closeup") {
      console.warn("[pcViewport] 贴近检查尚未在 PlayCanvas 视口上实现，如实回传失败");
      props.onInspectionCaptured(request.id, null);
      return;
    }
    void (async () => {
      try {
        const assets = assetsRef.current;
        const boxes: Bounds3[] = [];
        for (const id of assets?.ids() ?? []) {
          const entity = assets?.entry(id)?.entity;
          const bounds = entity ? entityWorldBounds(entity) : null;
          if (bounds) boxes.push(boundsFromCenterHalfExtents(bounds.center, bounds.halfExtents));
        }
        // `Bounds3` 是 `{min, max}`：取中心/尺寸要用模块自带的 helper，别自己读 `.center`
        const union = boxes.length > 0 ? unionBounds(boxes) : null;
        const unionSize: [number, number, number] = union ? (boundsSize(union) as [number, number, number]) : [0, 0, 0];
        const frame = request.target === "asset" && props.selectedIds.size > 0
          ? (() => {
              const id = [...props.selectedIds][0]!;
              const entity = assets?.entry(id)?.entity;
              // ⚠️ `entityWorldBounds` 给的是**引擎 Vec3**（`.x/.y/.z`），`boundsFromCenterHalfExtents`
              // 要的正是那个形状，转出来的 `Bounds3` 才是元组——两种形状别混着读（踩过）。
              const world = entity ? entityWorldBounds(entity) : null;
              if (!world) return { center: [0, 0, 0] as [number, number, number], radius: 1 };
              const bounds = boundsFromCenterHalfExtents(world.center, world.halfExtents);
              const size = boundsSize(bounds) as [number, number, number];
              return {
                center: boundsCenter(bounds) as [number, number, number],
                radius: Math.max(size[0], size[1], size[2], 1) / 2,
              };
            })()
          : {
              center: (union ? boundsCenter(union) : [0, 0, 0]) as [number, number, number],
              radius: Math.max(unionSize[0], unionSize[1], unionSize[2], 1) / 2,
            };
        const png = await captureInspectionSheet(app, frame);
        if (!cancelled) props.onInspectionCaptured?.(request.id, png);
      } catch (error) {
        console.warn("[pcViewport] 检查图失败", error);
        if (!cancelled) props.onInspectionCaptured?.(request.id, null);
      }
    })();
    return () => { cancelled = true; };
  }, [ready, session.app, props.inspection, props.onInspectionCaptured, props.selectedIds]);

  /*
    2h) 物理**只在第一人称下推进**（与 three 侧 `<Physics paused={!firstPerson}>` 同一条纪律）。
    为什么：轨道/多窗格是**编辑器**语义，家具必须待在 scene.json 说的位置上；否则一进
    PC 视口，所有物体立刻开始下落/被地面顶起来（真机上表现为"打开就自己动了一下"）。
    做法是订阅/退订 rigidbody 系统的 `update` 回调——引擎每帧 `systems.fire("update")`，
    它**不看** `system.enabled`，所以只能这样暂停（`ComponentSystem` 的 `enabled` 对步进无效）。
  */
  const physicsSubscribedRef = useRef<boolean | null>(null);
  useLayoutEffect(() => {
    const systems = (session.app as unknown as {
      systems?: {
        on(event: string, cb: (dt: number) => void, scope?: unknown): void;
        off(event: string, cb: (dt: number) => void, scope?: unknown): void;
        rigidbody?: { onUpdate?: (dt: number) => void };
      };
    } | null)?.systems;
    const runtime = systems?.rigidbody;
    const handler = runtime?.onUpdate;
    if (!ready || !systems || !runtime || !handler) return;
    // 引擎在 `app.init` 时就订阅过了，所以初值按"已订阅"算
    if (physicsSubscribedRef.current === null) physicsSubscribedRef.current = true;
    if (firstPerson && !physicsSubscribedRef.current) {
      systems.on("update", handler, runtime);
      physicsSubscribedRef.current = true;
    } else if (!firstPerson && physicsSubscribedRef.current) {
      systems.off("update", handler, runtime);
      physicsSubscribedRef.current = false;
    }
  }, [ready, session.app, firstPerson]);

  /*
    2h-bis) 地面平板 + 兜底安全网（与 three 侧 `PhysicsGround` **同源同数值**）。
    为什么必须有它：世界碰撞网格**只是那一间房的外壳**，而且实测它的物理地面并不在
    y=0（本机 `p-muo3u17c`：射线打到 `collider-mesh` 的顶面在 **y≈2.25**）——网格默认位上
    的资产、以及第一人称的角色都生在 y≈0 那一带，没有这块平板就会**无限下落**。
    顶面必须恰好在 y=0（`groundPlaneOffset` 的语义就是"把地面抬到 0"）。
  */
  useLayoutEffect(() => {
    const app = session.app;
    if (!ready || !app) return;
    let cancelled = false;
    let disposeGround: (() => void) | null = null;
    void (async () => {
      const pc = await import("playcanvas");
      if (cancelled) return;
      const root = (app as { root: { addChild(c: unknown): void } }).root;
      const ground = new pc.Entity("physics-ground");
      ground.addComponent("collision", { type: "box", halfExtents: new pc.Vec3(100, 0.05, 100) });
      ground.addComponent("rigidbody", { type: "static" });
      ground.setPosition(0, -0.05, 0); // 顶面 = 0
      root.addChild(ground);
      const net = new pc.Entity("physics-safety-net");
      net.addComponent("collision", { type: "box", halfExtents: new pc.Vec3(100, 1, 100) });
      net.addComponent("rigidbody", { type: "static" });
      net.setPosition(0, -10, 0);
      root.addChild(net);
      disposeGround = () => { ground.destroy(); net.destroy(); };
    })();
    return () => {
      cancelled = true;
      // 实体建到一半就被卸载时，`disposeGround` 可能还没赋值：用 destroyed 兜住
      disposeGround?.();
    };
  }, [ready, session.app]);

  /*
    2i) 第一人称（对照 three 侧的 `ViewMode = "firstPerson"`）。
    机制在探针里全验过（`walkRig` 10 条单测 + 驱动的漫游相位），这里把它接进产品组件：
    ① **请求指针锁定挂在 `pointerdown` 上**（本层 `preventDefault` 会抑制兼容 `mousedown`）；
    ② 每帧从 `walkRig` 算下一步并**直接写相机实体**（不走台架——台架只有方位/极角/距离，表达不了转头）；
    ③ 退出时**把相机还给台架**（`applyRig`），并把按键清空（否则"锁定时按住的 W"会继续走）。
  */
  useLayoutEffect(() => {
    const app = session.app;
    const canvas = canvasRef.current;
    const bindings = bindingsRef.current;
    if (!ready || !app || !canvas || !bindings) return;
    const paneId = paneSpecs[0]!.id;
    const entity = bindings.entityFor(paneId) as unknown as {
      setPosition(x: number, y: number, z: number): void;
      lookAt(x: number, y: number, z: number): void;
      up: { set(x: number, y: number, z: number): void };
    } | null;
    const applyOptions = applyOptionsRef.current ?? { perspective: 0, orthographic: 1 };
    /*
      相机同步：**位置读刚体、朝向读 walkRig**。
      位置不再由 walkRig 算（那正是"穿墙、不掉台阶"的根源），
      它只提供"这一帧想往哪走、多快"（`walkVelocity`）与视角（yaw/pitch）。
    */
    const syncCamera = (bodyY: number, x: number, z: number) => {
      if (!entity) return;
      const { state } = walkRef.current;
      const [fx, fy, fz] = walkForward(state);
      entity.up.set(0, 1, 0);
      entity.setPosition(x, bodyY + CHARACTER_EYE_OFFSET, z);
      entity.lookAt(x + fx, bodyY + CHARACTER_EYE_OFFSET + fy, z + fz);
    };
    if (!firstPerson) {
      // 退出/未进入：相机交还台架
      const rig = rigsRef.current.get(paneId);
      const rigEntity = bindings.entityFor(paneId) as unknown as RigEntityLike | null;
      if (rig && rigEntity) applyRig(rigEntity, rig, applyOptions);
      return;
    }
    // 进入：从当前台架派生人的位置与朝向（眼高锁 1.6）
    const rig = rigsRef.current.get(paneId);
    if (rig) {
      const [px, py, pz] = rigPosition(rig);
      walkRef.current.state = createWalkState({
        position: [px, Math.max(py, EYE_HEIGHT), pz],
        yaw: rig.azimuth,
        pitch: Math.max(-1.2, Math.min(1.2, Math.PI / 2 - rig.polar)),
      });
      walkRef.current.steps = 0;
    }
    walkRef.current.keys.clear();
    /** 角色实体与它的刚体组件；`playcanvas` 是动态 import（不把引擎拉进主 chunk），所以异步建 */
    type CharacterLike = {
      destroy(): void;
      getPosition(): { x: number; y: number; z: number };
      setPosition(x: number, y: number, z: number): void;
      rigidbody: {
        linearVelocity: { x: number; y: number; z: number };
        /** 引擎的"挪动刚体"接口（动态刚体必须用它：摆实体位置每帧会被物理回写覆盖） */
        teleport?(x: number, y: number, z: number): void;
      };
    };
    let character: CharacterLike | null = null;
    /** `Vec3` 只能在动态 import 之后拿到；`onUpdate` 里要用它写速度/射线端点 */
    let makeVec3: ((x: number, y: number, z: number) => { x: number; y: number; z: number }) | null = null;
    let jumpQueued = false;
    let cancelled = false;
    /** 抓取状态机（锚点 + 抓到的实体 + 甩出速度），无抓取时为 null */
    let grabState: {
      anchor: { destroy(): void; setPosition(x: number, y: number, z: number): void };
      target: { rigidbody?: { linearVelocity: { x: number; y: number; z: number } } };
      depth: number;
      previous: { x: number; y: number; z: number };
      release: { x: number; y: number; z: number };
    } | null = null;
    let lastGrabRay: {
      hit: boolean;
      name: string | null;
      filteredHit: boolean;
      filteredName: string | null;
      filteredType: string | null;
      start: [number, number, number];
      direction: [number, number, number];
    } | null = null;
    let grabRaycast: (() => { entity: { rigidbody?: { linearVelocity: { x: number; y: number; z: number } } }; point: { x: number; y: number; z: number }; depth: number } | null) | null = null;
    let tryGrab: (() => void) | null = null;
    let releaseGrab: (() => void) | null = null;
    const cameraEntity = entity as unknown as { getPosition(): { x: number; y: number; z: number } };
    /*
      角色刚体：**动态胶囊 + 禁转**。禁转不是可选项——胶囊撞到东西会像滚筒一样翻滚、
      相机跟着翻（three 侧同一个坑，那边用 `enabledRotations`）。
      出生点：眼高 + 0.2 余量，让重力把它放到地面上（地面在 y=0 是结构性的：
      世界 collider 的 `groundPlaneOffset` 语义就是"把地面抬到 0"）。
    */
    void (async () => {
      const pc = await import("playcanvas");
      if (cancelled) return;
      const entity2 = new pc.Entity("first-person-body");
      entity2.addComponent("collision", { type: "capsule", radius: CHARACTER_RADIUS, height: CHARACTER_HEIGHT });
      entity2.addComponent("rigidbody", {
        type: "dynamic",
        linearDamping: 0,
        angularDamping: 0,
        // 禁转：Vec3 零向量，胶囊永远不会翻滚
        angularFactor: new pc.Vec3(0, 0, 0),
      });
      entity2.setPosition(0, CHARACTER_SPAWN_Y, 3);
      (app as { root: { addChild(c: unknown): void } }).root.addChild(entity2);
      character = entity2 as unknown as CharacterLike;
      makeVec3 = (x, y, z) => new pc.Vec3(x, y, z);
      syncCamera(CHARACTER_SPAWN_Y, 0, 3);

      /*
        准星抓取：**kinematic 锚点 + 球形关节**（与 three 侧 `useObjectGrab` 同构，
        参数同源：距离 3 m、线速 5、角速 10）。
        用引擎自带的 `JointComponent` 而不是自己写弹簧：约束求解由 Ammo 做，
        松手时把锚点的位移/时间当作甩出速度还给物体。
      */
      grabRaycast = () => {
        lastGrabRay = null;
        if (!character || !makeVec3) return null;
        const systems2 = (app as unknown as {
          systems: { rigidbody?: { raycastFirst(from: unknown, to: unknown, options?: unknown): { entity?: unknown; point?: { x: number; y: number; z: number } } | null } };
        }).systems;
        if (!systems2.rigidbody) return null;
        const from = cameraEntity.getPosition();
        const [fx, fy, fz] = walkForward(walkRef.current.state);
        /*
          射线起点**必须挪出胶囊**：相机就在胶囊内部，从相机出发时 Bullet 会先"命中自己"，
          而 filterCallback 把自身滤掉之后并不会继续往后找（`raycastFirst` 只返回第一个结果）
          —— 症状是"准星明明对着物体却抓不到"，且没有任何报错。
          起点抬到胶囊半径 + 余量之外（0.5 m），终点仍是 3 m。
        */
        const startOffset = CHARACTER_RADIUS + 0.25;
        const start = {
          x: from.x + fx * startOffset,
          y: from.y + fy * startOffset,
          z: from.z + fz * startOffset,
        };
        const hit = systems2.rigidbody.raycastFirst(
          makeVec3!(start.x, start.y, start.z),
          makeVec3!(start.x + fx * GRAB_MAX_DISTANCE, start.y + fy * GRAB_MAX_DISTANCE, start.z + fz * GRAB_MAX_DISTANCE),
          {
            filterCallback: (candidate: unknown) => {
              if (candidate === character) return false;
              const rb = (candidate as { rigidbody?: { type?: string } }).rigidbody;
              return rb?.type === "dynamic";
            },
          },
        );
        // 对照：同一条射线**不加过滤**打一次。两次结果一比就知道是"没瞄准"还是
        // "被 filterCallback 滤掉了"（后者看着也像没瞄准，但根因完全不同）
        const raw = systems2.rigidbody.raycastFirst(
          makeVec3!(start.x, start.y, start.z),
          makeVec3!(start.x + fx * GRAB_MAX_DISTANCE, start.y + fy * GRAB_MAX_DISTANCE, start.z + fz * GRAB_MAX_DISTANCE),
          {},
        );
        lastGrabRay = {
          hit: Boolean(hit?.entity),
          name: hit?.entity ? ((hit.entity as { name?: string }).name ?? null) : null,
          filteredHit: Boolean(raw?.entity),
          filteredName: raw?.entity ? ((raw.entity as { name?: string }).name ?? null) : null,
          filteredType: raw?.entity ? ((raw.entity as { rigidbody?: { type?: string } }).rigidbody?.type ?? null) : null,
          start: [start.x, start.y, start.z],
          direction: [fx, fy, fz],
        };
        if (!hit?.entity || !hit.point) return null;
        return { entity: hit.entity as { rigidbody?: { linearVelocity: { x: number; y: number; z: number } } }, point: hit.point, depth: GRAB_MAX_DISTANCE * 0.9 };
      };
      tryGrab = () => {
        if (grabState) return;
        const hit = grabRaycast?.();
        if (!hit) return;
        const anchor = new pc.Entity("grab-anchor");
        /*
          ⚠️ 锚点**必须有 collision 组件**：引擎的 `enableSimulation` 判据是
          `entity.collision && entity.collision.enabled`，没有碰撞体的 kinematic 刚体
          **根本不会加入物理世界**——关节挂上去也拉不动任何东西。
          症状是"抓取射线命中了、grabbing 也是 true，但物体不跟着视线走"，零报错（本机踩过）。
          用一颗 1 cm 的**传感器**球：不推动其它物体，只为了让刚体成立。
          顺序也讲究：先 collision 后 rigidbody，创建时就能一次判定成功。
        */
        anchor.addComponent("collision", { type: "sphere", radius: 0.01, sensor: true });
        anchor.addComponent("rigidbody", { type: "kinematic" });
        anchor.setPosition(hit.point.x, hit.point.y, hit.point.z);
        (app as { root: { addChild(c: unknown): void } }).root.addChild(anchor);
        /*
          ⚠️ 引擎的关节类型是这几个**字符串常量**：`fixed` / `ball` / `hinge` / `slider` / `6dof`
          ——**没有 `"spherical"`**（球窝关节叫 `"ball"`）。写错类型名**不报错、也不建约束**，
          症状是"抓住了但物体不跟着走"（本机踩过）。对照：three 侧 rapier 那边叫
          `JointData.spherical`，两边叫法不同。
        */
        // `enableCollision: false`：锚点与被抓物体之间不参与碰撞（否则传感器球/自身会互相顶）
        anchor.addComponent("joint", { type: "ball", entityA: anchor, entityB: hit.entity, enableCollision: false });
        // 抓取深度取"相机到命中点"的实际距离（比固定值跟手）
        const cameraFrom = cameraEntity.getPosition();
        const depth = Math.max(Math.hypot(hit.point.x - cameraFrom.x, hit.point.y - cameraFrom.y, hit.point.z - cameraFrom.z), 0.3);
        grabState = {
          anchor: anchor as unknown as { destroy(): void; setPosition(x: number, y: number, z: number): void },
          target: hit.entity,
          depth,
          previous: { x: hit.point.x, y: hit.point.y, z: hit.point.z },
          release: { x: 0, y: 0, z: 0 },
        };
      };
      releaseGrab = () => {
        const state2 = grabState;
        if (!state2) return;
        grabState = null;
        state2.anchor.destroy(); // 关节随实体一起销毁 ⇒ 约束解除
        const velocity = state2.target.rigidbody?.linearVelocity;
        if (velocity) {
          state2.target.rigidbody!.linearVelocity = makeVec3!(state2.release.x, state2.release.y, state2.release.z);
        }
      };
    })();
    const onPointerDown = () => { void canvas.requestPointerLock?.(); };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isTypingTarget(event.target)) return; // 输入框里不抢键
      walkRef.current.keys.add(event.key.toLowerCase());
      if (event.key === " " && !event.repeat) jumpQueued = true;
      if (walkRef.current.locked) event.preventDefault();
    };
    const onKeyUp = (event: KeyboardEvent) => { walkRef.current.keys.delete(event.key.toLowerCase()); };
    const onPointerLockChange = () => {
      walkRef.current.locked = typeof document !== "undefined" && document.pointerLockElement === canvas;
      if (!walkRef.current.locked) walkRef.current.keys.clear();
      else walkRef.current.forced = false;
    };
    const onMouseMove = (event: MouseEvent) => {
      if (!walkRef.current.locked && !walkRef.current.forced) return;
      // 灵敏度沿用 three `PointerLockControls` 的 0.002 rad/px
      walkRef.current.state = lookStep(walkRef.current.state, -event.movementX * 0.002, -event.movementY * 0.002);
    };
    /*
      指针：**未锁定**时按下 = 请求指针锁定（进第一人称的常规动作）；
      **已锁定**时按下 = 抓起准星指着的物体（与 three 侧"锁定后才抓"同一口径）。
      第三个参数捕获阶段，避免被画布上的其它监听吞掉。
    */
    const onPointerDownForGrab = (event: PointerEvent) => {
      if (event.button !== 0) return;
      if (walkRef.current.locked || walkRef.current.forced) tryGrab?.();
    };
    const onPointerUpForGrab = (event: PointerEvent) => {
      if (event.button !== 0) return;
      releaseGrab?.();
    };
    canvas.addEventListener("pointerdown", onPointerDownForGrab);
    window.addEventListener("pointerup", onPointerUpForGrab);
    window.addEventListener("pointercancel", onPointerUpForGrab);
    canvas.addEventListener("pointerdown", onPointerDown);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("keyup", onKeyUp);
    window.addEventListener("mousemove", onMouseMove);
    document.addEventListener("pointerlockchange", onPointerLockChange);
    const onUpdate = (dt: number) => {
      const walk = walkRef.current;
      const active = character;
      const vec3 = makeVec3;
      if (!active || !vec3) return; // 引擎模块还在动态 import 中（约一帧）
      const delta = Math.min(Number.isFinite(dt) ? dt : 0, MAX_FRAME_DELTA);
      const input = walkInputFromKeys(walk.keys, delta);
      const [vx, , vz] = walkVelocity(walk.state, input);
      const position = active.getPosition();
      let vertical = active.rigidbody.linearVelocity.y;
      if (jumpQueued) {
        /*
          探地：从胶囊中心向下打一条射线（排除自己）。不排除自己时第一个命中的永远是
          自己的胶囊体，判据恒真 ⇒ 空中也能起跳（"二段跳"）。
        */
        const systems = (app as unknown as {
          systems: { rigidbody?: { raycastFirst(from: unknown, to: unknown, options?: unknown): unknown } };
        }).systems;
        const grounded = Boolean(systems.rigidbody?.raycastFirst(
          vec3(position.x, position.y, position.z),
          vec3(position.x, position.y - GROUND_PROBE_DEPTH, position.z),
          { filterCallback: (hit: unknown) => hit !== character },
        ));
        if (grounded) vertical = JUMP_VELOCITY;
        jumpQueued = false;
      }
      if (!walk.locked && !walk.forced) {
        // 没锁定：不接管水平方向（松开按键后由阻尼停下），但仍然同步相机与重力
        active.rigidbody.linearVelocity = vec3(0, vertical, 0);
        syncCamera(position.y, position.x, position.z);
        return;
      }
      active.rigidbody.linearVelocity = vec3(vx, vertical, vz);
      if (vx !== 0 || vz !== 0) walk.steps += 1;
      /*
        抓着的物体：锚点每帧跟到"相机 + 视线 × 深度"，并把锚点位移/时间记成松手速度。
        限速是必需的——快速甩动会让解算器给出爆炸速度，物体会瞬间飞出场景。
      */
      if (grabState) {
        const [fx, fy, fz] = walkForward(walk.state);
        const camera = cameraEntity.getPosition();
        const target = {
          x: camera.x + fx * grabState.depth,
          y: camera.y + fy * grabState.depth,
          z: camera.z + fz * grabState.depth,
        };
        const dt2 = delta > 0 ? delta : 1 / 60;
        const raw = {
          x: (target.x - grabState.previous.x) / dt2,
          y: (target.y - grabState.previous.y) / dt2,
          z: (target.z - grabState.previous.z) / dt2,
        };
        const speed = Math.hypot(raw.x, raw.y, raw.z);
        const scale = speed > GRAB_LINEAR_LIMIT ? GRAB_LINEAR_LIMIT / speed : 1;
        grabState.release = { x: raw.x * scale, y: raw.y * scale, z: raw.z * scale };
        grabState.previous = target;
        grabState.anchor.setPosition(target.x, target.y, target.z);
        const velocity = grabState.target.rigidbody?.linearVelocity;
        if (velocity) {
          const angular = { x: 0, y: 0, z: 0 };
          const linearSpeed = Math.hypot(velocity.x, velocity.y, velocity.z);
          if (linearSpeed > GRAB_LINEAR_LIMIT) {
            const s2 = GRAB_LINEAR_LIMIT / linearSpeed;
            grabState.target.rigidbody!.linearVelocity = makeVec3!(velocity.x * s2, velocity.y * s2, velocity.z * s2);
          }
          void angular;
          void GRAB_ANGULAR_LIMIT;
        }
      }
      // walkRig 的 state.position 只用来算视角方向，这里把它跟住刚体（诊断口读它）
      walk.state = { ...walk.state, position: [position.x, position.y + CHARACTER_EYE_OFFSET, position.z] };
      syncCamera(position.y, position.x, position.z);
    };
    (app as unknown as { on(event: string, cb: (dt: number) => void): void }).on("update", onUpdate);
    /*
      `forceInput`：本沙箱拿不到真实指针锁定（Chrome 直接拒），而"没锁定就不接管水平方向"
      是产品契约，不能为了测试拆掉。所以照 three 侧 `__PHYSICS__.forceInput` 的做法留一个
      **只在 `?pcDebug=1` 下存在**的绕过点，且只顶替"已锁定"这一个判据。
    */
    setDebug("__PC_VIEWPORT_FORCE_LOCK__", (locked: boolean) => {
      walkRef.current.forced = Boolean(locked);
    });
    setDebug("__PC_VIEWPORT_WALK__", () => {
      const active = character;
      const position = active ? active.getPosition() : { x: 0, y: 0, z: 0 };
      return {
        ready: Boolean(active),
        firstPerson: true,
        locked: walkRef.current.locked,
        forced: walkRef.current.forced,
        steps: walkRef.current.steps,
        // position 是**相机（眼睛）**位置，body 是刚体事实——两者相差一个眼高
        position: [position.x, position.y + CHARACTER_EYE_OFFSET, position.z],
        body: [position.x, position.y, position.z],
        velocity: active
          ? [active.rigidbody.linearVelocity.x, active.rigidbody.linearVelocity.y, active.rigidbody.linearVelocity.z]
          : null,
        yaw: walkRef.current.state.yaw,
        pitch: walkRef.current.state.pitch,
        keys: [...walkRef.current.keys],
        /*
          "为什么角色还在掉"必须一次问清：① 角色自己的刚体/胶囊建出来没有；
          ② 从角色往下打的物理射线**到底有没有打到东西**（打到的是谁、在什么高度）。
          只报"我在下落"是不够的——地形形状、body 位置、碰撞组任何一个出错都长这样。
        */
        character: active
          ? (() => {
              const raw = active as unknown as {
                enabled?: boolean;
                collision?: { type?: string; shape?: unknown };
                rigidbody?: { enabled?: boolean; type?: string };
              };
              return {
                enabled: raw.enabled ?? null,
                collisionType: raw.collision?.type ?? null,
                hasShape: Boolean(raw.collision?.shape),
                rigidbodyEnabled: raw.rigidbody?.enabled ?? null,
                rigidbodyType: raw.rigidbody?.type ?? null,
              };
            })()
          : null,
        // 诊断口自己绝不能抛：它一旦抛，驱动读到的是 null，"跳跃没发生"会被误读成"钩子坏了"
        grabbing: Boolean(grabState),
        grabRay: lastGrabRay,
        // 沙箱拿不到真指针锁定，抓取只能由驱动显式调用（与 three 侧同一个做法）
        grab: () => tryGrab?.(),
        release: () => releaseGrab?.(),
        /*
          `teleport`：把角色摆到指定位置。只为验收用——沙箱里没有它就只能"走过去"，
          而走过去会**先把目标推走**（推动实测 7.7 m），抓取就永远没得抓。
          与 three 侧 `__PHYSICS__.teleport` 同一个用途，只顶替"我先站好"这一步。
        */
        teleport: (x: number, y: number, z: number) => {
          const active = character;
          if (!active) return false;
          /*
            ⚠️ 必须走 `rigidbody.teleport()`，**不能**只摆实体位置：动态刚体每帧由物理
            回写实体变换（`_updateDynamic`），摆实体等于白摆——本机踩过（角色原地不动，
            看着像"teleport 没装上"）。引擎的 `teleport` 会设实体 + `syncEntityToBody`。
          */
          if (typeof active.rigidbody.teleport === "function") {
            active.rigidbody.teleport(x, y, z);
          } else {
            active.setPosition(x, y, z);
          }
          if (makeVec3) active.rigidbody.linearVelocity = makeVec3(0, 0, 0);
          return true;
        },
        ground: (() => { try {
          const systems = (app as unknown as {
            systems: { rigidbody?: { raycastFirst(from: unknown, to: unknown, options?: unknown): { entity?: { name?: string }; point?: { y?: number } } | null } };
          }).systems;
          if (!active || !systems.rigidbody) return null;
          const from = active.getPosition() as unknown as { x: number; y: number; z: number; clone?(): { x: number; y: number; z: number } };
          const to = from.clone ? from.clone() : { x: from.x, y: from.y, z: from.z };
          to.y = from.y - 6;
          const hit = systems.rigidbody.raycastFirst(from, to, { filterCallback: (entity: unknown) => entity !== active });
          return hit
            ? { entity: hit.entity?.name ?? null, y: hit.point?.y ?? null }
            : { entity: null, y: null };
        } catch (error) { return { error: String(error) }; } })(),
      };
    });
    return () => {
      canvas.removeEventListener("pointerdown", onPointerDown);
      canvas.removeEventListener("pointerdown", onPointerDownForGrab);
      window.removeEventListener("pointerup", onPointerUpForGrab);
      window.removeEventListener("pointercancel", onPointerUpForGrab);
      releaseGrab?.();
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("keyup", onKeyUp);
      window.removeEventListener("mousemove", onMouseMove);
      document.removeEventListener("pointerlockchange", onPointerLockChange);
      (app as unknown as { off(event: string, cb: (dt: number) => void): void }).off("update", onUpdate);
      cancelled = true;
      character?.destroy();
      character = null;
      walkRef.current.locked = false;
      walkRef.current.forced = false;
      walkRef.current.keys.clear();
      setDebug("__PC_VIEWPORT_WALK__", undefined);
      setDebug("__PC_VIEWPORT_FORCE_LOCK__", undefined);
    };
  }, [ready, session.app, firstPerson, paneSpecs]);

  /*
    2i-bis) 物理世界诊断口：只报**引擎事实**（world 在不在、刚体/碰撞体计数、Ammo 全局装没装上）。
    这条不是顺手加的：物理在这一层的失败方式**全是静默的**——Ammo 加载器会把 `window.Ammo`
    清空，而 `addComponent("rigidbody")` 在没有 world 时什么都不做、零报错。没有这个读数，
    "物理没接上"和"物理接上了但没有物体"完全分不开。
  */
  useLayoutEffect(() => {
    const app = session.app as unknown as {
      systems?: { rigidbody?: { physicsWorld?: unknown } };
      root?: { findComponents(name: string): unknown[] };
    } | null;
    if (!ready || !app?.systems?.rigidbody) return;
    setDebug("__PC_VIEWPORT_PHYSICS__", () => ({
      hasWorld: Boolean(app.systems?.rigidbody?.physicsWorld),
      bodies: app.root?.findComponents("rigidbody").length ?? 0,
      colliders: app.root?.findComponents("collision").length ?? 0,
      // 形状类型："mesh" 才是 trimesh 地形；null 说明 collision 建了但没拿到形状。
      // ⚠️ 类型字段叫 `_shapeType`（Ammo 后端的 `createShape` 里写的），**不是** `.type`
      // ——读错字段会把"形状建好了"读成 `null`，本机就踩过这一次。
      shapeTypes: (app.root?.findComponents("collision") ?? []).map((component) => {
        const shape = (component as { shape?: { _shapeType?: string } }).shape;
        return shape?._shapeType ?? (shape ? "unknown" : null);
      }),
      // 形状为 null 时，接着要回答"是 collision 没连上 render，还是 render 里没有 mesh"
      collisionDetails: (app.root?.findComponents("collision") ?? []).map((component) => {
        const typed = component as {
          type?: string;
          enabled?: boolean;
          _initialized?: boolean;
          shape?: unknown;
          render?: { meshes?: unknown[] };
        };
        return {
          type: typed.type ?? null,
          enabled: typed.enabled ?? null,
          initialized: typed._initialized ?? null,
          hasShape: Boolean(typed.shape),
          renderLinked: Boolean(typed.render),
          renderMeshes: typed.render?.meshes?.length ?? null,
          /*
            关键分歧点：`createMeshShape` 读的是 `_render.meshes`（Render **资源**那条路），
            而 container 实例化出来的 render 组件带的是 `meshInstances`。两者都可能为 0/undefined
            ——这一项就是"到底是哪种 render 组件"的直接读数。
          */
          meshInstances: (typed.render as { meshInstances?: unknown[] } | undefined)?.meshInstances?.length ?? null,
          meshesUndefined: typed.render ? typed.render.meshes === undefined : null,
          /*
            形状是按哪套世界变换烘的。`_builtWorldScale` 与实体实际世界缩放不一致时
            物理地形就会跟画面错位（真机症状：角色无限下落而世界里明明有一块 mesh 地形）。
          */
          builtWorldScale: (component as { _builtWorldScale?: { x: number; y: number; z: number } })._builtWorldScale
            ? [
                (component as { _builtWorldScale: { x: number; y: number; z: number } })._builtWorldScale.x,
                (component as { _builtWorldScale: { x: number; y: number; z: number } })._builtWorldScale.y,
                (component as { _builtWorldScale: { x: number; y: number; z: number } })._builtWorldScale.z,
              ]
            : null,
          worldPosition: (() => {
            const world = (component as { entity?: { getPosition?(): { x: number; y: number; z: number } } }).entity?.getPosition?.();
            return world ? [world.x, world.y, world.z] : null;
          })(),
        };
      }),
      // 后端读的是裸全局（`new Ammo.btVector3`），所以这一项比 hasWorld 更能说明问题
      ammoGlobal: typeof (globalThis as { Ammo?: { btVector3?: unknown } }).Ammo?.btVector3 === "function",
      /*
        规格与跳过原因是"物理地形为什么没挂上"的第一手答案：世界资产只有在 `currentWorld`
        命中时才成规格（见 viewportSceneSpecs 的 other-world 分支），而 collider 规格还要求
        层 id 已经建好。没有这两行，`bodies: 0` 就只能靠猜。
      */
      /*
        地形到底在哪：从高处往下打物理射线，逐点报"打到谁、在什么高度"。
        角色掉下去时，这一项直接区分"地形不在那儿"和"角色不与它碰撞"。
      */
      sweep: (() => {
        const systems = (app as unknown as {
          systems: { rigidbody?: { raycastFirst(from: unknown, to: unknown, options?: unknown): { entity?: { name?: string }; point?: { y?: number } } | null } };
        }).systems;
        if (!systems.rigidbody) return null;
        /*
          探针打在 **y = 1.4 → −0.5** 这一段：天花板（实测 ≈2.25）在起点之上，
          所以"第一个命中"就只会是**物体盒体**或**地面平板**——正好回答
          "盒体碰撞体在不在、在什么高度"（用 30 → −30 时永远先打到天花板，什么也看不出）。
        */
        const probe = (x: number, z: number) => {
          const hit = systems.rigidbody?.raycastFirst(
            { x, y: 1.4, z },
            { x, y: -0.5, z },
            {},
          );
          return {
            x,
            z,
            entity: hit?.entity?.name ?? null,
            y: hit?.point?.y == null ? null : +hit.point.y.toFixed(3),
          };
        };
        return [probe(0, 3), probe(0, 0), probe(3, 0), probe(-3, -6)];
      })(),
      /*
        逐物体刚体（"可推"的判据）。读的是引擎事实：哪些实体有 dynamic 刚体、各自在哪儿、
        碰撞体是什么形状——只报"我调了 addComponent"是不够的。
      */
      objectBodies: (app.root?.findComponents("rigidbody") ?? [])
        .filter((component) => (component as { type?: string }).type === "dynamic")
        .map((component) => {
          const typed = component as {
            entity?: {
              name?: string;
              getPosition?(): { x: number; y: number; z: number };
              collision?: {
                type?: string;
                shape?: { _shapeType?: string };
                halfExtents?: { x: number; y: number; z: number };
                linearOffset?: { x: number; y: number; z: number };
              };
            };
          };
          const position = typed.entity?.getPosition?.();
          return {
            name: typed.entity?.name ?? null,
            position: position ? [position.x, position.y, position.z] : null,
            collisionType: typed.entity?.collision?.type ?? null,
            shapeType: typed.entity?.collision?.shape?._shapeType ?? null,
            // 盒体到底多大、偏了多少：探针打不到它时，这两个数就是答案
            halfExtents: (() => {
              const half = (typed.entity?.collision as { halfExtents?: { x: number; y: number; z: number } })?.halfExtents;
              return half ? [half.x, half.y, half.z] : null;
            })(),
            linearOffset: (() => {
              const offset = (typed.entity?.collision as { linearOffset?: { x: number; y: number; z: number } })?.linearOffset;
              return offset ? [offset.x, offset.y, offset.z] : null;
            })(),
          };
        }),
      specKinds: sceneSpecs.specs.map((spec) => [spec.id, spec.kind] as const),
      skipped: sceneSpecs.skipped.map((entry) => [entry.id, entry.reason] as const),
    }));
    return () => setDebug("__PC_VIEWPORT_PHYSICS__", undefined);
  }, [ready, session.app, sceneSpecs]);

  /*
    2j) skybox / 环境贴图（`props.currentSkybox` 是资产 slug）。
    ⚠️ **引擎不认 `.exr`**（2.22.6 的贴图解析器只有 img / dds / basis / **hdr**），而 three 侧的硬编码
    回退就是 `/env/sky.exr`——所以 PC 侧**必须有自己的、引擎认得的兜底**，见下面那条候选表。
    接线本身照 `scene.envAtlas`（IBL）+ `scene.skybox`（可见天空）写。
  */
  useLayoutEffect(() => {
    const app = session.app as unknown as {
      scene?: { envAtlas: unknown; skybox: unknown };
    } | null;
    const scene = app?.scene;
    if (!ready || !scene) return;
    let cancelled = false;
    const skyAsset = props.currentSkybox
      ? props.assets.find((asset) => asset.assetSlug === props.currentSkybox && asset.kind === "skybox")
        ?? props.assets.find((asset) => asset.assetSlug === props.currentSkybox)
      : undefined;
    const path = (skyAsset as { hdrPath?: string | null } | undefined)?.hdrPath ?? null;
    /*
      **必须有兜底**（2026-10-02 修）：此前是 `if (!path) return;`，于是"项目没选天空盒 / 列表里那个
      占位资产的 hdrPath 是 null"时**连 IBL 都没有**——而引擎 `scene.ambientLight` 默认是黑，
      这批 Tripo 产物又是 `metalness: 1`（几乎没有漫反射，颜色全靠环境反射），
      合起来就是"整场景黑剪影、贴图看不见"。three 侧一直在兜底（`/env/sky.exr`），只是那份引擎不认。
      候选表按顺序试：项目产物 → `/env/sky.jpg`（引擎认的 equirect），项目产物是 EXR 时自然落到后者。
    */
    const candidates = environmentCandidates(
      path ? (/^(https?:)?\//.test(path) ? path : libraryUrl(path)) : null,
    );
    if (candidates.length === 0) return;
    void (async () => {
      const loadTexture = createOverrideTextureLoader(app);
      let lastError: unknown = null;
      for (const url of candidates) {
        try {
          const texture = await loadTexture(url);
          if (cancelled) return;
          /*
            **不能把 equirect 的 2D 贴图直接喂 `envAtlas`/`skybox`**：引擎会**静默丢弃**（本机实测：
            赋值后 `scene.envAtlas` 仍是 null、Sky 层 0 个 mesh、开/关天空盒像素逐位相同）。
            正确路径是引擎自己的 `EnvLighting`：
            - `generateSkyboxCubemap(equirect)` → **cubemap**，这才被 `scene.skybox` 收下（可见天空）；
            - `generateLightingSource` → `generateAtlas` → 预过滤的反射/环境光照（`scene.envAtlas`）。
          */
          const pc = await import("playcanvas");
          const skybox = pc.EnvLighting.generateSkyboxCubemap(texture as never);
          const atlas = pc.EnvLighting.generateAtlas(
            pc.EnvLighting.generateLightingSource(texture as never, { size: 128 }),
            { size: 256, numReflectionSamples: 256, numAmbientSamples: 512 },
          );
          if (cancelled) return;
          scene.skybox = skybox;
          scene.envAtlas = atlas;
          // **读引擎事实**，不是读自己的意图：赋值被忽略时这里要如实报出来
          const applied = !!scene.skybox && !!scene.envAtlas;
          skyboxInfoRef.current = {
            url, applied, error: applied ? null : "赋值被引擎忽略（scene.skybox/envAtlas 仍为空）",
          };
          // 这一张成功了就收手（候选表是"按顺序试"，不是"全部都要"）
          if (applied) return;
          lastError = new Error("赋值被引擎忽略（scene.skybox/envAtlas 仍为空）");
        } catch (error) {
          lastError = error;
          console.warn(`[pcViewport] 环境贴图加载失败：${url}（引擎只认 img/dds/basis/hdr，不认 .exr）`, error);
        }
      }
      // 走到这里 = 所有候选都失败，如实记下最后一条错（别把"没有环境贴图"留成沉默状态）
      skyboxInfoRef.current = {
        url: candidates[candidates.length - 1]!,
        applied: false,
        error: lastError instanceof Error ? lastError.message : String(lastError ?? "没有可用的候选"),
      };
    })();
    return () => { cancelled = true; };
  }, [ready, session.app, props.currentSkybox, props.assets, sceneKey]);

  /*
    2h) 材质覆盖（右侧栏改过的贴图，按 **assetSlug** 索引）。每次先**整表还原**再按当前表应用，
    这样"取消覆盖 / 换图 / 换代"都走同一条路（不用区分增量）。
    贴图是异步的：加载失败只跳过那一张，**不改材质**（宁可用模型自带贴图，也不要空贴图）。
  */
  useLayoutEffect(() => {
    const app = session.app;
    if (!ready || !app) return;
    const assets = assetsRef.current;
    if (!assets) return;
    const overrides = props.materials ?? {};
    const loadTexture = createOverrideTextureLoader(app);
    let cancelled = false;
    void (async () => {
      restoreMaterialOverrides(materialLedgerRef.current);
      for (const id of assets.ids()) {
        if (cancelled) return;
        const entity = assets.entry(id)?.entity;
        const asset = props.assets.find((candidate) => candidate.id === id);
        const override = asset ? (overrides as Record<string, { textures?: Record<string, string> } | undefined>)[asset.assetSlug] : undefined;
        const entries = Object.entries(override?.textures ?? {}).filter(([, path]) => !!path);
        if (!entity || entries.length === 0) continue;
        const textures: Record<string, unknown> = {};
        for (const [slot, path] of entries) {
          // 绝对 URL/路径直接用（探针传 `/@fs/…`），相对逻辑路径走 libraryUrl
          const url = /^(https?:)?\//.test(path) ? path : libraryUrl(path);
          try { textures[slot] = await loadTexture(url); }
          catch (error) { console.warn(`[pcViewport] 覆盖贴图 ${slot} 加载失败`, error); }
        }
        if (cancelled) return;
        applyMaterialOverrides(collectMaterials(entity as never), textures, materialLedgerRef.current);
      }
    })();
    return () => { cancelled = true; };
  }, [ready, session.app, sceneKey, props.materials, props.assets]);

  // 3) 指针输入 + 拾取
  useLayoutEffect(() => {
    const canvas = canvasRef.current;
    const app = session.app;
    const bindings = bindingsRef.current;
    if (!ready || !canvas || !app || !bindings) return;
    const applyOptions = applyOptionsRef.current ?? { perspective: 0, orthographic: 1 };
    const picker = createPanePicker(app, {
      canvasSize: () => ({ width: canvas.clientWidth, height: canvas.clientHeight }),
      cameraFor: (id) => bindings.entityFor(id) as { camera?: unknown } | null,
    });
    pickerRef.current = picker;
    const input = attachPanePointerInput(canvas, {
      panes: () => {
        return paneRects();
      },
      getRig: (id) => rigsRef.current.get(id) ?? null,
      setRig: (id, rig) => {
        rigsRef.current.set(id, rig);
        const entity = bindings.entityFor(id) as unknown as RigEntityLike | null;
        if (entity) applyRig(entity, rig, applyOptions);
      },
      focusTarget: () => ({ center: [0, 0.8, 0], radius: 5 }),
      // 拖手柄期间把指针手势让给 gizmo（信号来自引擎自己的 transform:start/end）
      isPointerClaimed: (id) => gizmoHostRef.current?.dragging(id) ?? false,
      onClick: (id, point) => {
        void picker.pick(id, point).then((hit) => {
          if (!hit) { props.onClearSelection(); return; }
          /*
            **按实体身份解析**，不要按名字比：命中的实体名来自引擎（container 实例化的根名可能是
            文件名/"model.glb"），拿它去比 `asset.id`/`assetSlug` 比不中就会把"点中模型"当成"点空白"
            而清空选中——症状是**怎么点都选不中**（真机上扫 28 个点全落空，本机踩过）。
            做法：从命中实体往上找，看它属于哪一件**已挂载**的资产（`entry(id).entity` 是同一棵树）。
          */
          const assets = assetsRef.current;
          const hitEntity = (hit as { entity?: unknown }).entity ?? null;
          let assetId: string | null = null;
          if (assets && hitEntity) {
            for (const candidate of assets.ids()) {
              const root = assets.entry(candidate)?.entity as { isDescendantOf?(node: unknown): boolean } | undefined;
              if (!root) continue;
              if (root === hitEntity || root.isDescendantOf?.(hitEntity) || (hitEntity as { isDescendantOf?(node: unknown): boolean }).isDescendantOf?.(root)) {
                assetId = candidate;
                break;
              }
            }
          }
          const asset = assetId ? props.assets.find((candidate) => candidate.id === assetId) : undefined;
          if (asset) props.onSelectAsset(asset as LibraryAsset, false);
          else props.onClearSelection();
        }).catch(() => { /* 拾取失败不动选中 */ });
      },
    });
    inputRef.current = input;
    return () => {
      input.detach();
      picker.dispose();
      inputRef.current = null;
      pickerRef.current = null;
    };
  }, [ready, session.app, paneRects, props]);

  // 4) 尺寸变化：重设相机 rect（单窗格=整块画布）
  useLayoutEffect(() => {
    if (!ready) return;
    // 尺寸变了也要走**唯一合成点**：以前这里只补 HUD 层，resize 一次就把 gizmo/线框层从每格相机里抹掉
    const onResize = () => { syncPaneLayers(); };
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, [ready, syncPaneLayers]);

  /*
    chrome 的取值全部来自**真实状态**（见 `MountedAsset`），口径与 three 侧一致：
    `objectCount` = 已挂载的非 world 资产、`selectedCount` = 选中集合大小、
    `splatBackground` = 真的挂上了一片点云（没挂上就不写这个徽章，免得描述一个不存在的背景）。
  */
  const mountedObjects = mountedAssets.filter((asset) => !asset.world);
  const hasSelection = mountedObjects.some((asset) => props.selectedIds.has(asset.id));
  const splatBackground = mountedAssets.some((asset) => asset.kind === "splat");
  const hasContent = mountedAssets.length > 0;
  const singlePane = layoutMode === 1;

  const status = fatal ?? (session.error ? session.error.message : null);
  return (
    /*
      尺寸用**内联样式**而不是只用 Tailwind 类：画布尺寸是这个组件的**功能前提**（窗格像素视口、
      相机 rect、指针命中都按它算），不该依赖宿主是否加载了样式表。
      真机上就踩过：探针页没引入 index.css，`h-full w-full` 不生效 → 画布停在元素默认的 300×150，
      整屏黑、零报错。
    */
    <div
      ref={hostRef}
      className="relative h-full w-full"
      data-pc-viewport="1"
      style={{ position: "relative", width: "100%", height: "100%", overflow: "hidden" }}
    >
      {/* `data-renderer="webgpu"`：应用侧探针/诊断脚本按这个选择器找画布（three 版同样带） */}
      <canvas
        ref={canvasRef}
        data-renderer="webgpu"
        className="block h-full w-full"
        style={{ display: "block", width: "100%", height: "100%" }}
      />
      {/*
        视口 chrome（右下角控制簇 + 底部徽章 + 第一人称提示）：**与 three 分支共用同一个组件**
        （`ViewportChrome`）。这里只把 PlayCanvas 这侧的状态喂进去，"长什么样"一个字都不在本组件里。
        `data-pc-toolbar="1"` 是探针/驱动的挂载点（驱动按它判断工具栏在不在），产品 DOM 里没有它。
      */}
      <ViewportChrome
        data-pc-toolbar="1"
        history={props.history}
        transform={!firstPerson && hasSelection ? {
          mode: transformMode,
          onMode: setTransformMode,
          space: transformSpace,
          onSpace: setTransformSpace,
        } : null}
        layout={firstPerson ? null : { value: layoutMode, onChange: setLayoutMode }}
        projection={!firstPerson && singlePane ? {
          // `projection` 为 null = 还没被切过：显示该格机位的默认投影（与 three 侧 defaultProjectionFor 同口径）
          value: projection ?? rigForPaneCamera(paneSpecs[0]!.camera).projection,
          onToggle: () => setProjection((value) =>
            ((value ?? rigForPaneCamera(paneSpecs[0]!.camera).projection) === "perspective" ? "orthographic" : "perspective")),
        } : null}
        grid={firstPerson ? null : { visible: gridVisible, onToggle: () => setGridVisible((v) => !v) }}
        wireframe={{ on: wireframe, onToggle: () => setWireframe((v) => !v) }}
        /*
          地形参照层（world 的 collider 网格）：**这条渲染路径在 PlayCanvas 分支还不存在**
          （three 侧挂的是 `WorldColliderMesh`，它 100% 透明、一个像素都不画）。传 `null` ⇒
          按钮不出现，而不是留一个点了没反应的按钮。见 PLAYCANVAS_MIGRATION.md 的未接清单。
        */
        worldCollider={null}
        firstPerson={hasContent ? {
          active: firstPerson,
          onToggle: () => setFirstPerson((value) => {
            if (!value) setLayoutMode(1); // 第一人称只在单窗格下有意义（three 侧同样强制 1 格）
            return !value;
          }),
        } : null}
        hasContent={hasContent}
        objectCount={mountedObjects.length}
        selectedCount={props.selectedIds.size}
        splatBackground={splatBackground}
      />
      {status ? (
        <div className="absolute inset-0 grid place-items-center bg-surface/80 text-xs text-ink-subtle">
          PlayCanvas 视口初始化失败：{status}
        </div>
      ) : null}
    </div>
  );
}

/**
 * 引擎侧：把一张覆盖贴图的 URL 变成 PlayCanvas `Texture`。
 * 用 `assets.loadFromUrl(url, "texture", cb)`——**回调的 err 才是权威**（只监听 error 事件会漏）。
 */
