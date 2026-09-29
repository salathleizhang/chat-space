import { createPortal, useThree } from "@react-three/fiber";
import { useEffect, useState, type ReactNode, type RefObject } from "react";
import { Scene, type OrthographicCamera, type PerspectiveCamera } from "three";
import { useTrackedRect } from "./PaneCamera";
import { viewRect } from "./viewRect";
import { useProjectScene, useViewPass, ViewIdContext } from "./ProjectRenderRuntime";

function DrawView({ track, coreScene, layer, children }: { track: RefObject<HTMLElement | null>; coreScene: Scene; layer: number; children: ReactNode }) {
  const get = useThree((state) => state.get);
  const canvas = useThree((state) => state.gl.domElement);
  const paneRect = useTrackedRect(track);
  const canvasRect = useTrackedRect(canvas);
  useViewPass("scene", () => {
    const { gl, scene, camera } = get();
    if (!paneRect.current || !canvasRect.current) return false;
    const rect = viewRect(canvasRect.current, paneRect.current);
    if (rect.width <= 0 || rect.height <= 0) return false;
    camera.layers.mask = 1 | (1 << layer);
    const perspective = camera as PerspectiveCamera;
    const orthographic = camera as OrthographicCamera;
    if (perspective.isPerspectiveCamera) {
      if (perspective.aspect !== rect.width / rect.height) {
        perspective.aspect = rect.width / rect.height;
        perspective.updateProjectionMatrix();
      }
    } else if (orthographic.isOrthographicCamera && (orthographic.right !== rect.width / 2 || orthographic.top !== rect.height / 2)) {
      orthographic.left = -rect.width / 2;
      orthographic.right = rect.width / 2;
      orthographic.top = rect.height / 2;
      orthographic.bottom = -rect.height / 2;
      orthographic.updateProjectionMatrix();
    }
    const autoClear = gl.autoClear;
    gl.autoClear = false;
    gl.setViewport(rect.left, rect.top, rect.width, rect.height);
    gl.setScissor(rect.left, rect.top, rect.width, rect.height);
    gl.setScissorTest(true);
    try { gl.render(coreScene, camera); gl.render(scene, camera); }
    finally { gl.setScissorTest(false); gl.autoClear = autoClear; }
    return true;
  });
  return <>{children}<group onPointerOver={() => {}} /></>;
}

export function WebGPUView({ id, layer, track, children }: { id: string; layer: number; track: RefObject<HTMLElement | null>; children: ReactNode }) {
  const coreScene = useProjectScene();
  const [scene] = useState(() => new Scene());
  const [rect, setRect] = useState<DOMRect | null>(null);
  const invalidate = useThree((state) => state.invalidate);
  useEffect(() => {
    const element = track.current;
    if (!element) return;
    const update = () => { setRect(element.getBoundingClientRect()); invalidate(); };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => { observer.disconnect(); window.removeEventListener("scroll", update, true); window.removeEventListener("resize", update); };
  }, [track, invalidate]);
  if (!rect) return null;
  return createPortal(<ViewIdContext.Provider value={id}><DrawView track={track} coreScene={coreScene} layer={layer}>{children}</DrawView></ViewIdContext.Provider>, scene, {
    size: { width: rect.width, height: rect.height, top: rect.top, left: rect.left },
    events: {
      priority: 1,
      connected: track.current ?? undefined,
      compute(event, state) {
        const bounds = track.current?.getBoundingClientRect();
        if (!bounds || event.target !== track.current) {
          state.raycaster.camera = null!;
          return;
        }
        state.pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1, -(event.clientY - bounds.top) / bounds.height * 2 + 1);
        state.raycaster.setFromCamera(state.pointer, state.camera);
      },
    },
  });
}
