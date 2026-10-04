import { useFrame, useThree } from "@react-three/fiber";
import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { ArrayCamera, Scene } from "three";
import { RenderSchedule } from "./RenderSchedule";
import { adoptCoordinateSystem, fitCameraToViewport, syncArrayCamera, type PaneView } from "./paneViewports";

interface ProjectRuntime {
  schedule: RenderSchedule;
  scene: Scene;
  panes: Map<string, PaneView>;
  arrayCamera: ArrayCamera;
}

const RuntimeContext = createContext<ProjectRuntime | null>(null);
export const ViewIdContext = createContext("first-person");

export function ProjectRenderRuntime({ children }: { children: ReactNode }) {
  const scene = useThree((state) => state.scene);
  const gl = useThree((state) => state.gl);
  const [runtime] = useState<ProjectRuntime>(() => ({
    schedule: new RenderSchedule(), scene, panes: new Map(), arrayCamera: new ArrayCamera(),
  }));

  /*
    核心场景是**一趟** ArrayCamera pass，先于所有窗格。

    为什么必须是一趟：核心场景是所有窗格共享的同一个 `Scene`，而 three 的 WebGPU 后端在一个
    render pass 内就能逐子相机切 viewport、逐子相机做 layer 过滤（见 paneViewports.ts）。原先
    "每个窗格各调一次 `gl.render(coreScene, camera)`"不只是多了 N−1 次 draw，而是多了 N−1 整套
    pass：`needsFrameBufferTarget` 在本应用恒为真（tone mapping = ACES、outputColorSpace ≠ working），
    所以每次 `gl.render()` 都是"写进中间 framebuffer + 再全屏 blit 回画布"两趟加两次提交。
    N 个窗格就是 2N 趟；一趟 ArrayCamera 把它压成 2 趟。

    相机的投影适配（透视改 aspect、正交改 left/right/top/bottom）也从窗格搬到了这里——因为它必须在
    **画之前**发生，而窗格 pass 现在排在核心 pass 之后。
  */
  useLayoutEffect(() => runtime.schedule.registerCore(() => {
    const panes = [...runtime.panes.values()];
    // 第一人称：没有窗格，`FirstPersonView` 自己渲染核心场景。
    if (panes.length === 0) return;
    const autoClear = gl.autoClear;
    gl.autoClear = false;
    // 每趟 `gl.render()` 都是一个新 render pass，其默认 scissor 就是整张附件；这里关掉即可。
    gl.setScissorTest(false);
    try {
      if (panes.length === 1) {
        const only = panes[0]!;
        const resolved = only.resolve();
        if (!resolved || resolved.width <= 0 || resolved.height <= 0) return;
        adoptCoordinateSystem(resolved.camera, gl.coordinateSystem);
        fitCameraToViewport(resolved.camera, resolved.width, resolved.height);
        resolved.camera.layers.mask = 1 | (1 << only.layer);
        gl.setViewport(resolved.left, resolved.top, resolved.width, resolved.height);
        gl.render(scene, resolved.camera);
        return;
      }
      for (const pane of panes) {
        const resolved = pane.resolve();
        if (!resolved) continue;
        adoptCoordinateSystem(resolved.camera, gl.coordinateSystem);
        fitCameraToViewport(resolved.camera, resolved.width, resolved.height);
      }
      if (syncArrayCamera(runtime.arrayCamera, panes) === 0) return;
      gl.render(scene, runtime.arrayCamera);
    } finally {
      gl.autoClear = autoClear;
    }
  }), [gl, runtime, scene]);

  useFrame((_, delta) => {
    // Models and animation mixers have already advanced once at priority 0.
    scene.updateMatrixWorld();
    const autoUpdate = scene.matrixWorldAutoUpdate;
    scene.matrixWorldAutoUpdate = false;
    try { runtime.schedule.draw(delta); } finally { scene.matrixWorldAutoUpdate = autoUpdate; }
  }, 1);
  return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>;
}

export function useProjectScene() {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error("A project render runtime is required.");
  return runtime.scene;
}

/**
 * 把一个窗格登记进某一趟共享 pass。`resolve` 每帧被调用一次，返回本帧的相机与视口（左上原点、
 * CSS px），或 null 表示这帧不画。登记只做一次（按 `id`），改的是 ref，不触发 React 渲染。
 */
