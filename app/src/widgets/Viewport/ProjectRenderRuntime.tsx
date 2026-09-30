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

export function FirstPersonView() {
  const get = useThree((state) => state.get);
  const scene = useProjectScene();
  useViewPass("scene", () => {
    const { gl, camera } = get();
    camera.layers.mask = 1 | (1 << 1);
    gl.render(scene, camera);
    return true;
  });
  return null;
}
