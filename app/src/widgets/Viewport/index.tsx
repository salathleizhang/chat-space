import { ArrowsClockwiseIcon } from "@phosphor-icons/react/ArrowsClockwise";
import { ArrowsOutCardinalIcon } from "@phosphor-icons/react/ArrowsOutCardinal";
import { ArrowsOutIcon } from "@phosphor-icons/react/ArrowsOut";
import { BoundingBoxIcon } from "@phosphor-icons/react/BoundingBox";
import { CubeIcon } from "@phosphor-icons/react/Cube";
import { GlobeSimpleIcon } from "@phosphor-icons/react/GlobeSimple";
import { GridFourIcon } from "@phosphor-icons/react/GridFour";
import { MountainsIcon } from "@phosphor-icons/react/Mountains";
import { PerspectiveIcon } from "@phosphor-icons/react/Perspective";
import { PersonSimpleWalkIcon } from "@phosphor-icons/react/PersonSimpleWalk";
import { SquareIcon } from "@phosphor-icons/react/Square";
import { SquareSplitHorizontalIcon } from "@phosphor-icons/react/SquareSplitHorizontal";
import { SquaresFourIcon } from "@phosphor-icons/react/SquaresFour";
import { VideoCameraIcon } from "@phosphor-icons/react/VideoCamera";
import { Environment } from "@react-three/drei/core/Environment";
import { WebGPUView } from "./WebGPUView";
import { ProjectRenderRuntime, FirstPersonView } from "./ProjectRenderRuntime";
import { PanePickTarget } from "./PanePicking";
import { VIEW_LAYERS } from "./sharedPicking";
import { useFrame } from "@react-three/fiber";
import { WebGPUCanvas } from "../../shared/rendering/WebGPUCanvas";
import { captureQueue } from "../../shared/rendering/CaptureQueue";
import { resourcePath } from "../../shared/rendering/resourcePath";
import { WebGPUGrid } from "./WebGPUGrid";
import {
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type RefObject,
} from "react";
import * as THREE from "three";
import { useEnvironmentTexture } from "../../shared/lib/envTexture";
import type { AssetMaterial, AssetTransform, LibraryAsset } from "../../shared/lib/libraryApi";
import { libraryUrl, selectProjectSkybox } from "../../shared/lib/libraryApi";
import { ResettableErrorBoundary } from "../../shared/lib/ResettableErrorBoundary";
import { Badge, Panel, ToolbarButton, Tooltip } from "../../shared/ui";
import type { CameraTarget } from "./CameraRig";
import { FirstPersonRig } from "./FirstPersonRig";
import { ModelMesh } from "./ModelMesh";
import { LAYOUTS, gridTemplateFor, type CameraKind, type LayoutMode, type Projection } from "./paneLayouts";
import { PaneCamera } from "./PaneCamera";
import { computeSceneLayout, type AssetPlacement } from "./scenePlacement";
import type { LiveTransforms } from "./liveTransforms";
import {
  TransformGizmo,
  TRANSFORM_MODES,
  type GizmoMember,
  type TransformMode,
  type TransformSpace,
} from "./TransformGizmo";
import { ViewportPane } from "./ViewportPane";
import WorldColliderMesh from "./WorldColliderMesh";

interface ViewportProps {
  /** 项目全部资产：共享场景一次性渲染，不再按选中切换 */
  assets: LibraryAsset[];
  /** 当前聚焦的资产 id（双击设置），相机飞过去；null/world 资产回默认总览机位 */
  focusedId: string | null;
  /** 当前选中的资产 id 集合（与 ModelList 共享，上层 AppDashboard 持有） */
  selectedIds: ReadonlySet<string>;
  /** 当前生效的天空盒资产 slug（单例指针）；无匹配资产时回退写死的 /env/sky.exr */
  currentSkybox?: string;
  /** 当前生效的 World 资产 slug；旧项目无指针时兼容性回退到第一个可渲染世界 */
  currentWorld?: string;
  /** 用户用 gizmo 调过的资产摆放（按 assetSlug，来自 scene.json）；没记录的走网格默认位 */
  transforms?: Record<string, AssetTransform>;
  /** 右侧栏改过的材质覆盖（按 assetSlug，来自 scene.json 的 materials 表）；没记录的渲染原材质 */
  materials?: Record<string, AssetMaterial>;
  /**
   * 拖拽期间的实时摆放表。**由上层创建并注入**：右侧栏要订阅同一份表才能让数字跟着手走，
   * 所以它不能住在这里（见 liveTransforms.ts）。
   */
  live: LiveTransforms;
  /** gizmo 松手时提交这一轮动过的资产摆放（乐观更新 + 防抖落盘在上层） */
  onTransformCommit?: (updates: Record<string, AssetTransform>) => void;
  /** 点击场景中的模型：additive（shift）时增减，否则替换为只含这一个 */
  onSelectAsset: (asset: LibraryAsset, additive: boolean) => void;
  /** 点击场景空白处：清空选中 */
  onClearSelection: () => void;
  /** 双击场景中的模型：相机飞过去 */
  onFocusAsset: (asset: LibraryAsset) => void;
  /** 拖入本地模型文件（一批 File，可能含 .mtl/贴图附属文件） */
  onImportModel?: (files: File[]) => void;
}

