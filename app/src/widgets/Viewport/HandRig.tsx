import { useFrame, useThree } from "@react-three/fiber";
import { useRapier } from "@react-three/rapier";
import { useEffect, useMemo, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import type { AssetTransform } from "../../shared/lib/libraryApi";
import {
  HAND_ANCHORS,
  HAND_DEPTH,
  HAND_EDITOR_VIEW,
  handDepthForSight,
  isUsableHand,
  MIDDLE_MCP,
  THUMB_IP,
  orthographicExtents,
  perspectiveExtents,
  projectHand,
  type PhysicalHand,
  type Vec3,
  type ViewExtents,
} from "./handLandmarks";
import { GRAB_MAX_DISTANCE } from "./physics";
import {
  DRAG_MAX_DISTANCE,
  directionBetween,
  dragMoved,
  draggedPlacement,
  grabOffsetFor,
  pickWithRay,
  pointAlongRay,
} from "./handGrab";
import { isHandDebugForced, setHandProbe } from "./handDebug";
import { createLibraryHands, EDITOR_HAND_ROTATION } from "./libraryHandModel";
import type { HandPointer, HandTrackingStore, TrackedHand } from "./handTrackingStore";
import type { LiveTransforms } from "./liveTransforms";
import type { AssetPlacement } from "./scenePlacement";
import type { TransformMode } from "./transformMode";

/**
 * 场景里的那双手：**相机挂载的骨架网格 + 两种交互通路**。
 *
 * ### 网格怎么来的
 * 作者配套 hands.glb 由完整 three-mediapipe-rig HandsTracker 驱动。
 *
 * ### 手放在哪
 * 挂点沿图像占位确定的深度放在交互相机前，外层绕 Y 旋转 π，骨骼朝向由库决定。
 * "手在画面里挪动"由
 * `projectHand` 的 `palmOffset` 承担（按当前相机的可见范围换算，见 `handLandmarks.ts`）。
 *
 * ### 交互：这里只做"没走物理"的那一条
 * - 物理没跑（第三人称；或 `?physics=0` 的第一人称）→ 捏合驱动**直接写摆放**：每帧写 `live`
 *   （右侧栏数字跟着手走），松手清表 + 提交一次（与 gizmo 完全同一套）。这条路不需要物理，
 *   所以第三人称里"抓起来搬"照样成立。
 * - 物理在跑（第一人称）→ **不在这里**：那一份由 `FirstPersonGrab` 的 `useObjectGrab` 负责，
 *   射线经 `aim` 换成"相机 → 捏合点"。**抓取只能有一份实现**（两个 hook 会各抓一次，
 *   而诊断口只登记其中一个，见 index.tsx 的说明）。
 *
 * **同时只有一只手能抓着东西**（`pointer.slot` 记主人）：另一只手松开不该把它掉在地上。
 */

const SLOTS: readonly PhysicalHand[] = ["left", "right"];

/**
 * 作者演示使用的配套模型，保持原始双手骨架、骨骼轴和蒙皮权重。
 * 三角形按左右手拆分以放到各自的屏幕位置；不再套用旧写实手模的绑定校准。
 */
const HAND_MODEL_URL = "/models/three-mediapipe-rig/hands.glb";

/** 解析作者配套 GLB；失败原因由诊断口报告。 */
function useHandModel(url: string): { model: THREE.Object3D | null; error: string | null } {
  const [state, setState] = useState<{ model: THREE.Object3D | null; error: string | null }>({ model: null, error: null });
  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await fetch(url);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = await response.arrayBuffer();
        const gltf = await new Promise<{ scene: THREE.Object3D }>((resolve, reject) => {
          new GLTFLoader().parse(buffer, "", (result) => resolve(result as unknown as { scene: THREE.Object3D }), reject);
        });
        if (cancelled) return;
        setState({ model: gltf.scene, error: null });
      } catch (error) {
        if (cancelled) return;
        setState({ model: null, error: error instanceof Error ? error.message : String(error) });
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [url]);
  return state;
}

/** 诊断读数取 4 位小数：够判位置，又不会因为浮点尾数把报告撑爆 */
const round = (value: number) => Math.round(value * 1e4) / 1e4;

/** 捏合点的指示球：没捏住时小而暗，捏住时变大变亮——不然用户不知道"抓到了没有" */
const MARKER_IDLE_COLOR = 0xffd166;
const MARKER_PINCH_COLOR = 0x74f08a;
const MARKER_IDLE_RADIUS = 0.0085;
const MARKER_PINCH_RADIUS = 0.016;

