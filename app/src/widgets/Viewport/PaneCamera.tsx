import { OrbitControls } from "@react-three/drei/core/OrbitControls";
import { OrthographicCamera } from "@react-three/drei/core/OrthographicCamera";
import { PerspectiveCamera } from "@react-three/drei/core/PerspectiveCamera";
import { createPortal, useFrame, useThree, type ThreeEvent } from "@react-three/fiber";
import { useViewPass } from "./ProjectRenderRuntime";
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ComponentRef,
  type MutableRefObject,
  type RefObject,
} from "react";
import * as THREE from "three";
import { CameraRig, type CameraTarget } from "./CameraRig";
import type { PaneControls } from "./paneControls";
import type { CameraKind, Projection } from "./paneLayouts";

type TrackedRectRef = MutableRefObject<DOMRect | null>;

const trackedRectSubscribers = new Map<HTMLElement, Set<TrackedRectRef>>();
let trackedRectObserver: ResizeObserver | null = null;
let trackedRectWindowListenersAttached = false;

function syncTrackedElement(element: HTMLElement) {
  const subscribers = trackedRectSubscribers.get(element);
  if (!subscribers) return;
  const rect = element.getBoundingClientRect();
  for (const subscriber of subscribers) subscriber.current = rect;
}

function syncAllTrackedRects() {
  for (const element of trackedRectSubscribers.keys()) syncTrackedElement(element);
}

function ensureTrackedRectInfrastructure() {
  if (!trackedRectObserver) {
    trackedRectObserver = new ResizeObserver((entries) => {
      for (const entry of entries) syncTrackedElement(entry.target as HTMLElement);
    });
  }
  if (trackedRectWindowListenersAttached) return;
  window.addEventListener("resize", syncAllTrackedRects);
  window.addEventListener("scroll", syncAllTrackedRects, {
    capture: true,
    passive: true,
  });
  trackedRectWindowListenersAttached = true;
}

function subscribeTrackedRect(element: HTMLElement, rectRef: TrackedRectRef) {
  ensureTrackedRectInfrastructure();
  let subscribers = trackedRectSubscribers.get(element);
  if (!subscribers) {
    subscribers = new Set();
    trackedRectSubscribers.set(element, subscribers);
    trackedRectObserver!.observe(element);
  }
  subscribers.add(rectRef);
  syncTrackedElement(element);

  return () => {
    const current = trackedRectSubscribers.get(element);
    current?.delete(rectRef);
    if (current?.size === 0) {
      trackedRectObserver?.unobserve(element);
      trackedRectSubscribers.delete(element);
    }
    if (trackedRectSubscribers.size > 0) return;
    trackedRectObserver?.disconnect();
    trackedRectObserver = null;
    window.removeEventListener("resize", syncAllTrackedRects);
    window.removeEventListener("scroll", syncAllTrackedRects, true);
    trackedRectWindowListenersAttached = false;
  };
}

/**
 * 窗格 / 画布的像素矩形缓存。所有实例共用一个 ResizeObserver 和一组 window 监听。
 *
 * `getBoundingClientRect` 会强制浏览器同步刷新布局，放进 `useFrame` 里就是每帧一次：
 * 四窗格布局下 4 个 `PaneGizmo`（各读窗格 + 画布两次）加 3 个 `OrthoZoomSync`，
 * 每帧 11 次、60fps 下每秒 660 次强制 reflow——而这些矩形只在窗口 resize 与切换分屏
 * 布局时才会变。共享订阅把同一个画布的重复测量合并，每帧只读内存。
 *
 * 只观察尺寸不观察位置是够的：本应用里能让窗格挪位的只有窗口 resize（有监听）、
 * 页面滚动（有监听）和切分屏布局，而 1/2/4 三种布局之间任意切换都必然改变每个
 * 存活窗格的尺寸（半屏 → 四分之一屏等），ResizeObserver 一定会跟着回调。
 */