type ViewMode = "orbit" | "firstPerson";

/** Blender 式默认机位：斜上方俯视场景原点 */
const ORBIT_CAMERA = { position: [5, 4.5, 5] as [number, number, number], fov: 45 };
const DEFAULT_LOOK_AT: [number, number, number] = [0, 0, 0];
/** 聚焦某个对象时，相机相对该对象网格坐标的固定偏移 */
const FOCUS_CAMERA_OFFSET: [number, number, number] = [3, 2, 3];

const LAYOUT_ICON = {
  1: SquareIcon,
  2: SquareSplitHorizontalIcon,
  4: SquaresFourIcon,
} as const;
const TRANSFORM_ICON = {
  translate: ArrowsOutCardinalIcon,
  rotate: ArrowsClockwiseIcon,
  scale: ArrowsOutIcon,
} as const;
/** 快捷键跟 Blender 对齐（G/R/S），写进 tooltip 里让用户发现得到 */
const TRANSFORM_LABEL: Record<TransformMode, string> = {
  translate: "Move (G)",
  rotate: "Rotate (R)",
  scale: "Scale (S)",
};

const LAYOUT_LABEL: Record<LayoutMode, string> = {
  1: "Single view",
  2: "Two views",
  4: "Four views (Blender layout)",
};

/** 窗格默认投影：透视机位默认透视，其余轴向预设机位默认正交——用户可随时切换，与 kind 解耦 */
function defaultProjectionFor(camera: CameraKind): Projection {
  return camera === "perspective" ? "perspective" : "orthographic";
}

const SplatModel = lazy(() => import("./SplatModel"));

/** 天空盒背景球半径（世界单位）：要远大于任意窗格的可见范围，见 SkyBackdrop 说明 */
const SKY_BACKDROP_RADIUS = 200;
const FIRST_PERSON_LOCK_SELECTOR = "[data-viewport-first-person-lock]";

/**
 * 用一个跟随相机、内壁贴图的大球替代 drei Environment 的 background：
 * three.js 内置的 scene.background 渲染靠"把顶点深度强制设成 far 平面"的戏法，
 * 让一个 1×1×1 的立方体在透视投影下（靠透视除法）撑满整个画面；这个戏法
 * 只在透视相机下成立——正交相机没有透视除法，立方体的世界尺寸会直接决定
 * 屏幕占比，于是天空盒在正交窗格里就只剩画面中间一小块（顶视图/前视图/
 * 右视图都会复现）。这里换成一个半径够大、真的跟着相机走的球体网格，
 * 对透视和正交相机都成立。
 */
function SkyBackdrop({ texture }: { texture: THREE.Texture }) {
  const ref = useRef<THREE.Mesh>(null);

  return (
    <mesh ref={ref} renderOrder={-1} frustumCulled={false} onBeforeRender={(_renderer, _scene, camera) => {
      if (!ref.current) return;
      camera.getWorldPosition(ref.current.position);
      ref.current.updateMatrixWorld();
    }}>
      <sphereGeometry args={[SKY_BACKDROP_RADIUS, 32, 32]} />
      <meshBasicMaterial map={texture} side={THREE.BackSide} depthWrite={false} toneMapped={false} />
    </mesh>
  );
}

/**
 * 背景与 IBL 必须共用由我们持有的纹理，再把 `map` 交给 drei Environment。
 * 若传 `files`，EnvironmentCube 会在任意一个窗格卸载时直接 dispose 全局共享纹理；
 * StrictMode 的模拟卸载、切分屏或缩略图任务都可能让仍在渲染的背景丢一帧后重传，
 * 也就是用户看到的天空盒闪烁。
 */