/** 拖动中的一次抓取（第三人称/无物理通路） */
interface PlacementDrag {
  /** 发起这次抓取的手 */
  slot: PhysicalHand;
  assetId: string;
  /** 抓取那一瞬的命中距离：搬运途中保持这个深度（沿射线走） */
  depth: number;
  /** 命中点 → 物体原点的偏移（冻结），于是捏在边角上时物体不会跳 */
  offset: Vec3;
  /** 抓取前的摆放（姿态/缩放以它为准，提交判据拿它当基准） */
  base: AssetPlacement;
  /** 抓取前的世界位置（判"真的挪过没有"） */
  startPosition: Vec3;
}

export interface HandRigProps {
  store: HandTrackingStore;
  /** 当前交互窗格的相机；第一人称使用根画布相机。每帧读取以支持投影切换。 */
  cameraSource?: () => THREE.Camera | null;
  /** 手势模式开着没有。关掉时整双手隐藏、不发布射线、并把进行中的抓取收尾 */
  enabled: boolean;
  /** 直接写摆放这条通路的抓手：已挂载资产表 + 摆放表 + 实时摆放表（都由视口注入） */
  placement?: {
    objects: Map<string, THREE.Object3D>;
    layout: Map<string, AssetPlacement>;
    live: LiveTransforms;
  } | null;
  /** 抓到资产（**等价于在第三人称点中它**，与第一人称准星抓取同一口径） */
  onGrabAsset?: (assetId: string) => void;
  /** 松手时提交一次摆放 */
  onPlacementCommit?: (updates: Record<string, AssetTransform>, mode: TransformMode) => void;
  /** 拾取射线的最大距离（米），默认与拖动一致 */
  maxGrabDistance?: number;
}

/** 相机 → 手所在平面的可见范围（米）。正交相机也给得出，但手势模式默认只在透视下用 */
export function extentsForCamera(camera: THREE.Camera, distance: number): ViewExtents {
  const perspective = camera as THREE.PerspectiveCamera;
  if (perspective.isPerspectiveCamera) {
    return perspectiveExtents(perspective.getEffectiveFOV(), perspective.aspect, distance);
  }
  const orthographic = camera as THREE.OrthographicCamera;
  if (orthographic.isOrthographicCamera) {
    const height = orthographic.top - orthographic.bottom;
    const aspect = height !== 0 ? (orthographic.right - orthographic.left) / height : 1;
    return orthographicExtents(orthographic.top / orthographic.zoom, orthographic.bottom / orthographic.zoom, aspect);
  }
  return { width: 1, height: 1 };
}