export function useTrackedRect(target: RefObject<HTMLElement | null> | HTMLElement | null) {
  const rectRef = useRef<DOMRect | null>(null);

  useEffect(() => {
    /*
      窗格传的是稳定的 ref 对象，画布传的是 gl.domElement 本身（useThree 给的同一个实例）。

      这里不为"ref 还没附着"做重试兜底，因为那个分支进不去：`<Canvas>` 与窗格 div
      在同一棵外层 React 树、同一次 commit 里，ref 在 commit 阶段就已就位；而本组件
      属于 R3F 内部 reconciler 的子树，是在外层 commit 完成之后才挂载的。切换分屏
      布局同理——新窗格 div 的 commit 同样先于新 `View` 子树挂载。
    */
    const element = target instanceof HTMLElement ? target : target?.current;
    if (!element) return;

    return subscribeTrackedRect(element, rectRef);
  }, [target]);

  return rectRef;
}

const AXIS_COLORS = { x: "#e56b6b", y: "#6bcb77", z: "#4d8fe5" } as const;
/** 每根轴的旋转（把 Axis 组件默认沿 +X 的朝向转到 +Y / +Z），复用于色块和球 */
const AXIS_ROTATIONS: Record<"x" | "y" | "z", [number, number, number]> = {
  x: [0, 0, 0],
  y: [0, 0, Math.PI / 2],
  z: [0, -Math.PI / 2, 0],
};

/** 一根轴上的色块：sign=1 画正方向（原点到 +1），sign=-1 画负方向，两根拼成一条经过原点的完整线 */
function AxisBar({
  axis,
  sign,
  opacity,
}: {
  axis: "x" | "y" | "z";
  sign: 1 | -1;
  opacity: number;
}) {
  return (
    <group rotation={AXIS_ROTATIONS[axis]}>
      <mesh position={[0.4 * sign, 0, 0]}>
        <boxGeometry args={[0.8, 0.05, 0.05]} />
        <meshBasicMaterial color={AXIS_COLORS[axis]} toneMapped={false} transparent opacity={opacity} />
      </mesh>
    </group>
  );
}

const axisHeadTextureCache = new Map<string, THREE.CanvasTexture>();

/** 轴球贴图：圆形色块 + 可选轴名字母，按颜色+文字缓存，避免每次渲染都重新画 canvas */
function getAxisHeadTexture(color: string, label?: string) {
  const key = `${color}:${label ?? ""}`;
  const cached = axisHeadTextureCache.get(key);
  if (cached) return cached;

  const canvas = document.createElement("canvas");
  canvas.width = 64;
  canvas.height = 64;
  const ctx = canvas.getContext("2d")!;
  ctx.beginPath();
  ctx.arc(32, 32, 16, 0, 2 * Math.PI);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
  if (label) {
    ctx.font = "18px Inter var, Arial, sans-serif";
    ctx.textAlign = "center";
    ctx.fillStyle = "white";
    ctx.fillText(label, 32, 41);
  }
  const texture = new THREE.CanvasTexture(canvas);
  // CanvasTexture 默认 colorSpace 是 NoColorSpace（按线性值采样），而 R3F 渲染器
  // 默认 outputColorSpace = SRGBColorSpace（输出时整体做一次 sRGB 编码）；这里画的
  // 是 AXIS_COLORS 十六进制色值，本身已经是 sRGB 编码，不声明的话就是编码两次，
  // 球体颜色会比色值本身发白发淡
  texture.colorSpace = THREE.SRGBColorSpace;
  axisHeadTextureCache.set(key, texture);
  return texture;
}

/** 轴球本体：sprite + 命中回调；正方向带字母标签且不透明，负方向不带标签、半透明，视觉上匹配原 drei GizmoViewport 的区分方式 */
function AxisHead({
  axis,
  sign,
  onSnap,
}: {
  axis: "x" | "y" | "z";
  sign: 1 | -1;
  onSnap: (direction: THREE.Vector3) => void;
}) {
  const [hovered, setHovered] = useState(false);
  const label = sign === 1 ? axis.toUpperCase() : undefined;
  const texture = useMemo(() => getAxisHeadTexture(AXIS_COLORS[axis], label), [axis, label]);
  const position = useMemo<[number, number, number]>(() => {
    const p: [number, number, number] = [0, 0, 0];
    p["xyz".indexOf(axis)] = sign;
    return p;
  }, [axis, sign]);
  const baseScale = (label ? 1 : 0.75) * (hovered ? 1.2 : 1);

  return (
    <sprite
      position={position}
      scale={baseScale}
      onPointerOver={(e) => {
        e.stopPropagation();
        setHovered(true);
      }}
      onPointerOut={(e) => {
        e.stopPropagation();
        setHovered(false);
      }}
      onPointerDown={(e) => {
        e.stopPropagation();
        onSnap(new THREE.Vector3(...position));
      }}
    >
      <spriteMaterial map={texture} alphaTest={0.3} opacity={label ? 1 : 0.75} toneMapped={false} />
    </sprite>
  );
}