function usePaneRegistration(target: (runtime: ProjectRuntime) => Map<string, PaneView>, id: string, layer: number, resolve: PaneView["resolve"]): void {
  const runtime = useContext(RuntimeContext);
  const callback = useRef(resolve);
  callback.current = resolve;
  const layerRef = useRef(layer);
  layerRef.current = layer;
  const invalidate = useThree((state) => state.invalidate);
  useLayoutEffect(() => {
    if (!runtime) throw new Error("A project render runtime is required.");
    const panes = target(runtime);
    const entry: PaneView = { get layer() { return layerRef.current; }, resolve: () => callback.current() };
    panes.set(id, entry);
    invalidate();
    return () => {
      if (panes.get(id) === entry) panes.delete(id);
      invalidate();
    };
  }, [runtime, id, invalidate, target]);
}

/** 登记进核心场景那一趟（`ProjectRenderRuntime` 的 core pass）。 */
export function usePaneView(id: string, layer: number, resolve: PaneView["resolve"]): void {
  usePaneRegistration((runtime) => runtime.panes, id, layer, resolve);
}

export function useViewPass(phase: "scene", draw: (delta: number) => boolean): void;
export function useViewPass(phase: "hud", draw: (delta: number) => void): void;
export function useViewPass(phase: "scene" | "hud", draw: (delta: number) => boolean | void) {
  const runtime = useContext(RuntimeContext);
  const id = useContext(ViewIdContext);
  const invalidate = useThree((state) => state.invalidate);
  const callback = useRef(draw);
  callback.current = draw;
  useLayoutEffect(() => {
    if (!runtime) throw new Error("A project render runtime is required.");
    const unregister = phase === "scene"
      ? runtime.schedule.register(id, phase, (delta) => callback.current(delta) === true)
      : runtime.schedule.register(id, phase, (delta) => { callback.current(delta); });
    invalidate();
    return () => { unregister(); invalidate(); };
  }, [runtime, id, phase, invalidate]);
}

/*
  第一人称那一趟的**诊断读数**：只在 `?fpDebug=1` 下写 `window.__FP_DEBUG__`。
  存在的理由与 `physicsDebug.ts` 一样——"第一人称黑屏"这类问题，单测与位置读数都证明不了，
  必须把那一趟渲染的**引擎事实**（相机、viewport、场景内容计数）记下来才分得清
  "没画" / "画到别处去了" / "画了但相机看不见东西"。
*/
function recordFirstPersonDebug(
  camera: {
    type: string;
    near: number;
    far: number;
    layers: { mask: number };
    position: { toArray(): number[] };
    quaternion: { toArray(): number[] };
    fov?: number;
    aspect?: number;
    isOrthographicCamera?: boolean;
    projectionMatrix?: { elements: number[] };
  },
  scene: { children: unknown[]; background: unknown; traverse(cb: (o: { isMesh?: boolean; isPoints?: boolean; visible?: boolean }) => void): void },
): void {
  if (typeof window === "undefined") return;
  if (!window.location.search.includes("fpDebug=1")) return;
  let meshes = 0;
  let visibleMeshes = 0;
  const sample: Array<Record<string, unknown>> = [];
  scene.traverse((object) => {
    const typed = object as unknown as {
      isMesh?: boolean;
      isPoints?: boolean;
      visible?: boolean;
      name?: string;
      type?: string;
      layers?: { mask: number };
      material?: { side?: number; transparent?: boolean; depthWrite?: boolean; type?: string; toneMapped?: boolean };
      scale?: { x: number; y: number; z: number };
    };
    if (typed.isMesh || typed.isPoints) {
      meshes += 1;
      if (typed.visible !== false) visibleMeshes += 1;
      // 只留前几个 + 名字里带 sky/env 的，报告别撑爆
      if (sample.length < 6 || /sky|env/i.test(typed.name ?? "")) {
        sample.push({
          name: typed.name ?? null,
          type: typed.type ?? null,
          layers: typed.layers?.mask ?? null,
          side: typed.material?.side ?? null,
          transparent: typed.material?.transparent ?? null,
          depthWrite: typed.material?.depthWrite ?? null,
          material: typed.material?.type ?? null,
          scale: typed.scale ? [typed.scale.x, typed.scale.y, typed.scale.z] : null,
        });
      }
    }
  });
  /*
    天空球（`editor:sky`）单独读一份：**第一人称黑屏的头号嫌疑**。
    它在 `onBeforeRender` 里把自己挪到"正在渲染的那台相机"上（见 index.tsx 的 SkyBackdrop），
    所以"它的位置 == 相机位置"就说明那一帧它确实**进了渲染队列并回调过**；
    位置还停在别处 = 它根本没被这一趟画到。
  */
  let sky: Record<string, unknown> | null = null;
  scene.traverse((object) => {
    const typed = object as unknown as {
      name?: string;
      visible?: boolean;
      layers?: { mask: number };
      position?: { toArray(): number[] };
      material?: { map?: unknown; side?: number; depthWrite?: boolean };
      geometry?: { parameters?: { radius?: number } };
    };
    if (typed.name !== "editor:sky") return;
    sky = {
      visible: typed.visible !== false,
      layers: typed.layers?.mask ?? null,
      position: typed.position?.toArray() ?? null,
      hasMap: Boolean(typed.material?.map),
      side: typed.material?.side ?? null,
      depthWrite: typed.material?.depthWrite ?? null,
      radius: typed.geometry?.parameters?.radius ?? null,
      // 与相机的距离：≈0 说明它跟着这台相机；很大说明它没被这一趟更新
      distanceToCamera: (() => {
        if (!typed.position) return null;
        const skyPosition = typed.position.toArray();
        const cameraPosition = camera.position.toArray();
        return Math.hypot(
          (skyPosition[0] ?? 0) - (cameraPosition[0] ?? 0),
          (skyPosition[1] ?? 0) - (cameraPosition[1] ?? 0),
          (skyPosition[2] ?? 0) - (cameraPosition[2] ?? 0),
        );
      })(),
    };
  });

  (window as unknown as Record<string, unknown>).__FP_DEBUG__ = {
    sky,
    camera: {
      type: camera.type,
      fov: camera.fov ?? null,
      aspect: camera.aspect ?? null,
      orthographic: camera.isOrthographicCamera === true,
      near: camera.near,
      far: camera.far,
      layers: camera.layers.mask,
      position: camera.position.toArray(),
      quaternion: camera.quaternion.toArray(),
      // 投影矩阵第 5 个（[1][1]）与第 11 个（[2][3]）足以看出近远平面/约定是否正常
      projection: [camera.projectionMatrix?.elements?.[5] ?? null, camera.projectionMatrix?.elements?.[11] ?? null],
    },
    scene: { children: scene.children.length, meshes, visibleMeshes, hasBackground: Boolean(scene.background), sample },
  };
}

