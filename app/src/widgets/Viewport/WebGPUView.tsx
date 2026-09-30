import { createPortal, useThree } from "@react-three/fiber";
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { Scene } from "three";
import { useTrackedRect } from "./PaneCamera";
import { hasDrawableContent } from "./drawableContent";
import { sameRect, viewRect } from "./viewRect";
import { usePaneView, useViewPass, ViewIdContext } from "./ProjectRenderRuntime";

/**
 * 窗格的**叠加层**这一趟（拾取代理 + gizmo）。核心场景不在这里——它由
 * `ProjectRenderRuntime` 用一趟 ArrayCamera 统一画（见 paneViewports.ts）。这个 pass 排在那一趟
 * 之后，所以叠在上面；同时它把本窗格的相机/视口登记给核心那趟用。
 */
function DrawView({ id, track, layer, children }: { id: string; track: RefObject<HTMLElement | null>; layer: number; children: ReactNode }) {
  const get = useThree((state) => state.get);
  const canvas = useThree((state) => state.gl.domElement);
  const paneRect = useTrackedRect(track);
  const canvasRect = useTrackedRect(canvas);
  const rectOf = () => {
    if (!paneRect.current || !canvasRect.current) return null;
    const rect = viewRect(canvasRect.current, paneRect.current);
    return rect.width > 0 && rect.height > 0 ? rect : null;
  };
  usePaneView(id, layer, () => {
    const rect = rectOf();
    return rect ? { camera: get().camera, ...rect } : null;
  });
  useViewPass("scene", () => {
    const { gl, scene, camera } = get();
    const rect = rectOf();
    if (!rect) return false;
    /*
      叠加层里只有两类东西：拾取代理（裸 `Object3D`，只有 `raycast`、没有几何体，见
      sharedPicking.ts）和有选中时的 gizmo。没有可绘制对象时这一趟 `gl.render()` 是纯空转——
      它仍然要走 `beginRender`/`finishRender`（一次 `queue.submit`、一次 swapchain 取纹理），
      而且因为本应用 `needsFrameBufferTarget` 恒为真（tone mapping = ACES、outputColorSpace ≠ working），
      中间 framebuffer 还会被全屏 blit 回画布一次，复制的是上一趟刚画上去的同一批像素。
      空场景不提交，见 drawableContent.ts。

      **但仍然返回 true**：返回 false 会让 `RenderSchedule` 跳过本窗格的 HUD pass，坐标轴球就没了。
    */
    if (hasDrawableContent(scene)) {
      const autoClear = gl.autoClear;
      gl.autoClear = false;
      gl.setViewport(rect.left, rect.top, rect.width, rect.height);
      gl.setScissor(rect.left, rect.top, rect.width, rect.height);
      gl.setScissorTest(true);
      try { gl.render(scene, camera); }
      finally { gl.setScissorTest(false); gl.autoClear = autoClear; }
    }
    return true;
  });
  return <>{children}<group onPointerOver={() => {}} /></>;
}

export function WebGPUView({ id, layer, track, children }: { id: string; layer: number; track: RefObject<HTMLElement | null>; children: ReactNode }) {
  const [scene] = useState(() => new Scene());
  const [rect, setRect] = useState<DOMRect | null>(null);
  const rectRef = useRef<DOMRect | null>(null);
  const invalidate = useThree((state) => state.invalidate);
  useEffect(() => {
    const element = track.current;
    if (!element) return;
    /*
      这里量到的矩形只供 portal 的 `size` 用；真正绘制用的矩形走 PaneCamera 的共享跟踪缓存
      （`useTrackedRect`，它只写 ref、不 setState）。

      `scroll` 是挂在 window 上的**捕获相**监听，所以在模型列表、聊天记录这类内部滚动容器里
      滚一下也会打进来。旧写法无条件 `setRect(新的 DOMRect)` + `invalidate()`：新对象引用必然
      穿透 React 的 bail out，于是"窗格一动没动"的一次滚动 = 每个窗格重渲染 + 多画一整帧。
      矩形没变就什么都不做。
    */
    const update = () => {
      const next = element.getBoundingClientRect();
      const previous = rectRef.current;
      if (previous && sameRect(previous, next)) return;
      rectRef.current = next;
      setRect(next);
      invalidate();
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => { observer.disconnect(); window.removeEventListener("scroll", update, true); window.removeEventListener("resize", update); };
  }, [track, invalidate]);
  if (!rect) return null;
  return createPortal(<ViewIdContext.Provider value={id}><DrawView id={id} track={track} layer={layer}>{children}</DrawView></ViewIdContext.Provider>, scene, {
    size: { width: rect.width, height: rect.height, top: rect.top, left: rect.left },
    events: {
      priority: 1,
      connected: track.current ?? undefined,
      compute(event, state) {
        /*
          守卫必须排在测量**之前**。`getBoundingClientRect()` 会强制浏览器同步刷新布局，而同一个
          pointermove 会派发给每一个窗格；顺序反了就是"每次指针移动 N 次强制布局"（N = 窗格数），
          哪怕指针根本不在视口里、这次事件跟本窗格毫无关系。`event.target` 的判定不依赖 bounds，
          可以提前，且语义与原来完全一致。
        */
        if (event.target !== track.current) {
          state.raycaster.camera = null!;
          return;
        }
        const bounds = track.current?.getBoundingClientRect();
        if (!bounds) {
          state.raycaster.camera = null!;
          return;
        }
        state.pointer.set((event.clientX - bounds.left) / bounds.width * 2 - 1, -(event.clientY - bounds.top) / bounds.height * 2 + 1);
        state.raycaster.setFromCamera(state.pointer, state.camera);
      },
    },
  });
}