/** 拖拽热区半径（gizmo 本地坐标系，配合外层 scale=40 一起用）：盖住整簇轴球 */
const GIZMO_DRAG_RADIUS = 1.4;
/** trackball 旋转速度，手感参考 three.js 自带 TrackballControls 的默认值 */
const TRACKBALL_ROTATE_SPEED = 3.5;

/**
 * 坐标轴球区域的自由旋转手柄：拖拽空白视口走 OrbitControls 的 turntable
 * （锁定世界 Y 轴向上，不能滚转）；Blender 里拖拽右上角坐标轴走的是
 * trackball / 环形球自由旋转（没有锁定的上方向，可以整体翻滚），手感本应
 * 和拖拽空白处不同，所以单独实现一套，而不是复用 OrbitControls。
 * 命中区是一个盖住整簇轴球、完全透明的圆盘，按下时接管旋转并临时关闭
 * OrbitControls；正中某个轴球时该球自身的 onPointerDown 会先 stopPropagation，
 * 命中优先级更高，点击吸附行为不受影响。
 */
function GizmoTrackballHandle({
  controlsRef,
  paneRef,
}: {
  controlsRef: RefObject<ComponentRef<typeof OrbitControls> | null>;
  paneRef: RefObject<HTMLDivElement | null>;
}) {
  const dragging = useRef(false);
  const prev = useRef(new THREE.Vector2());
  const curr = useRef(new THREE.Vector2());
  const paneRect = useRef({ left: 0, top: 0, width: 1, height: 1 });
  // pointermove 期间高频触发，预分配好这些标量对象复用，避免每次移动都新建
  // Vector3/Quaternion 造成 GC 压力（拖拽卡顿的常见来源）
  const scratch = useRef({
    eye: new THREE.Vector3(),
    eyeDir: new THREE.Vector3(),
    upDir: new THREE.Vector3(),
    sideDir: new THREE.Vector3(),
    axis: new THREE.Vector3(),
    quat: new THREE.Quaternion(),
  });

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      if (!dragging.current) return;
      const controls = controlsRef.current;
      if (!controls) return;
      const camera = controls.object as THREE.Camera;

      const rect = paneRect.current;
      curr.current.set(
        (e.clientX - rect.left) / rect.width,
        (e.clientY - rect.top) / rect.height,
      );
      const moveX = curr.current.x - prev.current.x;
      const moveY = curr.current.y - prev.current.y;
      const angle = Math.sqrt(moveX * moveX + moveY * moveY) * TRACKBALL_ROTATE_SPEED;

      if (angle > 0) {
        const s = scratch.current;
        s.eye.copy(camera.position).sub(controls.target);
        s.eyeDir.copy(s.eye).normalize();
        s.upDir.copy(camera.up).normalize();
        s.sideDir.crossVectors(s.upDir, s.eyeDir).normalize();

        s.upDir.multiplyScalar(-moveY);
        s.sideDir.multiplyScalar(moveX);
        const moveDir = s.upDir.add(s.sideDir);

        s.axis.crossVectors(moveDir, s.eye).normalize();
        // moveDir 和 eye 接近共线时叉乘会退化成零向量，跳过这一帧避免产生 NaN
        if (s.axis.lengthSq() > 0) {
          s.quat.setFromAxisAngle(s.axis, angle);
          s.eye.applyQuaternion(s.quat);
          camera.up.applyQuaternion(s.quat);
          camera.position.copy(controls.target).add(s.eye);
          camera.lookAt(controls.target);
        }
      }

      prev.current.copy(curr.current);
    };

    const onUp = () => {
      if (!dragging.current) return;
      dragging.current = false;
      if (controlsRef.current) controlsRef.current.enabled = true;
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
    window.addEventListener("blur", onUp);
    return () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      window.removeEventListener("blur", onUp);
      if (dragging.current && controlsRef.current) controlsRef.current.enabled = true;
      dragging.current = false;
    };
  }, [controlsRef]);

  const onPointerDown = (e: ThreeEvent<PointerEvent>) => {
    e.stopPropagation();
    const controls = controlsRef.current;
    const rect = paneRef.current?.getBoundingClientRect();
    if (!controls || !rect || rect.width <= 0 || rect.height <= 0) return;
    controls.enabled = false;
    paneRect.current = {
      left: rect.left,
      top: rect.top,
      width: rect.width,
      height: rect.height,
    };
    dragging.current = true;
    prev.current.set(
      (e.nativeEvent.clientX - rect.left) / rect.width,
      (e.nativeEvent.clientY - rect.top) / rect.height,
    );
  };

  return (
    <mesh position={[0, 0, -0.02]} onPointerDown={onPointerDown}>
      <circleGeometry args={[GIZMO_DRAG_RADIUS, 32]} />
      <meshBasicMaterial transparent opacity={0} depthTest={false} depthWrite={false} />
    </mesh>
  );
}