function SkyboxEnvironment({ url }: { url: string }) {
  const texture = useEnvironmentTexture(url);
  return (
    <>
      <SkyBackdrop texture={texture} />
      <Environment map={texture} />
    </>
  );
}

interface SceneContentsProps {
  worldAsset: LibraryAsset | null;
  placedAssets: LibraryAsset[];
  layout: Map<string, AssetPlacement>;
  showGrid: boolean;
  /** 是否把 world 的 collider 网格渲染成地形参照线框（见 WorldColliderMesh） */
  showWorldCollider: boolean;
  /** 环境贴图 URL：当前天空盒资产的 HDR，无则回退写死的默认 sky.exr */
  skyboxUrl: string;
  /** 天空盒资产重扫代次；原位修复后递增，纳入错误边界 resetKey 以清掉旧的拒绝缓存 */
  skyboxRevision: number;
  selectedIds: ReadonlySet<string>;
  /** 材质覆盖表（按 assetSlug），与 transforms 一样来自上层共享快照 */
  materials: Record<string, AssetMaterial>;
  /** 跨窗格共享的实时摆放表（gizmo 拖拽期间用，见 PlacedAsset 与 TransformGizmo 说明） */
  live: LiveTransforms;
  objects: Map<string, THREE.Object3D>;
  hoveredByLayer: Record<number, string>;
  viewLayers: number[];
}

/** One project-owned model instance; per-view proxies handle picking. */
const PlacedAsset = memo(function PlacedAsset({
  asset,
  placement,
  material,
  live,
  highlight,
  highlightMask,
  objects,
}: {
  asset: LibraryAsset;
  /** 网格默认位，或用户 gizmo 调过后落在 scene.json 里的摆放（见 scenePlacement.ts） */
  placement: AssetPlacement;
  /** 该资产的材质覆盖；undefined 即渲染供应商原材质 */
  material?: AssetMaterial;
  /** 跨窗格共享的实时摆放表：gizmo 拖拽期间由本组件每帧读取（见下方说明） */
  live: LiveTransforms;
  highlight: "none" | "hover" | "selected";
  highlightMask: number;
  objects: Map<string, THREE.Object3D>;
}) {
  const groupRef = useRef<THREE.Group>(null);
  const register = useCallback((group: THREE.Group | null) => {
    groupRef.current = group;
    if (group) objects.set(asset.id, group);
    else objects.delete(asset.id);
  }, [objects, asset.id]);

  /*
    gizmo 拖拽期间的实时跟随：变换值只写进共享的 live 表，由这里每帧应用到自己的 group
    上——绕开 React 是刻意的，拖拽时每帧 setState 会把整棵场景树重协调一遍，必卡；而
    所有窗格绘制同一个 group，每帧只应用一次实时变换。
    松手后表被清空，这里就不再插手，最终值经 props 正常回到 React 手里（两者相等，无跳变）。
  */
  useFrame(() => {
    const group = groupRef.current;
    if (!group || live.size === 0) return;
    const dragged = live.get(asset.id);
    if (!dragged) return;
    group.position.fromArray(dragged.position);
    group.rotation.fromArray(dragged.rotation);
    group.scale.fromArray(dragged.scale);
  });

  return (
    <group
      ref={register}
      name={`asset:${asset.id}`}
      position={placement.position}
      rotation={placement.rotation}
      scale={placement.scale}

    >
      <ModelMesh asset={asset} highlight={highlight} highlightMask={highlightMask} material={material} />
    </group>
  );
});

