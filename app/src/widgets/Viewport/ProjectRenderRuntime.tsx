import { useFrame, useThree } from "@react-three/fiber";
import { createContext, useContext, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Scene } from "three";
import { RenderSchedule } from "./RenderSchedule";

const RuntimeContext = createContext<{ schedule: RenderSchedule; scene: Scene } | null>(null);
export const ViewIdContext = createContext("first-person");

export function ProjectRenderRuntime({ children }: { children: ReactNode }) {
  const scene = useThree((state) => state.scene);
  const [runtime] = useState(() => ({ schedule: new RenderSchedule(), scene }));
  useFrame((_, delta) => {
    // Models and animation mixers have already advanced once at priority 0.
    scene.updateMatrixWorld();
    const autoUpdate = scene.matrixWorldAutoUpdate;
    scene.matrixWorldAutoUpdate = false;
    try { runtime.schedule.draw(delta); }
    finally { scene.matrixWorldAutoUpdate = autoUpdate; }
  }, 1);
  return <RuntimeContext.Provider value={runtime}>{children}</RuntimeContext.Provider>;
}

export function useProjectScene() {
  const runtime = useContext(RuntimeContext);
  if (!runtime) throw new Error("A project render runtime is required.");
  return runtime.scene;
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