interface OrthoRig {
  position: [number, number, number];
  up: [number, number, number];
}

/** top 用极小的 x/z 偏移避免正上方向下看时 OrbitControls 内部叉积退化 */
const ORTHO_RIGS: Record<Exclude<CameraKind, "perspective">, OrthoRig> = {
  top: { position: [0, 8, 0.0001], up: [0, 0, -1] },
  front: { position: [0, 0, 8], up: [0, 1, 0] },
  right: { position: [8, 0, 0], up: [0, 1, 0] },
};

/** 正交窗格竖直方向恒定可见世界范围（单位：世界坐标） */
const ORTHO_VIEW_WORLD_HEIGHT = 15;

/**
 * drei View 每帧都会把正交相机的视锥体按窗格的像素尺寸强制重设
 * （left/right/top/bottom = ±像素宽高/2），所以固定的 zoom 只在某个固定像素尺寸
 * 的窗格下才准——切到多窗格布局后每个窗格变小，同样的 zoom 会让能看到的世界范围
 * 跟着缩成一小块。这里每帧按窗格的实时像素高度反推 zoom，保证不管开几分屏，
 * 正交窗格看到的世界坐标范围都一致。
 */
function OrthoZoomSync({ paneRef }: { paneRef: RefObject<HTMLDivElement | null> }) {
  const paneRectRef = useTrackedRect(paneRef);

  useFrame((state) => {
    const cam = state.camera;
    if (!(cam instanceof THREE.OrthographicCamera)) return;
    const rect = paneRectRef.current;
    if (!rect || rect.height <= 0) return;
    const desiredZoom = rect.height / ORTHO_VIEW_WORLD_HEIGHT;
    if (Math.abs(cam.zoom - desiredZoom) > 0.01) {
      cam.zoom = desiredZoom;
      cam.updateProjectionMatrix();
    }
  });
  return null;
}

/** gizmo 距窗格右上角的像素边距，以及整簇轴球的显示比例（局部单位 × GIZMO_SCALE = 像素） */
const GIZMO_MARGIN_PX = 64;
const GIZMO_SCALE = 40;
/** Shared axis geometry; does not depend on WebGL-only renderer capabilities. */
export function CameraAxes({ onSnap }: { onSnap: (direction: THREE.Vector3) => void }) {
  return <>{(["x", "y", "z"] as const).map((axis) => (
    <group key={axis}>
      <AxisBar axis={axis} sign={1} opacity={1} />
      <AxisBar axis={axis} sign={-1} opacity={0.75} />
      <AxisHead axis={axis} sign={1} onSnap={onSnap} />
      <AxisHead axis={axis} sign={-1} onSnap={onSnap} />
    </group>
  ))}</>;
}
/** 视角吸附动画的角速度（弧度/秒），沿用 drei GizmoHelper 默认手感 */
const SNAP_TURN_RATE = 2 * Math.PI;

