import { TransformControls } from "@react-three/drei/core/TransformControls";
import { useFrame } from "@react-three/fiber";
import { useCallback, useEffect, useMemo, useRef, useState, type RefObject } from "react";
import * as THREE from "three";
import type { AssetTransform } from "../../shared/lib/libraryApi";
import type { LiveTransforms } from "./liveTransforms";
import type { AssetPlacement } from "./scenePlacement";

export const TRANSFORM_MODES = ["translate", "rotate", "scale"] as const;
export type TransformMode = (typeof TRANSFORM_MODES)[number];
/** 变换参考系：world = 世界轴，local = 对象自身轴（Blender 的 Global/Local） */
export type TransformSpace = "world" | "local";


export interface GizmoMember {
  id: string;
  assetSlug: string;
  placement: AssetPlacement;
}

interface TransformGizmoProps {
  members: GizmoMember[];
  mode: TransformMode;
  space: TransformSpace;
  /**
   * 本窗格的占位 div。**必须显式传给 TransformControls 的 domElement**：它按
   * `domElement.getBoundingClientRect()` 把鼠标位置换算成 NDC，默认拿到的是整块
   * canvas，分屏时窗格只占 canvas 的一部分，拖拽方向与幅度会整体错位
   * （与 `PaneCamera` 里坐标轴球那次踩的是同一类坑）。
   */
  paneRef: RefObject<HTMLDivElement | null>;
  /** 跨窗格共享的实时摆放表：本组件只写，各窗格的模型自己每帧读（见 index.tsx 的 PlacedAsset） */
  live: LiveTransforms;
  /** 正在操作 gizmo：让点选逻辑这一轮别把选中改掉（见 index.tsx 的 pickSuppressedRef） */
  pickSuppressedRef: RefObject<boolean>;
  /** 松手时提交这一轮的绝对值；带上 mode 是为了让撤销栈能写出"旋转 xx"这类文案 */
  onCommit: (updates: Record<string, AssetTransform>, mode: TransformMode) => void;
}

// 组合/分解矩阵用的临时对象：每帧拖拽都要用，复用同一批实例而不是每次 new
const tmpPosition = new THREE.Vector3();
const tmpQuaternion = new THREE.Quaternion();
const tmpScale = new THREE.Vector3();
const tmpEuler = new THREE.Euler();
const tmpMatrix = new THREE.Matrix4();

function composeMatrix(placement: AssetPlacement, out: THREE.Matrix4): THREE.Matrix4 {
  return out.compose(
    tmpPosition.fromArray(placement.position),
    tmpQuaternion.setFromEuler(tmpEuler.fromArray(placement.rotation)),
    tmpScale.fromArray(placement.scale),
  );
}

function decomposePlacement(matrix: THREE.Matrix4): AssetPlacement {
  matrix.decompose(tmpPosition, tmpQuaternion, tmpScale);
  tmpEuler.setFromQuaternion(tmpQuaternion);
  return {
    position: [tmpPosition.x, tmpPosition.y, tmpPosition.z],
    rotation: [tmpEuler.x, tmpEuler.y, tmpEuler.z],
    scale: [tmpScale.x, tmpScale.y, tmpScale.z],
  };
}

/**
 * Blender 式变换 gizmo：选中资产后出现，可移动/旋转/缩放，松手即落盘（scene.json）。
 *
 * **一个窗格一份**（每份绑自己的相机与 pane div），但**它们共享同一张实时摆放表**：
 * 拖拽期间本组件只把算出来的新摆放写进 `live`，不碰 React state——每帧 setState 会把
 * 整棵场景树重渲染一遍，拖起来必卡；各窗格的模型自己每帧从这张表里取值应用到 group 上，
 * 于是分屏时四个窗格能同步跟随，而全程零渲染。松手（mouseUp）才提交一次，走
 * `useSceneTransforms` 的乐观更新 + 防抖落盘。
 *
 * **多选整体变换**靠一个不参与渲染的 pivot 空节点：TransformControls 只 attach 这个
 * pivot，按下时记录各成员相对 pivot 的矩阵（`pivot⁻¹ · member`），此后每次变化都用
 * `pivot.matrix · relative` 还原每个成员的世界摆放——旋转/缩放于是天然变成"绕选中集合
 * 中心整体转/缩"，不需要给成员之间建真实的父子层级（那会污染场景图，也会跟每资产一个
 * Suspense 边界的挂载结构打架）。单选时 pivot 直接取该资产自身的摆放，相对矩阵是单位阵，
 * gizmo 就落在物体原点上，与 Blender 一致。
 */