/** Shared project content stays mounted when layouts or camera modes change. */
function SceneContents({
  worldAsset,
  placedAssets,
  layout,
  showGrid,
  showWorldCollider,
  skyboxUrl,
  skyboxRevision,
  selectedIds,
  materials,
  live,
  objects,
  hoveredByLayer,
  viewLayers,
}: SceneContentsProps) {
  return (
    <>
      <ResettableErrorBoundary resetKey={`${skyboxUrl}|${skyboxRevision}`} fallback={null}>
        <Suspense fallback={null}>
          <SkyboxEnvironment url={skyboxUrl} />
        </Suspense>
      </ResettableErrorBoundary>
      <ambientLight intensity={0.6} />
      <directionalLight position={[4, 6, 4]} intensity={1.4} />
      <directionalLight position={[-4, 2, -3]} intensity={0.4} />
      {/*
        每个资产一个独立 Suspense 边界，绝不能用一个边界包住整份列表：
        Suspense 一挂起就会把边界内**全部** children 摘掉（R3F 下即从场景图移除），
        于是导入/生成一个新模型时，只有新模型在加载，画面上却是所有模型先消失、
        等它加载完再一起回来（旧模型命中 loader 缓存，看起来就像"全部重载了一遍"）。
        拆成每资产一个边界后，挂起只影响新来的那一个。
      */}
      {worldAsset?.spzPath && worldAsset.worldSemantics && (
        <ResettableErrorBoundary
          resetKey={`${worldAsset.spzPath}|${worldAsset.resourceRevision ?? 0}`}
          fallback={null}
        >
          <Suspense fallback={null}>
            <SplatModel
              url={`${libraryUrl(worldAsset.spzPath)}?revision=${worldAsset.resourceRevision ?? 0}`}
              semantics={worldAsset.worldSemantics}
              viewLayers={viewLayers}
            />
          </Suspense>
        </ResettableErrorBoundary>
      )}
      {/*
        world 的 collider 网格，只作地形参照（见 WorldColliderMesh）。必须与泼溅用
        同一份 worldTransform：World Labs 的 +Y 朝下，两者不一起翻就会互相错位。
      */}
      {showWorldCollider && worldAsset?.modelPath && worldAsset.worldSemantics && (
        <ResettableErrorBoundary
          resetKey={`${worldAsset.modelPath}|${worldAsset.resourceRevision ?? 0}`}
          fallback={null}
        >
          <Suspense fallback={null}>
            <WorldColliderMesh
              key={`${worldAsset.modelPath}|${worldAsset.resourceRevision ?? 0}`}
              url={`${libraryUrl(worldAsset.modelPath)}?revision=${worldAsset.resourceRevision ?? 0}`}
              semantics={worldAsset.worldSemantics}
            />
          </Suspense>
        </ResettableErrorBoundary>
      )}
      {placedAssets.map((asset) => {
        const placement = layout.get(asset.id);
        if (!placement) return null;
        const hoverMask = Object.entries(hoveredByLayer).reduce((mask, [layer, id]) => id === asset.id ? mask | (1 << Number(layer)) : mask, 0);
        return (
          <Suspense key={asset.id} fallback={null}>
            <PlacedAsset
              asset={asset}
              placement={placement}
              material={materials[asset.assetSlug]}
              live={live}
              highlight={
                selectedIds.has(asset.id)
                  ? "selected"
                  : hoverMask !== 0
                    ? "hover"
                    : "none"
              }
              highlightMask={selectedIds.has(asset.id) ? 1 : hoverMask}
              objects={objects}
            />
          </Suspense>
        );
      })}
      {showGrid && (
        <WebGPUGrid />
      )}
    </>
  );
}

const DEFAULT_SKYBOX_URL = "/env/sky.exr";
/** 没有材质覆盖时的共用空表，免得每次渲染造新引用戳穿 PlacedAsset 的 memo */
const NO_MATERIALS: Record<string, AssetMaterial> = {};