/**
 * 右上角坐标轴球：多窗格同时开着时不能用 drei 的 GizmoHelper——它自己的 Hud
 * 渲染是另一个独立的 useFrame，只要有不止一个窗格，所有窗格的"设置 viewport"
 * 和"画坐标轴"就会分成两批依次执行（先所有窗格各自设置一遍 viewport，再所有
 * 窗格各自画一遍坐标轴），而不是"这个窗格设置完 viewport 立刻画这个窗格的
 * 坐标轴"——最终 4 个坐标轴全部画在了最后一个窗格残留的 viewport 里，只有
 * 那一个看得见。这里自己实现一份等价的 Hud：在同一个 useFrame 回调里原子地
 * 完成"设置这个窗格自己的 viewport → 画这个窗格自己的坐标轴"，规避掉按
 * priority 分批执行导致的交叉覆盖。
 */
function PaneGizmo({
  controlsRef,
  paneRef,
}: {
  controlsRef: RefObject<ComponentRef<typeof OrbitControls> | null>;
  paneRef: RefObject<HTMLDivElement | null>;
}) {
  const gl = useThree((state) => state.gl);
  const invalidate = useThree((state) => state.invalidate);
  const mainCamera = useThree((state) => state.camera);
  const paneRectRef = useTrackedRect(paneRef);
  const canvasRectRef = useTrackedRect(gl.domElement);
  const [hudScene] = useState(() => new THREE.Scene());
  const hudCameraRef = useRef<THREE.OrthographicCamera>(null!);
  const groupRef = useRef<THREE.Group>(null!);
  const snapAnim = useRef<{
    from: THREE.Quaternion;
    to: THREE.Quaternion;
    radius: number;
    target: THREE.Vector3;
  } | null>(null);
  // 每帧都要用到的旋转矩阵，复用同一个实例而不是每帧 new 一个
  const rotationMatrix = useRef(new THREE.Matrix4());
  // 点击吸附只在按下瞬间算一次，不是热路径，但复用同一个 dummy 依然是免费的整洁
  const snapDummy = useRef(new THREE.Object3D());
  const snapTargetPosition = useRef(new THREE.Vector3());

  const snapTo = (direction: THREE.Vector3) => {
    const controls = controlsRef.current;
    if (!controls) return;
    const camera = controls.object as THREE.Camera;
    const target = controls.target.clone();
    const radius = camera.position.distanceTo(target) || 8;
    // 严格对照 drei GizmoHelper 原版写法：dummy 留在局部原点不挪动，
    // 只用 lookAt 朝向"新相机位置"来求目标四元数——之前我把 dummy 挪到
    // 新相机位置、再 lookAt(target)，看似更直觉但求出来的旋转正好差了
    // 180°（尤其 Y 轴这种视线和默认 up 向量平行的退化情形，方向感更明显
    // 出错），点顶部球反而吸附到底部朝上看。
    const dummy = snapDummy.current;
    dummy.up.copy(camera.up);
    const targetPosition = snapTargetPosition.current.copy(direction).multiplyScalar(radius).add(target);
    dummy.lookAt(targetPosition);
    snapAnim.current = {
      from: camera.quaternion.clone(),
      to: dummy.quaternion.clone(),
      radius,
      target,
    };
    invalidate();
  };

  useViewPass("hud", (delta) => {
    const paneRect = paneRectRef.current;
    const canvasRect = canvasRectRef.current;
    if (!paneRect || !canvasRect || paneRect.width <= 0 || paneRect.height <= 0) return;
    const w = paneRect.width;
    const h = paneRect.height;
    const left = paneRect.left - canvasRect.left;
    const top = paneRect.top - canvasRect.top;

    // 视角吸附动画：拖动的是这个窗格自己的相机，不涉及 gl 状态，放在同一帧里顺手推进
    const anim = snapAnim.current;
    const controls = controlsRef.current;
    if (anim && controls) {
      const camera = controls.object as THREE.Camera;
      if (anim.from.angleTo(anim.to) < 0.01) {
        snapAnim.current = null;
      } else {
        anim.from.rotateTowards(anim.to, delta * SNAP_TURN_RATE);
        camera.position
          .set(0, 0, 1)
          .applyQuaternion(anim.from)
          .multiplyScalar(anim.radius)
          .add(anim.target);
        camera.up.set(0, 1, 0).applyQuaternion(anim.from);
        camera.lookAt(anim.target);
      }
      controls.update();
      if (snapAnim.current) invalidate();
    }

    if (hudCameraRef.current) {
      const cam = hudCameraRef.current;
      cam.left = -w / 2;
      cam.right = w / 2;
      cam.top = h / 2;
      cam.bottom = -h / 2;
      cam.updateProjectionMatrix();
    }
    if (groupRef.current) {
      groupRef.current.position.set(w / 2 - GIZMO_MARGIN_PX, h / 2 - GIZMO_MARGIN_PX, 0);
      rotationMatrix.current.copy(mainCamera.matrix).invert();
      groupRef.current.quaternion.setFromRotationMatrix(rotationMatrix.current);
    }

    gl.setViewport(left, top, w, h);
    gl.setScissor(left, top, w, h);
    gl.setScissorTest(true);
    /*
      深度**不能**用 `gl.clearDepth()` 单独清（那是一次独立 encoder + 空 pass + 独立 submit）。
      three 在本后端上把 `autoClear*` 折进 render pass 的 `loadOp`，所以把 `autoClearDepth` 打开、
      `autoClearColor` 关掉，深度就在这一趟 pass 的起点被清掉：语义等价，但少一趟提交。
      **颜色必须显式关掉**，否则会把刚画好的整个窗格擦掉。
    */
    const previous = {
      autoClear: gl.autoClear,
      color: gl.autoClearColor,
      depth: gl.autoClearDepth,
      stencil: gl.autoClearStencil,
    };
    gl.autoClear = true;
    gl.autoClearColor = false;
    gl.autoClearDepth = true;
    gl.autoClearStencil = false;
    try {
      gl.render(hudScene, hudCameraRef.current);
    } finally {
      gl.autoClear = previous.autoClear;
      gl.autoClearColor = previous.color;
      gl.autoClearDepth = previous.depth;
      gl.autoClearStencil = previous.stencil;
      gl.setScissorTest(false);
    }
  });

  const compute = (event: { clientX: number; clientY: number }, state: { pointer: THREE.Vector2; raycaster: THREE.Raycaster; camera: THREE.Camera | null }) => {
    // 指针移动期间每个事件都会走一次，同样吃缓存；缓存还没建立时才退回实时测量
    const rect = paneRectRef.current ?? paneRef.current?.getBoundingClientRect();
    if (!rect) {
      state.raycaster.camera = null as unknown as THREE.Camera;
      return;
    }
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    const inside = x >= 0 && x <= rect.width && y >= 0 && y <= rect.height;
    if (!inside || !hudCameraRef.current) {
      state.raycaster.camera = null as unknown as THREE.Camera;
      return;
    }
    state.pointer.set((x / rect.width) * 2 - 1, -(y / rect.height) * 2 + 1);
    state.raycaster.setFromCamera(state.pointer, hudCameraRef.current);
  };

  return createPortal(
    <>
      <orthographicCamera ref={hudCameraRef} position={[0, 0, 200]} near={0.1} far={400} />
      <group ref={groupRef} scale={GIZMO_SCALE}>
        <CameraAxes onSnap={snapTo} />
        <GizmoTrackballHandle controlsRef={controlsRef} paneRef={paneRef} />
      </group>
    </>,
    hudScene,
    { events: { compute, priority: 3 } },
  );
}