export function HandRig({
  store,
  cameraSource,
  enabled,
  placement,
  onGrabAsset,
  onPlacementCommit,
  maxGrabDistance = DRAG_MAX_DISTANCE,
}: HandRigProps) {
  const rootCamera = useThree((state) => state.camera);
  const { rapier, world } = useRapier();

  /* ---------------------------------------------------------------- 作者配套手模与完整库绑定 */

  const { model: handModel, error: handModelError } = useHandModel(HAND_MODEL_URL);
  const assembly = useMemo(() => {
    if (!handModel) return { instances: null, error: null };
    try {
      return { instances: createLibraryHands(handModel), error: null };
    } catch (error) {
      return { instances: null, error: error instanceof Error ? error.message : String(error) };
    }
  }, [handModel]);
  // 加载或库绑定失败时隐藏手模，诊断口保留失败原因。
  const modelErrorRef = useRef<string | null>(null);
  modelErrorRef.current = handModelError ?? assembly.error;
  const instances = assembly.instances;
  const instancesRef = useRef(instances);
  instancesRef.current = instances;
  useEffect(() => () => { instances?.forEach((instance) => instance.dispose()); }, [instances]);
  /*
    模型这份几何/贴图是**共享**的（副本只复制场景图节点），所以只需要释放一次源。
  */
  useEffect(() => () => {
    handModel?.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.geometry?.dispose();
      for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
        for (const value of Object.values(material as unknown as Record<string, unknown>)) {
          if (value && typeof value === "object" && "isTexture" in (value as object)) (value as THREE.Texture).dispose();
        }
        material.dispose();
      }
    });
  }, [handModel]);

  /* ---------------------------------------------------------------- 几何与材质 */

  const sphereGeometry = useMemo(() => new THREE.SphereGeometry(1, 16, 12), []);
  const markerIdleMaterial = useMemo(
    () => new THREE.MeshBasicMaterial({ color: MARKER_IDLE_COLOR, toneMapped: false }),
    [],
  );
  const markerPinchMaterial = useMemo(
    () => new THREE.MeshBasicMaterial({ color: MARKER_PINCH_COLOR, toneMapped: false }),
    [],
  );

  useEffect(
    () => () => {
      sphereGeometry.dispose();
      markerIdleMaterial.dispose();
      markerPinchMaterial.dispose();
    },
    [sphereGeometry, markerIdleMaterial, markerPinchMaterial],
  );

  /* ---------------------------------------------------------------- 节点引用 */

  /**
   * 捏合点的指示球：**挂在场景根上、每帧写世界坐标**，而不是挂在手的分组里。
   * 直接读取库手模的指尖世界位置，不依赖旧程序化骨架。
   */
  const markerMeshes = useRef<Record<PhysicalHand, THREE.Mesh | null>>({ left: null, right: null });

  const scratch = useMemo(
    () => ({
      camPos: new THREE.Vector3(),
      camQuat: new THREE.Quaternion(),
      offset: new THREE.Vector3(),
      tip: new THREE.Vector3(),
      thumb: new THREE.Vector3(),
      index: new THREE.Vector3(),
      world: new THREE.Vector3(),
    }),
    [],
  );

  /* ---------------------------------------------------------------- 交互状态 */

  const dragRef = useRef<PlacementDrag | null>(null);
  const placementRef = useRef(placement);
  placementRef.current = placement;
  const onGrabRef = useRef(onGrabAsset);
  onGrabRef.current = onGrabAsset;
  const onPlacementCommitRef = useRef(onPlacementCommit);
  onPlacementCommitRef.current = onPlacementCommit;

  /** 隐藏库手模与捏合小球。 */
  const hideAllHands = () => {
    for (const instance of instancesRef.current ?? []) instance.holder.visible = false;
    for (const slot of SLOTS) {
      const marker = markerMeshes.current[slot];
      if (marker) marker.visible = false;
    }
  };

  /** 结束抓取：清实时表 + 真挪过才提交 */
  const finishDrag = (commit: boolean) => {
    const held = dragRef.current;
    dragRef.current = null;
    if (!held) return;
    const live = placementRef.current?.live;
    if (!live) return;
    const finalPlacement = live.get(held.assetId);
    live.clear();
    if (!commit || !finalPlacement) return;
    if (!dragMoved(held.startPosition, finalPlacement.position)) return;
    onPlacementCommitRef.current?.({ [held.assetId]: finalPlacement }, "translate");
  };

  /*
    手势模式关掉（或组件卸载）时**必须收尾**：把最后一帧的摆放提交掉，否则
    "抓到一半关掉模式"会让物体停在半路，而右侧栏与 scene.json 还记着旧位置。
    （物理那条通路的收尾在 `useObjectGrab` 自己身上：`enabled` 变 false / 卸载时 release + flush。）
  */
  useEffect(() => {
    if (enabled) return;
    // 关掉的那一帧必须被画出来：`frameloop="demand"` 下没有这一下，画面会停在"手还在"的旧帧
    hideAllHands();
    invalidate();
    finishDrag(true);
    // `finishDrag`/`hideAllHands` 只读 ref（摆放表、挂点都是这上面的），所以别跟着它们重跑
  }, [enabled]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => { finishDrag(true); }, []);

  /**
   * 每帧的交互判定（射线已经在 `update` 里算好并发布到 store）。
   * `placement` 为 null（物理在跑的第一人称）时整段早退：那一份由 `FirstPersonGrab` 负责。
   */
  const applyInteraction = (pointer: HandPointer | null) => {
    const pinching = pointer?.pinching === true;
    const target = placementRef.current;
    if (!target) return;
    const held = dragRef.current;

    if (!held) {
      if (!pinching || !pointer || !pointer.slot) return;
      const hit = pickWithRay(
        { origin: pointer.origin, direction: pointer.direction },
        target.objects,
        maxGrabDistance,
      );
      // 没抓到（点在空白处）时**什么都不做**：那一下的本意是"抓"，不等于"清空选中"
      if (!hit) return;
      const root = target.objects.get(hit.assetId);
      if (!root) return;
      const worldPosition = root.getWorldPosition(scratch.world);
      const base = target.layout.get(hit.assetId) ?? target.live.get(hit.assetId);
      if (!base) return;
      const start: Vec3 = [worldPosition.x, worldPosition.y, worldPosition.z];
      dragRef.current = {
        slot: pointer.slot,
        assetId: hit.assetId,
        depth: hit.distance,
        offset: grabOffsetFor(start, hit.point),
        base,
        startPosition: start,
      };
      onGrabRef.current?.(hit.assetId);
      return;
    }

    if (pinching && pointer && pointer.slot === held.slot) {
      const point = pointAlongRay(pointer.origin, pointer.direction, held.depth);
      const next = draggedPlacement(held.base, [
        point[0] + held.offset[0],
        point[1] + held.offset[1],
        point[2] + held.offset[2],
      ]);
      // 只写实时表（不 setState）：右侧栏订阅同一张表，数字跟着手走而场景树不重渲染
      target.live.set(held.assetId, next);
      return;
    }

    finishDrag(true);
  };

  /* ---------------------------------------------------------------- 渲染循环与诊断 */

  /*
    画布是 `frameloop="demand"`：检测循环在自己的 rAF 里跑，新的一帧结果必须**显式要一帧**
    才会被画出来（否则只有鼠标动一下画面才刷新）。寄存器只能在 Canvas 内部拿（`invalidate`），
    而检测循环在外面，所以经 store 中转。
  */
  const invalidate = useThree((state) => state.invalidate);
  useEffect(() => {
    store.setFrameRequester(() => invalidate());
    return () => store.setFrameRequester(null);
  }, [store, invalidate]);

  /*
    诊断口读的是**引擎事实**（场景里那些节点的真实世界变换与可见性），不是我们自己的记账：
    "手画出来了没有"只能靠这个回答（见 handDebug.ts 的纪律 ②）。
  */
  useEffect(() => {
    setHandProbe(() => {
      const camera = cameraSource?.() ?? rootCamera;
      const read = (slot: PhysicalHand) => {
        const instance = instancesRef.current?.find((candidate) => candidate.slot === slot);
        if (!instance) return null;
        const { holder, refs } = instance;
        holder.updateWorldMatrix(true, true);
        const world = (node: THREE.Object3D) => node.getWorldPosition(new THREE.Vector3());
        const screenX = (node: THREE.Object3D) => world(node).project(camera).x;
        const tracked = store.getFrame().hands.find((candidate) => candidate.physical === slot);
        const thumb = tracked?.landmarks[THUMB_IP];
        const middle = tracked?.landmarks[MIDDLE_MCP];
        const boneSample = instance.bones.slice(0, 3).map((node) => {
          const point = world(node);
          return [round(point.x), round(point.y), round(point.z)];
        });
        return {
          source: "glb" as const,
          driver: "three-mediapipe-rig/HandsTracker.bind" as const,
          model: HAND_MODEL_URL,
          physicalHand: slot,
          reportedHandedness: tracked?.reportedHandedness ?? null,
          handednessConfidence: tracked?.confidence ?? null,
          identitySource: tracked?.identitySource ?? null,
          displayedHand: instance.displayedHand,
          editorRotationDegrees: 180,
          visible: holder.visible,
          landmarkThumbSide: thumb && middle ? Math.sign(middle.x - thumb.x) : null,
          modelThumbSide: Math.sign(screenX(refs.thumbIp) - screenX(refs.middleMcp)),
          position: [round(holder.position.x), round(holder.position.y), round(holder.position.z)],
          quaternion: [round(holder.quaternion.x), round(holder.quaternion.y), round(holder.quaternion.z), round(holder.quaternion.w)],
          jointCount: instance.bones.length,
          boneCount: instance.bones.length,
          jointSample: boneSample,
          wristQuaternion: refs.wrist.quaternion.toArray(),
          thumbQuaternions: instance.bones.filter((node) => node.name.startsWith("thumb")).map((node) => ({ name: node.name, quaternion: node.quaternion.toArray() })),
        };
      };
      /*
        已挂载资产的**世界位置**（直接读场景图里那些节点，不是我们自己的记账）：
        "捏合到底有没有把模型搬走"只有这里能回答——第三人称的搬运写的是渲染节点，
        rapier 的刚体在暂停状态下不会跟着动（见 HandRig 文件头）。
      */
      const assets: Record<string, number[]> = {};
      const objects = placementRef.current?.objects;
      if (objects) {
        let count = 0;
        for (const [id, object] of objects) {
          if (count >= 16) break;
          object.getWorldPosition(scratch.world);
          assets[id] = [round(scratch.world.x), round(scratch.world.y), round(scratch.world.z)];
          count += 1;
        }
      }
      const held = dragRef.current;
      /*
        相机事实（位置/朝向/视场）也一并交出去：驱动要"把手瞄准某个模型"就得先把模型的世界
        位置投影到画面——那件事必须用**这台相机的真实参数**，不能照抄常量（fov 与 aspect
        随窗格尺寸变，投影错了就会得到"手明明对着模型却抓不到"的假失败）。
      */
      const perspective = camera as THREE.PerspectiveCamera;
      /*
        手势射线到底打中了什么——与 `useObjectGrab.tryGrab` **同一套判据**（同样的距离上限、
        同样的"只认 dynamic 且不是角色"谓词）。抓不起来时第一个要回答的问题就是"是射线没打中，
        还是打中了但关节没建起来"，这个读数把它们分开（与 `physicsDebug.raycast()` 同一个理由）。
      */
      const handPointer = store.getPointer();
      let handRaycast: Record<string, unknown> | null = null;
      if (handPointer) {
        const hit = world.castRay(
          new rapier.Ray(
            { x: handPointer.origin[0], y: handPointer.origin[1], z: handPointer.origin[2] },
            { x: handPointer.direction[0], y: handPointer.direction[1], z: handPointer.direction[2] },
          ),
          GRAB_MAX_DISTANCE,
          true,
          undefined,
          undefined,
          undefined,
          undefined,
          (collider) => {
            const body = collider.parent();
            return Boolean(
              body
              && body.isDynamic()
              && (body.userData as { character?: boolean } | null)?.character !== true,
            );
          },
        );
        const body = hit?.collider.parent() ?? null;
        handRaycast = {
          hit: Boolean(hit),
          toi: hit ? round(hit.timeOfImpact) : null,
          bodyName: body ? ((body.userData as { assetId?: string } | null)?.assetId ?? null) : null,
          dynamic: body ? body.isDynamic() : null,
        };
      }
      // 可见性、缩放和位置直接读取库手模挂点。
      const modelInstances = (instancesRef.current ?? []).map((instance) => ({
        slot: instance.slot,
        bones: instance.bones.length,
        visible: instance.holder.visible,
        scale: [round(instance.holder.scale.x), round(instance.holder.scale.y), round(instance.holder.scale.z)],
        position: [round(instance.holder.position.x), round(instance.holder.position.y), round(instance.holder.position.z)],
        // 前两根骨的世界位置：够判"手在不在、姿态有没有在动"
        boneSample: instance.bones.slice(0, 2).map((bone) => {
          const world = bone.getWorldPosition(new THREE.Vector3());
          return [round(world.x), round(world.y), round(world.z)];
        }),
      }));
      return {
        renderTicks: renderTicks.current,
        model: { error: modelErrorRef.current, instances: modelInstances },
        handRaycast,
        forced: isHandDebugForced(),
        frameId: store.getFrame().frameId,
        pointer: store.getPointer(),
        camera: {
          position: [round(camera.position.x), round(camera.position.y), round(camera.position.z)],
          quaternion: [round(camera.quaternion.x), round(camera.quaternion.y), round(camera.quaternion.z), round(camera.quaternion.w)],
          fov: perspective.isPerspectiveCamera ? perspective.fov : null,
          aspect: perspective.isPerspectiveCamera ? round(perspective.aspect) : null,
          orthographic: !perspective.isPerspectiveCamera,
        },
        drag: held ? { assetId: held.assetId, slot: held.slot, depth: round(held.depth) } : null,
        assets,
        left: read("left"),
        right: read("right"),
      };
    });
    return () => setHandProbe(null);
  }, [store, scratch, rootCamera, cameraSource, rapier, world]);

  /* ---------------------------------------------------------------- 每帧更新 */

  /** 渲染帧计数：诊断口用它回答"渲染循环有没有在跑"（与 `published` 对照） */
  const renderTicks = useRef(0);
  /** 已经"接手"过的检测帧号：同一个帧号只续一次帧，检测停下就不再要帧 */
  const drawnFrameId = useRef(-1);

  // 相机/轨道飞行在 priority 0 更新，核心场景在 1 渲染；手在两者之间同步。
  useFrame((_state, delta) => {
    renderTicks.current += 1;
    const frame = store.getFrame();
    // 诊断注入（`?handDebug=1`）时手也要画出来：那是沙箱里唯一能验网格与交互的通路
    const active = enabled || isHandDebugForced();
    const hands: readonly TrackedHand[] = active ? frame.hands : [];
    /*
      **"有新的一帧检测结果"就自己再要一帧——这是这套功能能看见手的唯一原因。**

      真机实测（Chrome + `--use-file-for-fake-video-capture` 把一段真手视频喂成摄像头）：
      `enabled` 为真、`frame.hands` 里有两只手、分组的 `visible` 也是 true，
      但画面**停在"还没有手"的那一帧不动**；手动要 4 帧（`__HAND__.pump(4)`）手立刻出现。
      也就是说：检测循环每帧都调过 `invalidate()`，而那次 invalidate **不一定**能变成一次重画。
      `frameloop="demand"` 的续帧完全靠 `internal.frames` 这个计数（见 R3F 的 loop/invalidate），
      检测回调与 R3F 的渲染回调在同一个 rAF 批次里抢它，谁先谁后由注册顺序决定——
      live 模式不该靠"抢赢一次 invalidate"活着。

      所以改成**由渲染帧自己接手**：看到一个新的 `frameId` 就再要一帧（`invalidate()` 在
      `useFrame` 里被 R3F 记成"还要一帧"）。检测停下 → 帧号不再变 → 不再要帧 → 循环自然停，
      不会变成常驻空转（这正是本仓库对 `frameloop="demand"` 的纪律，见 animationLoop.ts）。
    */
    const freshFrame = frame.frameId !== drawnFrameId.current;
    if (active && freshFrame) {
      drawnFrameId.current = frame.frameId;
      invalidate();
    }
    if (!active) {
      instancesRef.current?.forEach((instance) => { instance.tracked = false; });
      // 关闭时同时隐藏库手模和捏合标记。
      hideAllHands();
      return;
    }
    // 手模在核心场景，轨道相机在窗格 portal；不能用根 store 的静止默认相机。
    const camera = cameraSource?.() ?? rootCamera;
    const extents = extentsForCamera(camera, HAND_DEPTH);
    const cameraPosition = camera.getWorldPosition(scratch.camPos);
    const cameraQuaternion = camera.getWorldQuaternion(scratch.camQuat);

    // 本轮里可用的手与显示手模的捏合点世界坐标。
    const candidates: { slot: PhysicalHand; hand: TrackedHand; tipWorld: Vec3 }[] = [];

    for (const slot of SLOTS) {
      const instance = instancesRef.current?.find((candidate) => candidate.slot === slot);
      if (!instance) continue;
      const hand = hands.find((candidate) => candidate.physical === slot);
      if (!hand || !hand.worldLandmarks || !isUsableHand(hand.worldLandmarks)) {
        instance.tracked = false;
        instance.holder.visible = false;
        const marker = markerMeshes.current[slot];
        if (marker) marker.visible = false;
        continue;
      }
      const projection = projectHand(hand.landmarks, {
        ...HAND_EDITOR_VIEW,
        extents,
        anchor: HAND_ANCHORS[slot],
      });

      /*
        手的分组原点 = **手掌中心**：位置取"锚点在相机空间的位置 + 手的画面位移"。

        **深度不是常数**：`projectHand` 是在基准深度上算的（画面 1 单位 = 多少米），
        而这只手真正该待在多近，由"它在画面里占多高"反推（`handDepthForSight`）——
        于是"手凑近摄像头"表现为**手离你更近**，而不是**手变得像巨人**
        （早先按画面大小等比放大，用户凑近时虚拟手涨到几十厘米、指头被拉得又细又长）。
        横向/纵向位移按深度等比缩放，所以画面上的位置仍然与视频里一致。
      */
      const joints = projection.joints;
      const wrist = joints[0]!;
      const middle = joints[MIDDLE_MCP]!;
      const forward = scratch.offset.set(middle[0] - wrist[0], middle[1] - wrist[1], middle[2] - wrist[2]).normalize();
      let imageExtent = 0;
      for (const point of joints) imageExtent = Math.max(imageExtent,
        (point[0] - wrist[0]) * forward.x + (point[1] - wrist[1]) * forward.y + (point[2] - wrist[2]) * forward.z);
      const perspective = camera as THREE.PerspectiveCamera;
      const spanFraction = perspective.isPerspectiveCamera
        ? imageExtent / extents.height
        : 1;
      const depth = perspective.isPerspectiveCamera
        ? handDepthForSight(spanFraction, perspective.getEffectiveFOV())
        : HAND_DEPTH;
      const depthRatio = depth / HAND_DEPTH;
      const anchorX = (HAND_ANCHORS[slot][0] - 0.5) * extents.width;
      const anchorY = (0.5 - HAND_ANCHORS[slot][1]) * extents.height;
      scratch.offset
        .set(
          (anchorX + projection.palmOffset[0]) * depthRatio,
          (anchorY + projection.palmOffset[1]) * depthRatio,
          -depth,
        )
        .applyQuaternion(cameraQuaternion);
      instance.holder.position.copy(cameraPosition).add(scratch.offset);
      instance.holder.quaternion.copy(cameraQuaternion).multiply(EDITOR_HAND_ROTATION);
      instance.holder.scale.setScalar(instance.scale);
      instance.holder.visible = true;
      // Complete upstream palm/finger binding and Ghost.lerp; no previous
      // palmQ, bone-axis calibration, hinge solver or second pose smoothing.
      instance.update(hand.worldLandmarks, delta);

      /*
        捏合点 = 拇指尖与食指尖的中点：它既是"指示球"的位置，也是这支手射线的**瞄准点**。
        用中点而不是食指尖：捏住时两指并在一起，中点比任意一个指尖都稳（指尖的 z 抖得最厉害）。
      */
      const marker = markerMeshes.current[slot];
      const { pinchTips } = instance;
      pinchTips.thumb.bone.localToWorld(scratch.thumb.copy(pinchTips.thumb.point));
      pinchTips.index.bone.localToWorld(scratch.index.copy(pinchTips.index.point));
      scratch.tip.copy(scratch.thumb).add(scratch.index).multiplyScalar(0.5);
      if (marker) {
        marker.position.copy(scratch.tip);
        marker.scale.setScalar(hand.pinching ? MARKER_PINCH_RADIUS : MARKER_IDLE_RADIUS);
        marker.material = hand.pinching ? markerPinchMaterial : markerIdleMaterial;
        marker.visible = true;
      }
      candidates.push({ slot, hand, tipWorld: [scratch.tip.x, scratch.tip.y, scratch.tip.z] });
    }

    /*
      选"主手"：**正在捏合的那只优先**，其次列表里第一只。
      场景里同时只能抓着一样东西，而两只手都会捏；优先捏合手保证"左手抓着、右手也捏一下"
      不会把手里的东西换到另一只手上。
    */
    const primary = candidates.find((candidate) => candidate.hand.pinching) ?? candidates[0] ?? null;
    let pointer: HandPointer | null = null;
    if (primary) {
      scratch.tip.set(primary.tipWorld[0], primary.tipWorld[1], primary.tipWorld[2]);
      const direction = directionBetween(
        [cameraPosition.x, cameraPosition.y, cameraPosition.z],
        [scratch.tip.x, scratch.tip.y, scratch.tip.z],
      );
      if (direction) {
        pointer = {
          origin: [cameraPosition.x, cameraPosition.y, cameraPosition.z],
          direction,
          tip: [scratch.tip.x, scratch.tip.y, scratch.tip.z],
          active: true,
          pinching: primary.hand.pinching,
          slot: primary.slot,
        };
      }
    }
    // 发布给物理步（第一人称的抓取在物理步里读它，与渲染帧不是一个节奏）
    store.setPointer(pointer);
    applyInteraction(pointer);
  }, 0.5);

  return (
    <>
      {/* 作者配套手模，由完整库绑定更新骨骼。 */}
      {instances?.map((instance) => <primitive key={`glb-${instance.slot}`} object={instance.holder} />)}
      {/* 捏合点指示球：场景级、世界坐标，与"用哪套网格"无关 */}
      {SLOTS.map((slot) => (
        <mesh
          key={`marker-${slot}`}
          ref={(node) => { markerMeshes.current[slot] = node; }}
          geometry={sphereGeometry}
          material={markerIdleMaterial}
          visible={false}
          frustumCulled={false}
        />
      ))}
    </>
  );
}
