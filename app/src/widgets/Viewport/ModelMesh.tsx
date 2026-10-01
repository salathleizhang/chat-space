import { Center } from "@react-three/drei/core/Center";
import { useGLTF } from "@react-three/drei/core/Gltf";
import { useAnimations } from "@react-three/drei/core/useAnimations";
import { useFrame, useLoader, useThree } from "@react-three/fiber";
import {
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import * as THREE from "three";
import { FBXLoader } from "three/addons/loaders/FBXLoader.js";
import * as SkeletonUtils from "three/addons/utils/SkeletonUtils.js";
import type { Object3D } from "three";
import type { LibraryAsset, AssetMaterial } from "../../shared/lib/libraryApi";
import { libraryUrl } from "../../shared/lib/libraryApi";
import { ResettableErrorBoundary } from "../../shared/lib/ResettableErrorBoundary";
import { useAssemblyMaterials } from "./materialOverride";
import { needsAnimationFrame } from "./animationLoop";
import { mergeLoadedModel, type LoadedModel } from "./modelAssembly";
import { MTLLoader, OBJLoader } from "./modelLoaders";
import { useModelResource } from "../../shared/rendering/useModelResource";
import { ModelDescriptionPublisher } from "./publishModelDescription";
import { disposeSkeletons } from "../../shared/rendering/ModelResources";
import { resourcePath } from "../../shared/rendering/resourcePath";

/**
 * 按资产 modelExt 分派到对应 loader。分派只此一份：
 * `LoadedAssetObject` 把加载好的 Object3D 交给 children，`ModelMesh`（3D 视口/预览小窗）
 * 拿去渲染，模型栏悬浮卡的贴图预览拿去读材质——两边共用同一份 loader 缓存。
 */

type ModelChildren = (model: LoadedModel) => ReactNode;

function GlbObject({ url, children }: { url: string; children: ModelChildren }) {
  const { scene, animations } = useGLTF(url);
  useModelResource(scene, () => useGLTF.clear(url));
  const model = useMemo<LoadedModel>(
    () => ({ object: scene, animations }),
    [scene, animations],
  );
  return <>{children(model)}</>;
}

/** obj + mtl 与裸 obj 拆成两个组件：hook 不能条件调用，mtlUrl 有无决定的是渲染哪个组件 */
function ObjWithMtlObject({
  url,
  mtlUrl,
  children,
}: {
  url: string;
  mtlUrl: string;
  children: ModelChildren;
}) {
  const materials = useLoader(MTLLoader, mtlUrl);
  const obj = useLoader(OBJLoader, url, (loader) => {
    materials.preload();
    loader.setMaterials(materials);
  });
  useModelResource(obj, () => { useLoader.clear(OBJLoader, url); useLoader.clear(MTLLoader, mtlUrl); });
  const model = useMemo<LoadedModel>(
    () => ({ object: obj, animations: obj.animations }),
    [obj],
  );
  return <>{children(model)}</>;
}

function ObjObject({ url, children }: { url: string; children: ModelChildren }) {
  const obj = useLoader(OBJLoader, url);
  useModelResource(obj, () => useLoader.clear(OBJLoader, url));
  const model = useMemo<LoadedModel>(
    () => ({ object: obj, animations: obj.animations }),
    [obj],
  );
  return <>{children(model)}</>;
}

function FbxObject({ url, children }: { url: string; children: ModelChildren }) {
  const obj = useLoader(FBXLoader, url);
  useModelResource(obj, () => useLoader.clear(FBXLoader, url));
  const model = useMemo<LoadedModel>(
    () => ({ object: obj, animations: obj.animations }),
    [obj],
  );
  return <>{children(model)}</>;
}

function modelExt(path: string): string {
  return path.split("?")[0]?.split(".").pop()?.toLowerCase() ?? "";
}

/** 加载一个明确的模型产物；分段资产由上层为每个部件各挂一份。 */
function ModelPathLoader({
  path,
  mtlPath,
  children,
}: {
  path: string;
  mtlPath: string | null;
  children: ModelChildren;
}) {
  const url = libraryUrl(path);
  switch (modelExt(path)) {
    case "glb":
    case "gltf":
      return <GlbObject url={url} children={children} />;
    case "obj":
      return mtlPath ? (
        <ObjWithMtlObject url={url} mtlUrl={libraryUrl(mtlPath)} children={children} />
      ) : (
        <ObjObject url={url} children={children} />
      );
    case "fbx":
      return <FbxObject url={url} children={children} />;
    default:
      return null;
  }
}

/** useLoader 会把拒绝结果也按 URL 缓存；受控重试前必须把对应条目一起清掉。 */
function clearModelCache(path: string, mtlPath: string | null) {
  const url = libraryUrl(path);
  switch (modelExt(path)) {
    case "glb":
    case "gltf":
      useGLTF.clear(url);
      break;
    case "obj":
      useLoader.clear(OBJLoader, url);
      if (mtlPath) useLoader.clear(MTLLoader, libraryUrl(mtlPath));
      break;
    case "fbx":
      useLoader.clear(FBXLoader, url);
      break;
  }
}

/**
 * 首次失败自动清缓存重试一次。永久坏文件不会无限请求；资产被 repair-assets 原路径回填后，
 * 组件重新挂载时又拥有一次清掉旧拒绝缓存的机会，因此不再要求用户整页刷新。
 */
function RecoverableModelLoader({
  path,
  mtlPath,
  children,
  fallback = null,
  onPermanentError,
}: {
  path: string;
  mtlPath: string | null;
  children: ModelChildren;
  fallback?: ReactNode;
  onPermanentError?: () => void;
}) {
  const [attempt, setAttempt] = useState(0);
  const retriedRef = useRef(false);
  const baseKey = `${path}|${mtlPath ?? ""}`;
  const handleError = useCallback(() => {
    if (retriedRef.current) {
      onPermanentError?.();
      return;
    }
    retriedRef.current = true;
    clearModelCache(path, mtlPath);
    setAttempt(1);
  }, [path, mtlPath, onPermanentError]);

  return (
    <ResettableErrorBoundary
      resetKey={`${baseKey}|${attempt}`}
      fallback={fallback}
      onError={handleError}
    >
      <ModelPathLoader path={path} mtlPath={mtlPath} children={children} />
    </ResettableErrorBoundary>
  );
}

/**
 * 加载失败只隔离当前资产，不能让一个损坏的用户文件把整个 Viewport/列表弹层卸载。
 * fallback 同时兼容 R3F 节点与普通 DOM 节点；资源路径换代后自动重新尝试。
 */
export function LoadedAssetObject({
  asset,
  children,
  fallback = null,
}: {
  asset: LibraryAsset;
  children: (object: Object3D) => ReactNode;
  fallback?: ReactNode;
}) {
  if (!asset.modelPath) return null;
  return (
    <RecoverableModelLoader
      key={`${asset.modelPath}|${asset.mtlPath ?? ""}|${asset.resourceRevision ?? 0}`}
      path={resourcePath(asset.modelPath, asset.resourceRevision)}
      mtlPath={asset.mtlPath ? resourcePath(asset.mtlPath, asset.resourceRevision) : null}
      fallback={fallback}
    >
      {(model) => children(model.object)}
    </RecoverableModelLoader>
  );
}

/** 无高亮 / 悬浮（淡）/ 选中（实），三态只影响线框包围盒，不碰模型自身材质 */
export type Highlight = "none" | "hover" | "selected";

/** 高亮线框颜色，对齐 index.css 的 `--color-accent`（本产品是单色 chrome，没有品牌色） */
const HIGHLIGHT_COLOR = "#ffffff";
/** 悬浮态用同色更淡的线，对应 `--color-ink-faint` 的透明度 */
const HOVER_OPACITY = 0.35;
/** 包围盒外扩比例：严丝合缝贴着模型表面画会和几何体共面 z-fighting，撑开一点点 */
const BOX_PADDING_RATIO = 0.02;

/**
 * 求 root **自身局部坐标系**下的包围盒（不是世界坐标盒）。
 * `Box3.setFromObject` 给的是世界坐标盒，而 `Box3Helper` 每帧按"父节点局部坐标"
 * 摆自己的位置——模型挂在 `<group position>` + drei `<Center>` 的偏移底下，直接拿
 * 世界盒会让线框整体错位到别处。这里逐个 mesh 用 `root.matrixWorld` 的逆变换换算
 * 回 root 局部空间，于是把 helper 直接挂成 root 的子节点就天然对齐，且与 root 挂没挂
 * 进场景、挂在哪一层无关。
 */
function localBounds(root: Object3D) {
  root.updateWorldMatrix(true, true);
  const toLocal = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const matrix = new THREE.Matrix4();
  const box = new THREE.Box3();
  const meshBox = new THREE.Box3();
  root.traverse((child) => {
    const mesh = child as THREE.Mesh;
    if (!mesh.isMesh || !mesh.geometry) return;
    if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
    if (!mesh.geometry.boundingBox) return;
    meshBox.copy(mesh.geometry.boundingBox);
    meshBox.applyMatrix4(matrix.multiplyMatrices(toLocal, mesh.matrixWorld));
    box.union(meshBox);
  });
  if (box.isEmpty()) return box;
  const size = box.getSize(new THREE.Vector3());
  return box.expandByScalar(Math.max(size.x, size.y, size.z) * BOX_PADDING_RATIO);
}

/**
 * 选中/悬浮时套在模型外的线框包围盒。挂成 root 的子节点（见 `localBounds` 说明），
 * `depthTest={false}` 让线框透过模型自身也能看见——选中反馈要在任意视角都读得到，
 * 不该被模型正面挡住。
 *
 * `raycast={() => null}` 不是可选项：由指针状态产生的视觉反馈**绝不能反过来参与命中
 * 判定**，否则状态与命中区互为因果。这个盒子挂在资产 `<group>` 内部，而 R3F 拾取走的是
 * 递归的 `intersectObject(group, true)`，不关掉就会被一起检测；它又是 `LineSegments`，
 * three 对线条用的是 `Raycaster.params.Line.threshold`（默认 1 个世界单位，且会抵消缩放），
 * 于是 12 条棱各自外扩出一层约 1 单位的隐形命中壳。后果有两个：① 悬浮进出用的不是同一条
 * 边界，鼠标离开模型后仍落在壳里，`onPointerOut` 不触发，框粘着不消失；② 网格间距才 3 单位
 * （见 `scenePlacement.ts`），这层壳会把相邻模型的点击整个截走。
 */
function HighlightBox({ root, dim, mask }: { root: Object3D; dim: boolean; mask: number }) {
  const box = useMemo(() => localBounds(root), [root]);
  if (box.isEmpty()) return null;
  return (
    <box3Helper
      args={[box, HIGHLIGHT_COLOR]}
      layers-mask={mask}
      raycast={() => null}
      renderOrder={1}
      material-transparent
      material-opacity={dim ? HOVER_OPACITY : 1}
      material-depthTest={false}
      material-toneMapped={false}
    />
  );
}

/**
 * 每个挂载点渲染**自己的一份克隆**，绝不能直接把 loader 缓存里的那个 Object3D
 * 挂进场景：three.js 的 Object3D 只能有一个父节点，`parent.add(obj)` 会先执行
 * `obj.parent.remove(obj)` 把它从原来的地方摘走；而 `useGLTF`/`useLoader` 对同一个
 * URL 永远返回同一个实例。于是同一个资产被两处同时渲染时，后挂的那处会把先挂的
 * 那份从场景里偷走，先挂的地方模型直接消失——而且卸载时 primitive 只做 remove，
 * 不会还给原主，模型就一直看不见了。踩到过的三处：
 *   ① 导入/生成新模型后列表排队渲缩略图（`ModelList/ThumbnailRenderer`，离屏画布）
 *      → 视口里刚导入的那个模型消失；
 *   ② 双击资产打开 `ModelPreviewWindow` → 视口里同一个模型消失；
 *   ③ 分屏 2/4 窗格（drei `View` 每个窗格一个独立场景）→ 模型只出现在最后一个窗格。
 * `SkeletonUtils.clone` 会正确重建骨架绑定（蒙皮模型必须用它，不能用 `object.clone()`），
 * 几何体与材质仍是共享引用，开销只有场景图节点本身。
 * 读材质抽贴图的 `LoadedAssetObject` 调用方不受影响：它们不挂进场景，仍拿原件。
 */
function AnimatedObject({ object, animations }: LoadedModel) {
  useEffect(() => () => disposeSkeletons(object), [object]);
  const { actions, names } = useAnimations(animations, object);
  const invalidate = useThree((state) => state.invalidate);
  /** 本次挂载真正在播的 action；续帧只看它们是否还在推进。 */
  const playing = useRef<THREE.AnimationAction[]>([]);

  useEffect(() => {
    const action = names.length > 0 ? actions[names[0]!] : undefined;
    playing.current = action ? [action] : [];
    action?.reset().play();
    /*
      起播必须自己索要一帧。下面那条续帧条件只在"片段真的在推进"时才成立，所以不能再
      依赖"反正每帧都会 invalidate"——不主动要这一帧，起播就可能永远等不到第一次绘制。
    */
    invalidate();
    return () => {
      playing.current = [];
      action?.stop();
    };
  }, [actions, names, invalidate]);

  /*
    预览窗和缩略图使用 frameloop="demand"，靠这里续帧把动画推下去。续帧条件必须是
    **片段真的在推进**，而不是"这个模型带了片段"——判据本身与理由见 animationLoop.ts。
    旧写法只看 `names.length > 0`，而 `AnimatedObject` 本来只在有片段时才渲染，
    等于无条件续帧：只要场景里有一个带动画的模型，整块画布就永远以 vsync 重绘，
    `frameloop="demand"` 形同虚设。三个画布（视口 / 预览小窗 / 缩略图）都会中招。
  */
  useFrame((state) => {
    if (needsAnimationFrame(playing.current)) state.invalidate();
  });

  return <primitive object={object} dispose={null} />;
}

function ClonedAssembly({
  models,
  highlight,
  highlightMask,
  material,
  wireframe,
}: {
  models: LoadedModel[];
  highlight: Highlight;
  highlightMask: number;
  /** 右侧栏的材质覆盖；语义默认值（保持原材质）时 hook 内部整段跳过 */
  material?: AssetMaterial;
  /** 线框着色模式；开时忽略贴图覆盖（见 useAssemblyMaterials） */
  wireframe: boolean;
}) {
  const clonedModels = useMemo(
    () =>
      models.map((model) => ({
        object: SkeletonUtils.clone(model.object),
        animations: model.animations,
      })),
    [models],
  );
  const [root, setRoot] = useState<THREE.Group | null>(null);
  /*
    材质写在**克隆体**上：这里才是真正挂进场景的那一份，原件留在 loader 缓存里给悬浮卡、
    预览小窗和缩略图读（见 materialOverride.ts 的纪律 ①）。invalidate 由这里提供，因为
    Canvas 跑的是 frameloop="demand"——换材质后不主动要一帧，画面会停在旧材质上。
    线框与贴图覆盖共用这一个写入点，理由见 useAssemblyMaterials 的说明。
  */
  const invalidate = useThree((state) => state.invalidate);
  useAssemblyMaterials(root, material, wireframe, invalidate);
  return (
    // 所有部件先保持供应商文件里的共同坐标系，再对整个集合只 Center 一次；逐部件
    // Center 会把每块都搬到原点，直接破坏分段模型的装配关系。
    <Center cacheKey={clonedModels}>
      <group ref={setRoot}>
        {clonedModels.map((model, index) =>
          model.animations.length > 0 ? (
            <AnimatedObject key={index} {...model} />
          ) : (
            <primitive key={index} object={model.object} dispose={null} />
          ),
        )}
        {root && highlight !== "none" && (
          <HighlightBox root={root} dim={highlight === "hover"} mask={highlightMask} />
        )}
      </group>
    </Center>
  );
}

function LoadedRegistration({
  index,
  model,
  onLoaded,
}: {
  index: number;
  model: LoadedModel;
  onLoaded: (index: number, model: LoadedModel) => void;
}) {
  useLayoutEffect(() => onLoaded(index, model), [index, model, onLoaded]);
  return null;
}

/** 当前资产真正应该一起渲染的模型路径；libraryApi 已排除普通任务的多格式副本。 */
export function renderableModelPaths(asset: LibraryAsset): string[] {
  if (asset.modelPaths.length > 0) return asset.modelPaths;
  return asset.modelPath ? [asset.modelPath] : [];
}

function ModelAssembly({
  asset,
  highlight,
  highlightMask,
  material,
  wireframe,
}: {
  asset: LibraryAsset;
  highlight: Highlight;
  highlightMask: number;
  material?: AssetMaterial;
  wireframe: boolean;
}) {
  const paths = renderableModelPaths(asset);
  const [loaded, setLoaded] = useState<Array<LoadedModel | null>>(() => paths.map(() => null));
  const [failed, setFailed] = useState<ReadonlySet<number>>(() => new Set());

  const registerLoaded = useCallback((index: number, model: LoadedModel) => {
    setLoaded((current) => mergeLoadedModel(current, index, model));
  }, []);
  const registerFailure = useCallback((index: number) => {
    setFailed((current) => {
      if (current.has(index)) return current;
      const next = new Set(current);
      next.add(index);
      return next;
    });
  }, []);

  // highlight/hover 会让 ModelAssembly 重渲染；数组身份必须稳定，否则每次指针移动都会
  // 让 ClonedAssembly 重新克隆整棵 Object3D/骨架树。
  const loadedModels = useMemo(
    () => loaded.filter((model): model is LoadedModel => model != null),
    [loaded],
  );
  const settled = loadedModels.length + failed.size === paths.length;

  return (
    <>
      {paths.map((path, index) => (
        <Suspense key={path} fallback={null}>
          <RecoverableModelLoader
            path={resourcePath(path, asset.resourceRevision)}
            mtlPath={modelExt(path) === "obj" && asset.mtlPath ? resourcePath(asset.mtlPath, asset.resourceRevision) : null}
            onPermanentError={() => registerFailure(index)}
          >
            {(model) => (
              <>
                <LoadedRegistration index={index} model={model} onLoaded={registerLoaded} />
                {/* 渲染层在这里发布"模型描述"，供 Inspector 消费（见 modelDescription.ts）。
                    放在真实渲染路径上，而不是让编辑层自己再挂一份模型。 */}
                <ModelDescriptionPublisher asset={asset} object={model.object} />
              </>
            )}
          </RecoverableModelLoader>
        </Suspense>
      ))}
      {settled && loadedModels.length > 0 && (
        <ClonedAssembly models={loadedModels} highlight={highlight} highlightMask={highlightMask} material={material} wireframe={wireframe} />
      )}
    </>
  );
}

export function ModelMesh({
  asset,
  highlight = "none",
  highlightMask = 1,
  material,
  wireframe = false,
}: {
  asset: LibraryAsset;
  /** 视口里的选中/悬浮态；预览小窗与缩略图渲染不传，保持无高亮 */
  highlight?: Highlight;
  highlightMask?: number;
  /** 右侧栏的材质覆盖（scene.json 的 materials 条目）；不传即渲染供应商原材质 */
  material?: AssetMaterial;
  /**
   * 线框着色模式，只由视口（Viewport）打开。预览小窗、缩略图、资产贴图抽取都不传，
   * 所以它们永远渲染实体材质——线框是**视口的观察方式**，不是资产的状态。
   */
  wireframe?: boolean;
}) {
  const assemblyKey = `${renderableModelPaths(asset).join("|")}|${asset.mtlPath ?? ""}|${asset.resourceRevision ?? 0}`;
  return <ModelAssembly key={assemblyKey} asset={asset} highlight={highlight} highlightMask={highlightMask} material={material} wireframe={wireframe} />;
}