interface PaneCameraProps {
  kind: CameraKind;
  /** 当前实际投影方式：与 kind 解耦，可在同一窗格内自由切换透视/正交 */
  projection: Projection;
  orbitCamera: { position: [number, number, number]; fov: number };
  focusKey: string;
  cameraTargetRef: RefObject<CameraTarget>;
  paneRef: RefObject<HTMLDivElement | null>;
  /**
   * 把本窗格的控制器交给外部（贴近检查要读出发机位、写飞行姿态，见 `CloseupInspectionRig`）。
   * 只有透视窗格用得到它；不传就什么也不做。
   */
  controlsOutRef?: MutableRefObject<PaneControls | null>;
}

/**
 * 按窗格机位类型渲染对应相机 + controls；透视窗格额外带聚焦飞行；所有窗格都带轴向 gizmo。
 * kind 只决定"从未使用过这个窗格时"的默认机位，projection 才是当前实际渲染用透视还是
 * 正交——两者解耦后，切换 projection 会整个替换 Camera + OrbitControls 元素（drei 相机
 * 组件不支持动态改 isPerspectiveCamera），为了不让镜头瞬间跳回默认机位，用 liveState 在
 * 每一帧把当前相机的 position/target/up 记下来，作为切换后新相机的初始值。
 */