export function FirstPersonView() {
  const get = useThree((state) => state.get);
  const scene = useProjectScene();
  useViewPass("scene", () => {
    const state = get();
    const { gl, camera } = state;
    /*
      ⚠️ 这里用的是 **R3F 的默认相机**，它和窗格相机不是一回事：窗格相机每次都会走
      `adoptCoordinateSystem` + `fitCameraToViewport`（把 aspect / 正交边界按窗格尺寸重建），
      而默认相机**没人给过它投影适配**。它的 `aspect` 停在 0（画布还没测量时建的那一台），
      于是 `PerspectiveCamera.updateProjectionMatrix()` 里 `width = height * aspect = 0`
      ⇒ `p[0] = 2·near/width = Infinity` ⇒ **一个像素都不画**：纯黑、零报错、pass 照常发出
      （真机读数：`aspect: 0`，而同一项目轨道模式正常，因为轨道用的是窗格相机）。

      所以第一人称这一趟**必须自己补投影适配**，与窗格那一趟同源（`paneViewports.ts`）。
      尺寸取 R3F 的 `size`（它就是画布的 CSS 尺寸），退回 `gl.getSize()`。
    */
    adoptCoordinateSystem(camera, gl.coordinateSystem);
    /*
      尺寸优先取 R3F 的 `size`，读不到（0）时退回渲染器的绘制缓冲尺寸。
      为什么需要兜底：aspect 为 0 的**根因是一次竞态**——R3F 只在测量到尺寸的那一刻把
      `size → camera.aspect` 写一次，若那一次量到的是 0（门禁重载、布局切换的瞬间），
      aspect 就永久停在 0，而没有任何东西会再修它。所以这里每帧都量、量到就用
      （`fitCameraToViewport` 内部只在值变化时重建矩阵，静止时零成本）。
      aspect 与 DPR 无关，所以绘制缓冲尺寸当兜底是等价的。
    */
    const width = state.size?.width ?? 0;
    const height = state.size?.height ?? 0;
    if (width > 0 && height > 0) {
      fitCameraToViewport(camera, width, height);
    } else {
      const buffer = gl.getSize?.({ width: 0, height: 0 } as never) as { width?: number; height?: number } | undefined;
      if (buffer && (buffer.width ?? 0) > 0 && (buffer.height ?? 0) > 0) {
        fitCameraToViewport(camera, buffer.width!, buffer.height!);
      }
    }
    camera.layers.mask = 1 | (1 << 1);
    gl.render(scene, camera);
    recordFirstPersonDebug(camera, scene);
    return true;
  });
  return null;
}