export const Viewport = memo(function Viewport({
  assets,
  focusedId,
  selectedIds,
  currentSkybox,
  currentWorld,
  transforms,
  materials = NO_MATERIALS,
  live,
  onTransformCommit,
  onSelectAsset,
  onClearSelection,
  onFocusAsset,
  onImportModel,
}: ViewportProps) {
  const [mode, setMode] = useState<ViewMode>("orbit");
  const [showGrid, setShowGrid] = useState(true);
  /** world 的地形参照线框：默认开，方便看清 collider 与泼溅是否对齐、把模型摆到地面上 */
  const [showWorldCollider, setShowWorldCollider] = useState(true);
  const [paneLayout, setPaneLayout] = useState<LayoutMode>(1);
  const [transformMode, setTransformMode] = useState<TransformMode>("translate");
  const [transformSpace, setTransformSpace] = useState<TransformSpace>("world");
  /** 每个窗格当前的透视/正交投影，覆盖 defaultProjectionFor 的默认值；按 pane.id 记，切换分屏布局也不丢 */
  const [projectionOverrides, setProjectionOverrides] = useState<Partial<Record<string, Projection>>>({});
  /** 拖入本地模型文件的悬停高亮；只影响这一层遮罩渲染，不传进 SceneContents */
  const [isDragOver, setIsDragOver] = useState(false);
  const dragDepthRef = useRef(0);

  const handleDragEnter = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setIsDragOver(true);
  };
  const handleDragOver = (event: DragEvent<HTMLDivElement>) => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
  };
  const handleDragLeave = () => {
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setIsDragOver(false);
  };
  const handleDrop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault();
    dragDepthRef.current = 0;
    setIsDragOver(false);
    onImportModel?.(Array.from(event.dataTransfer.files));
  };

  const containerRef = useRef<HTMLDivElement | null>(null);
  const perspRef = useRef<HTMLDivElement | null>(null);
  const topRef = useRef<HTMLDivElement | null>(null);
  const frontRef = useRef<HTMLDivElement | null>(null);
  const rightRef = useRef<HTMLDivElement | null>(null);
  // refs 本身是稳定的，但这个查找表字面量每次渲染都会新建一个对象；
  // 用 useMemo 固定引用，避免传给多个子组件（ViewportPane/PaneCamera）时
  // 每次都被判定为"变了"
  const paneRefs = useMemo<Record<string, RefObject<HTMLDivElement | null>>>(
    () => ({ persp: perspRef, top: topRef, front: frontRef, right: rightRef }),
    [],
  );

  // 每个窗格各有一份 SceneContents，worldAsset/placedAssets 不缓存的话，
  // 每次渲染都会新建数组/对象引用，让所有窗格的 SceneContents 一起被认为
  // "props 变了"；用 useMemo 固定引用，只在 assets 真的变化时才重新计算
  const worldAsset = useMemo(
    () =>
      (currentWorld
        ? assets.find(
            (a) => a.kind === "world" && a.assetSlug === currentWorld && a.spzPath,
          )
        : undefined) ??
      assets.find((a) => a.kind === "world" && a.spzPath) ??
      null,
    [assets, currentWorld],
  );
  const placedAssets = useMemo(
    () => assets.filter((a) => a.kind !== "world" && a.modelPath),
    [assets],
  );
  const layout = useMemo(() => computeSceneLayout(assets, transforms), [assets, transforms]);
  const skyboxAsset = selectProjectSkybox(assets, currentSkybox);
  const skyboxUrl = skyboxAsset?.hdrPath
    ? resourcePath(libraryUrl(skyboxAsset.hdrPath), skyboxAsset.resourceRevision)
    : DEFAULT_SKYBOX_URL;

  const isFocusable = focusedId != null && focusedId !== worldAsset?.id;
  // 相机只关心摆放里的位置分量（rotation/scale 是对象自己的姿态，不影响飞向哪里）
  const focusedPos = isFocusable ? layout.get(focusedId!)?.position : undefined;

  const cameraTarget = useMemo<CameraTarget>(() => {
    if (focusedPos) {
      return {
        camPos: [
          focusedPos[0] + FOCUS_CAMERA_OFFSET[0],
          focusedPos[1] + FOCUS_CAMERA_OFFSET[1],
          focusedPos[2] + FOCUS_CAMERA_OFFSET[2],
        ],
        lookAt: focusedPos,
      };
    }
    return { camPos: ORBIT_CAMERA.position, lookAt: DEFAULT_LOOK_AT };
  }, [focusedPos]);
  /*
    相机飞行目标经 ref 交给 CameraRig 的 useFrame 每帧读取（不走 props，避免场景刷新
    换了坐标对象引用就触发一次误动画）。同步放在 layout effect 而不是渲染期赋值：
    渲染期写对被并发丢弃的那次渲染同样生效，会让 ref 指向一个从未提交的目标；
    layout effect 在 commit 阶段同步跑完，而 useFrame 走的是 rAF，必然排在它之后。
  */
  const cameraTargetRef = useRef(cameraTarget);
  useLayoutEffect(() => {
    cameraTargetRef.current = cameraTarget;
  }, [cameraTarget]);

  const firstPerson = mode === "firstPerson";
  const hasContent = worldAsset != null || placedAssets.length > 0;
  const panes = LAYOUTS[paneLayout];
  const [objects] = useState(() => new Map<string, THREE.Object3D>());
  const [hoveredByLayer, setHoveredByLayer] = useState<Record<number, string>>({});
  const viewLayers = useMemo(() => firstPerson ? [VIEW_LAYERS.persp!] : panes.map((pane) => VIEW_LAYERS[pane.id]!), [firstPerson, panes]);
  const handleHover = useCallback((layer: number, id: string, entered: boolean) => {
    setHoveredByLayer((current) => {
      if (entered) return current[layer] === id ? current : { ...current, [layer]: id };
      if (current[layer] !== id) return current;
      const next = { ...current }; delete next[layer]; return next;
    });
  }, []);
  useEffect(() => {
    document.body.style.cursor = Object.keys(hoveredByLayer).length ? "pointer" : "";
    return () => { document.body.style.cursor = ""; };
  }, [hoveredByLayer]);

  /*
    gizmo 拖拽的共享状态：
    - live：拖拽期间的实时摆放表，**由上层注入**（见 liveTransforms.ts）——右侧栏也要订阅它
      才能让数字跟着手走，所以这份状态住在两侧的共同祖先里。各窗格每帧命令式读它，不重渲染。
    - pickSuppressedRef：正在操作 gizmo。gizmo 的网格没有 R3F 事件处理器，不在拾取集合
      （internal.interaction）里，所以点在它上面对 R3F 而言就是"点空了"——不挡一下的话，
      在 gizmo 上小幅拖动后松手会被判成点空白而清空选中，选中一没 gizmo 也就跟着消失了；
      拖动幅度小于 2px 阈值时，还可能把 gizmo 背后的另一个模型给选上。
  */
  const pickSuppressedRef = useRef(false);

  const handleSelectAsset = useCallback(
    (asset: LibraryAsset, additive: boolean) => {
      if (pickSuppressedRef.current) return;
      onSelectAsset(asset, additive);
    },
    [onSelectAsset],
  );
  const handleFocusAsset = useCallback(
    (asset: LibraryAsset) => {
      if (pickSuppressedRef.current) return;
      onFocusAsset(asset);
    },
    [onFocusAsset],
  );
  /**
   * "点了空白处" 的判定。R3F 只保证"这次点击没打中任何可拾取对象"，而 Canvas 的
   * `eventSource` 是整个视口容器——**叠在画布上的 chrome（右下角控制簇、窗格角标按钮）
   * 被点到时同样会冒泡进来并算作没打中**，照单全收的话点一下"移动/旋转/缩放"就把选中
   * 清了，按钮自己跟着消失（它们只在有选中时渲染），表现就是"这几个按钮点不动"。
   * 所以改成正向判定：只有落在画布本身或窗格占位层（`data-viewport-pane`）上才是空白，
   * 往后再往视口里加任何悬浮控件都不会重蹈覆辙。
   */
  const handlePointerMissed = useCallback(
    (event: MouseEvent) => {
      if (pickSuppressedRef.current) return;
      const target = event.target;
      if (!(target instanceof HTMLElement)) return;
      if (target.tagName !== "CANVAS" && target.dataset.viewportPane === undefined) return;
      onClearSelection();
    },
    [onClearSelection],
  );

  /** 选中且真的摆在场景里的资产：gizmo 作用的对象（多选时整组绕包围中心变换） */
  const gizmoMembers = useMemo<GizmoMember[]>(() => {
    if (selectedIds.size === 0) return [];
    const members: GizmoMember[] = [];
    for (const asset of placedAssets) {
      if (!selectedIds.has(asset.id)) continue;
      const placement = layout.get(asset.id);
      if (placement) members.push({ id: asset.id, assetSlug: asset.assetSlug, placement });
    }
    return members;
  }, [placedAssets, selectedIds, layout]);

  /** Blender 式快捷键：G 移动 / R 旋转 / S 缩放。输入框里打字时不抢键 */
  useEffect(() => {
    if (firstPerson || gizmoMembers.length === 0) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target?.isContentEditable || /^(input|textarea|select)$/i.test(target?.tagName ?? "")) {
        return;
      }
      const next: TransformMode | undefined = { g: "translate", r: "rotate", s: "scale" }[
        event.key.toLowerCase()
      ] as TransformMode | undefined;
      if (!next) return;
      event.preventDefault();
      setTransformMode(next);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [firstPerson, gizmoMembers.length]);

  /** 单窗格布局下唯一的那个窗格，用于右下角全局透视/正交切换按钮 */
  const singlePane = panes.length === 1 ? panes[0] : undefined;

  const projectionFor = (pane: (typeof panes)[number]): Projection =>
    projectionOverrides[pane.id] ?? defaultProjectionFor(pane.camera);
  const toggleProjection = (pane: (typeof panes)[number]) => {
    setProjectionOverrides((prev) => {
      const current = prev[pane.id] ?? defaultProjectionFor(pane.camera);
      return { ...prev, [pane.id]: current === "perspective" ? "orthographic" : "perspective" };
    });
  };

  return (
    <div
      ref={containerRef}
      className="absolute inset-0 bg-canvas"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
      onPointerMove={() => captureQueue.interaction()}
      onPointerDown={() => captureQueue.interaction()}
      onWheel={() => captureQueue.interaction()}
    >
      {isDragOver && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-[inherit] bg-fill-active text-sm text-ink">
          Drop to import model
        </div>
      )}
      <WebGPUCanvas
        className="!absolute inset-0"
        camera={ORBIT_CAMERA}
        dpr={[1, 1.5]}
        eventSource={containerRef as RefObject<HTMLElement>}
        frameloop="demand"
        /*
          点击没打中任何可拾取对象时 R3F 会回调这里（它内部已按 2px 位移阈值
          过滤掉"拖拽转视角"那种假点击）。天空球与网格都没有事件处理器、不在
          拾取集合里，所以点它们等同于点空白 —— 正是清空选中该发生的时机。
          但"没打中"不等于"点在了 3D 空白处"，还要再筛一道，见 handlePointerMissed。
        */
        onPointerMissed={firstPerson ? undefined : handlePointerMissed}
      >
        <ProjectRenderRuntime>
          <SceneContents
            worldAsset={worldAsset}
            placedAssets={placedAssets}
            layout={layout}
            showGrid={!firstPerson && showGrid}
            showWorldCollider={!firstPerson && showWorldCollider}
            skyboxUrl={skyboxUrl}
            skyboxRevision={skyboxAsset?.resourceRevision ?? 0}
            selectedIds={selectedIds}
            materials={materials}
            live={live}
            objects={objects}
            hoveredByLayer={hoveredByLayer}
            viewLayers={viewLayers}
          />
          {!firstPerson && panes.map((pane) => (
            <WebGPUView key={pane.id} id={pane.id} layer={VIEW_LAYERS[pane.id]!} track={paneRefs[pane.id] as RefObject<HTMLElement>}>
              {placedAssets.map((asset) => <PanePickTarget key={asset.id} asset={asset} objects={objects}
                layer={VIEW_LAYERS[pane.id]!} onSelect={handleSelectAsset} onFocus={handleFocusAsset} onHover={handleHover} />)}
              {onTransformCommit && <TransformGizmo members={gizmoMembers} mode={transformMode} space={transformSpace}
                paneRef={paneRefs[pane.id]!} live={live} pickSuppressedRef={pickSuppressedRef} onCommit={onTransformCommit} />}
              <PaneCamera
                kind={pane.camera}
                projection={projectionFor(pane)}
                orbitCamera={ORBIT_CAMERA}
                focusKey={focusedId ?? "__overview__"}
                cameraTargetRef={cameraTargetRef}
                paneRef={paneRefs[pane.id] as RefObject<HTMLDivElement | null>}
              />
            </WebGPUView>
          ))}
          {firstPerson && <><FirstPersonView /><FirstPersonRig lockSelector={FIRST_PERSON_LOCK_SELECTOR} /></>}
        </ProjectRenderRuntime>
      </WebGPUCanvas>

      {/*
        窗格占位层必须叠在 Canvas 之上：WebGPUView 的 track 要求原生指针事件的
        event.target 严格等于被 track 的 DOM 节点，Canvas 盖在上面时点击永远落在
        canvas 上，各窗格的 OrbitControls/坐标轴球会整体失灵。放在 Canvas 后面
        （DOM 序更靠后 = 层叠更靠上）之后，点击才能落到具体窗格的 div 上，
        边框/角标文字也才不会被 canvas 挡住。
      */}
      <div className="absolute inset-0 grid" style={gridTemplateFor(paneLayout)}>
        {firstPerson ? (
          // PointerLockControls 默认监听整个 document，点 Agent/工具栏也会锁鼠标；
          // 用独立捕获面只允许真正点击 3D 画面时进入第一人称。
          <div data-viewport-first-person-lock="" />
        ) : (
          panes.map((pane) => (
            <ViewportPane
              key={pane.id}
              ref={paneRefs[pane.id]}
              label={pane.label}
              bordered={panes.length > 1}
              projection={projectionFor(pane)}
              onToggleProjection={() => toggleProjection(pane)}
            />
          ))
        )}
      </div>

      {/* 右下角悬浮控件：变换工具与视图控制是两件事，各自一个面板并排（变换那组只在有选中时出现） */}
      <div className="absolute bottom-4 right-4 z-10 flex items-center gap-2">
        {/* 变换工具只在选中了东西时出现——没有作用对象的移动/旋转/缩放按钮是空按钮 */}
        {!firstPerson && gizmoMembers.length > 0 && (
          <Panel className="flex items-center gap-1 rounded-full! p-1 animate-chrome-enter">
            {TRANSFORM_MODES.map((m) => (
              <Tooltip key={m} content={TRANSFORM_LABEL[m]} side="top">
                <ToolbarButton
                  selected={transformMode === m}
                  icon={TRANSFORM_ICON[m]}
                  aria-label={TRANSFORM_LABEL[m]}
                  onClick={() => setTransformMode(m)}
                />
              </Tooltip>
            ))}
            <Tooltip
              content={
                transformMode === "scale"
                  ? "Scale uses the object's local axes"
                  : transformSpace === "world"
                    ? "Current: world coordinates (click for local)"
                    : "Current: local coordinates (click for world)"
              }
              side="top"
            >
              <ToolbarButton
                // 缩放模式下 TransformControls 内部强制走 local，按钮留着可点会是句谎话
                disabled={transformMode === "scale"}
                icon={transformSpace === "world" ? GlobeSimpleIcon : BoundingBoxIcon}
                aria-label="Toggle world/local coordinates"
                onClick={() => setTransformSpace((s) => (s === "world" ? "local" : "world"))}
              />
            </Tooltip>
          </Panel>
        )}

        {/* 视图控制：分屏布局 + 透视/正交 + 网格开关 + 第一人称切换 */}
        <Panel className="flex items-center gap-1 rounded-full! p-1 animate-chrome-enter">
          {!firstPerson && (
            <div className="flex items-center gap-1">
              {([1, 2, 4] as const).map((n) => (
                <Tooltip key={n} content={LAYOUT_LABEL[n]} side="top">
                  <ToolbarButton
                    selected={paneLayout === n}
                    icon={LAYOUT_ICON[n]}
                    aria-label={LAYOUT_LABEL[n]}
                    onClick={() => setPaneLayout(n)}
                  />
                </Tooltip>
              ))}
            </div>
          )}
          {!firstPerson && singlePane && (
            <Tooltip
              content={projectionFor(singlePane) === "perspective" ? "Switch to orthographic view" : "Switch to perspective view"}
              side="top"
            >
              <ToolbarButton
                icon={projectionFor(singlePane) === "perspective" ? PerspectiveIcon : CubeIcon}
                aria-label="Toggle perspective/orthographic view"
                onClick={() => toggleProjection(singlePane)}
              />
            </Tooltip>
          )}
          {!firstPerson && (
            <Tooltip content={showGrid ? "Hide grid" : "Show grid"} side="top">
              <ToolbarButton
                selected={showGrid}
                icon={GridFourIcon}
                aria-label={showGrid ? "Hide grid" : "Show grid"}
                onClick={() => setShowGrid((g) => !g)}
              />
            </Tooltip>
          )}
          {!firstPerson && worldAsset?.modelPath && worldAsset.worldSemantics && (
            <Tooltip
              content={
                showWorldCollider
                  ? "Hide world terrain (collider mesh)"
                  : "Show world terrain (collider mesh)"
              }
              side="top"
            >
              <ToolbarButton
                selected={showWorldCollider}
                icon={MountainsIcon}
                aria-label={
                  showWorldCollider
                    ? "Hide world terrain (collider mesh)"
                    : "Show world terrain (collider mesh)"
                }
                onClick={() => setShowWorldCollider((v) => !v)}
              />
            </Tooltip>
          )}
          {hasContent && (
            <Tooltip
              content={firstPerson ? "Return to orbit top view" : "First-person navigation (WASD to move)"}
              side="top"
            >
              <ToolbarButton
                selected={firstPerson}
                icon={firstPerson ? VideoCameraIcon : PersonSimpleWalkIcon}
                aria-label={firstPerson ? "Return to orbit view" : "Enter first-person view"}
                onClick={() =>
                  setMode((m) => {
                    const next = m === "orbit" ? "firstPerson" : "orbit";
                    if (next === "firstPerson") setPaneLayout(1);
                    return next;
                  })
                }
              />
            </Tooltip>
          )}
        </Panel>
      </div>

      {hasContent && (
        <>
          {firstPerson && (
            <Panel className="pointer-events-none absolute top-16 left-1/2 -translate-x-1/2 px-3 py-1.5 text-xs text-ink-subtle">
              Click the viewport to lock view · WASD to move · Shift to sprint · Esc to release mouse
            </Panel>
          )}

          <div className="pointer-events-none absolute bottom-24 left-1/2 flex -translate-x-1/2 items-center gap-2">
            <Badge>{placedAssets.length} objects</Badge>
            {selectedIds.size > 0 && <Badge>Selected: {selectedIds.size}</Badge>}
            {worldAsset && <Badge>Gaussian splat background</Badge>}
          </div>
        </>
      )}

    </div>
  );
});