export function PaneCamera({ kind, projection, orbitCamera, focusKey, cameraTargetRef, paneRef, controlsOutRef }: PaneCameraProps) {
  const controlsRef = useRef<ComponentRef<typeof OrbitControls>>(null);

  /*
    交给外部的控制器从**引擎自己的登记表**取：drei 的 OrbitControls 带 `makeDefault` 时会把
    实例写进所在 store 的 `state.controls`（一个窗格一个 store——`WebGPUView` 的 portal）。
    不能只读一次 `controlsRef.current`：drei 的实例由 `useMemo([explCamera])` 持有，
    窗格相机在 `makeDefault` 落地/切换投影时会换一次对象，于是实例被重建、ref 换人，
    而"只读一次"的那个 effect 不会再跑——外部就会一直拿着绑在旧相机上的控制器。
    订阅 `state.controls` 则由引擎替我们盯住这次换代。
  */
  const paneControls = useThree((state) => state.controls);
  useEffect(() => {
    if (!controlsOutRef) return;
    controlsOutRef.current = (paneControls as unknown as PaneControls | null) ?? null;
    return () => { controlsOutRef.current = null; };
  }, [controlsOutRef, paneControls]);

  const liveStateRef = useRef<{ position: THREE.Vector3; target: THREE.Vector3; up: THREE.Vector3 } | null>(null);
  if (!liveStateRef.current) {
    const rig = kind === "perspective" ? { position: orbitCamera.position, up: [0, 1, 0] as [number, number, number] } : ORTHO_RIGS[kind];
    liveStateRef.current = {
      position: new THREE.Vector3(...rig.position),
      target: new THREE.Vector3(0, 0, 0),
      up: new THREE.Vector3(...rig.up),
    };
  }
  const liveState = liveStateRef.current;

  useFrame(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    liveState.position.copy(controls.object.position);
    liveState.target.copy(controls.target);
    liveState.up.copy(controls.object.up);
  });

  const isPerspective = projection === "perspective";
  // 冻结在切换那一刻的值，只作为新相机的初始 prop；不随每次渲染重新读取 liveState，
  // 否则 drei 相机组件会把它当"受控 position"每次渲染都强制回写，和 OrbitControls 打架
  const initialPosition = useMemo(
    () => liveState.position.toArray() as [number, number, number],
    [projection, liveState],
  );
  const initialUp = useMemo(() => liveState.up.toArray() as [number, number, number], [projection, liveState]);

  useEffect(() => {
    const controls = controlsRef.current;
    if (!controls) return;
    controls.target.copy(liveState.target);
    controls.update();
  }, [projection, liveState]);

  return (
    <>
      {isPerspective ? (
        <PerspectiveCamera makeDefault position={initialPosition} up={initialUp} fov={orbitCamera.fov} />
      ) : (
        <OrthographicCamera makeDefault position={initialPosition} up={initialUp} />
      )}
      {!isPerspective && <OrthoZoomSync paneRef={paneRef} />}
      {/*
        Blender 里"顶/前/右视图"只是初始机位预设，不是锁死的投影角度——
        拖拽背景照样能自由转，转开之后就变成"用户自定义正交视角"，不再是
        严格轴对齐的顶/前/右，但仍然是正交投影。之前 enableRotate={false}
        理解错了，把预设角度当成了不能变的硬限制。
      */}
      <OrbitControls ref={controlsRef} makeDefault enableDamping />
      {isPerspective && <CameraRig focusKey={focusKey} targetRef={cameraTargetRef} controlsRef={controlsRef} />}
      <PaneGizmo controlsRef={controlsRef} paneRef={paneRef} />
    </>
  );
}