export function TransformGizmo({
  members,
  mode,
  space,
  paneRef,
  live,
  pickSuppressedRef,
  onCommit,
}: TransformGizmoProps) {
  const pivot = useMemo(() => new THREE.Object3D(), []);
  /** 按下瞬间冻结的"成员相对 pivot"矩阵，拖拽期间不再变 */
  const grabbedRef = useRef<{ id: string; assetSlug: string; relative: THREE.Matrix4 }[]>([]);
  const releaseTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 多窗格共享一枚 suppression ref；只有真正按下过的这份 gizmo 有权在 cleanup 里释放它。 */
  const ownsSuppressionRef = useRef(false);
  const membersRef = useRef(members);
  membersRef.current = members;

  const [paneEl, setPaneEl] = useState<HTMLElement | null>(null);
  useEffect(() => {
    if (paneRef.current) {
      setPaneEl(paneRef.current);
      return;
    }
    // 窗格占位层与 Canvas 内容分属两棵 reconciler 树，首次挂载时 pane div 可能
    // 还没落进 DOM——下一帧再取一次，取到才建 controls
    const frame = requestAnimationFrame(() => setPaneEl(paneRef.current));
    return () => cancelAnimationFrame(frame);
  }, [paneRef]);

  /** 成员集合或它们的摆放变化时才需要重置 pivot 基准；members 数组每次渲染都是新引用，不能直接当依赖 */
  const membersKey = useMemo(
    () =>
      members
        .map((m) => {
          const p = m.placement;
          return `${m.id}:${p.position.join()}|${p.rotation.join()}|${p.scale.join()}`;
        })
        .join(";"),
    [members],
  );

  /** 把 pivot 摆回成员当前摆放算出的基准姿态；`at` 允许改读实时值而不是 props 里的值 */
  const resetPivot = useCallback(
    (at: (member: GizmoMember) => AssetPlacement) => {
      const current = membersRef.current;
      if (current.length === 0) return;
      if (current.length === 1) {
        const placement = at(current[0]!);
        pivot.position.fromArray(placement.position);
        pivot.rotation.fromArray(placement.rotation);
        pivot.scale.fromArray(placement.scale);
      } else {
        // 多选取各成员位置的包围中心（Blender 默认的"中位点"轴心），姿态归零——
        // 一组朝向各异的对象没有共同的"自身轴"，整组变换从单位姿态起算最不意外
        const box = new THREE.Box3();
        for (const member of current) box.expandByPoint(tmpPosition.fromArray(at(member).position));
        pivot.position.copy(box.getCenter(tmpPosition));
        pivot.rotation.set(0, 0, 0);
        pivot.scale.set(1, 1, 1);
      }
      pivot.updateMatrix();
    },
    [pivot],
  );

  useEffect(() => {
    resetPivot((member) => member.placement);
  }, [membersKey, resetPivot]);

  useEffect(
    () => () => {
      if (releaseTimerRef.current) clearTimeout(releaseTimerRef.current);
      releaseTimerRef.current = null;
      // 切布局/离开视口等情况可能发生在一次拖拽尚未正常 mouseUp 时。
      // 不清理会让共享拾取闸门永久保持关闭，后续再也选不中模型。
      if (grabbedRef.current.length > 0) {
        grabbedRef.current = [];
        live.clear();
      }
      if (ownsSuppressionRef.current) {
        pickSuppressedRef.current = false;
        ownsSuppressionRef.current = false;
      }
    },
    [live, pickSuppressedRef],
  );

  /*
    别的窗格正在拖时，本窗格的 gizmo 也得跟着走：分屏下同一个选中集合有 N 份 gizmo，
    只有被抓住的那一份会被 TransformControls 推动，其余几份不同步就会僵在原地、
    等松手重渲染才瞬移过去。自己正抓着（grabbedRef 非空）时当然不能反过来跟。
  */
  useFrame(() => {
    if (grabbedRef.current.length > 0 || live.size === 0) return;
    resetPivot((member) => live.get(member.id) ?? member.placement);
  });

  if (members.length === 0 || !paneEl) return null;

  const handleMouseDown = () => {
    ownsSuppressionRef.current = true;
    pickSuppressedRef.current = true;
    pivot.updateMatrix();
    const inverse = new THREE.Matrix4().copy(pivot.matrix).invert();
    grabbedRef.current = membersRef.current.map((member) => ({
      id: member.id,
      assetSlug: member.assetSlug,
      relative: new THREE.Matrix4().multiplyMatrices(
        inverse,
        composeMatrix(member.placement, new THREE.Matrix4()),
      ),
    }));
  };

  const handleObjectChange = () => {
    pivot.updateMatrix();
    for (const grabbed of grabbedRef.current) {
      tmpMatrix.multiplyMatrices(pivot.matrix, grabbed.relative);
      live.set(grabbed.id, decomposePlacement(tmpMatrix));
    }
  };

  const handleMouseUp = () => {
    const updates: Record<string, AssetTransform> = {};
    for (const grabbed of grabbedRef.current) {
      const placement = live.get(grabbed.id);
      // 提交的键是资产的稳定 id（scene.json 的键），不是 slug
      if (placement) updates[grabbed.id] = placement;
    }
    grabbedRef.current = [];
    // 表清空后模型停在最后一帧的位置，接着 commit 触发的重渲染会把同样的值经 props 写回，
    // 两者一致所以看不到跳变；反过来若先等 props 再清表，中间那几帧会被旧值拽回去
    live.clear();
    if (Object.keys(updates).length > 0) onCommit(updates, mode);
    // click 紧跟在 pointerup 之后同步派发，这一帧不能松开抑制，
    // 否则松手会被判成"点了空白"而清空选中（gizmo 不在 R3F 的拾取集合里）
    if (releaseTimerRef.current) clearTimeout(releaseTimerRef.current);
    releaseTimerRef.current = setTimeout(() => {
      pickSuppressedRef.current = false;
      ownsSuppressionRef.current = false;
      releaseTimerRef.current = null;
    }, 0);
  };

  return (
    <>
      <primitive object={pivot} />
      <TransformControls
        object={pivot}
        mode={mode}
        space={space}
        domElement={paneEl}
        size={0.8}
        onMouseDown={handleMouseDown}
        onObjectChange={handleObjectChange}
        onMouseUp={handleMouseUp}
      />
    </>
  );
}
