import { useThree } from "@react-three/fiber";
import { GaussianSplatRenderer, Splats, SplatMesh } from "gaussian-splat-lite";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ResettableErrorBoundary } from "../../shared/lib/ResettableErrorBoundary";
import type { WorldSemantics } from "../../shared/lib/libraryApi";
import { webgpuRenderer } from "../../shared/rendering/webgpu";
import { DeferredResource } from "../../shared/rendering/DeferredResource";
import { worldTransform } from "./worldTransform";

interface Resource { splats: Splats; refs: number; release?: ReturnType<typeof setTimeout> }
const resources = new Map<string, Resource>();

function acquire(url: string) {
  let resource = resources.get(url);
  if (!resource) {
    resource = { splats: new Splats({ url }), refs: 0 };
    resources.set(url, resource);
  }
  clearTimeout(resource.release);
  resource.refs++;
  return resource;
}

function release(url: string, resource: Resource) {
  if (--resource.refs > 0) return;
  resource.release = setTimeout(() => {
    if (resource.refs !== 0 || resources.get(url) !== resource) return;
    resource.splats.dispose();
    resources.delete(url);
  }, 0);
}

/**
 * **一个** `GaussianSplatRenderer` 服务全部窗格，不再每窗格（每 layer）一个。
 *
 * 为什么：one renderer per pane 曾经是为了"布局切换只切 `visible`、不销毁重建"——因为原生 WebGPU
 * 的排序器重编译在 1.9M 点上可能超过一分钟。但那样做的代价是每个窗格各持一份 ProjectionCache /
 * SortCenterCache / 排序器 / splat 纹理，而且每帧各走一次 `onBeforeRender`（场景遍历、uniform 准备、
 * 输入指纹比对），各自独立投影独立排序。
 *
 * 现在核心场景用**一趟 ArrayCamera** 画（见 paneViewports.ts），GSL 的投影器看到 `array.cameras`
 * 就把所有眼放进**同一条 compute 链**、用 `cameraIndex` 取每眼的排序——所以一个实例就够，
 * 而且它顺便修掉一个真实缺陷：逐窗格时 GSL 的 `renderSize` 取的是 `getDrawingBufferSize()`（整张画布），
 * 于是 `minPixelRadius` / `clipXY` 在分屏下按整画布而不是窗格算；multiView 路径取的是
 * `camera.viewport`，也就是各窗格自己的尺寸。
 *
 * 这个对象停留在 layer 0（`Object3D` 默认），所以每个子相机都看得见它（子相机 mask 恒为 `1 | 1<<layer`）。
 */
function SplatRenderer({ generation }: { generation: string }) {
  const gl = useThree((state) => state.gl);
  const invalidate = useThree((state) => state.invalidate);
  const [renderer, setRenderer] = useState<GaussianSplatRenderer | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const resource = useMemo(() => new DeferredResource(() => {
    const owned = new GaussianSplatRenderer({ renderer: webgpuRenderer(gl), onDirty: invalidate,
      renderDepth: false, autoStochastic: false, stochastic: false });
    owned.name = "splat-view";
    return owned;
  }), [gl, invalidate]);
  useEffect(() => {
    try {
      const lease = resource.acquire();
      setRenderer(lease.value);
      invalidate();
      return lease.release;
    } catch (cause) { setError(cause instanceof Error ? cause : new Error(String(cause))); }
  }, [resource, invalidate]);
  useLayoutEffect(() => {
    // 换代时必须丢掉指向已释放 Splats 的显示映射；保留可复用的容量与管线。
    renderer?.clearSplats();
    invalidate();
  }, [renderer, generation, invalidate]);
  if (error) throw error;
  return renderer ? <primitive object={renderer} dispose={null} /> : null;
}

function SplatScene({ url, semantics }: { url: string; semantics: WorldSemantics }) {
  const invalidate = useThree((state) => state.invalidate);
  const [loaded, setLoaded] = useState<SplatMesh | null>(null);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    let cancelled = false;
    let owned: SplatMesh | undefined;
    const resource = acquire(url);
    void resource.splats.initialized.then(() => {
      if (cancelled) return;
      const mesh = new SplatMesh({ splats: resource.splats, editable: false, raycastable: false });
      mesh.name = "project-splats";
      owned = mesh;
      setLoaded(owned);
      invalidate();
    }).catch((cause: unknown) => {
      if (!cancelled) setError(cause instanceof Error ? cause : new Error(String(cause)));
    });
    return () => {
      cancelled = true;
      if (owned) {
        owned.splats = undefined;
        owned.dispose();
      }
      release(url, resource);
    };
  }, [url, invalidate]);

  if (error) throw error;
  if (!loaded) return null;
  const transform = worldTransform(semantics);
  return <>
    <group position={transform.position} rotation={transform.rotation} scale={transform.scale}>
      <primitive object={loaded} dispose={null} />
    </group>
  </>;
}

/** Native WebGPU projection/sorting, shared by every pane through one multiView pass. */
function SplatSource(props: { url: string; semantics: WorldSemantics }) {
  const [attempt, setAttempt] = useState(0);
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const handleError = useCallback(() => {
    if (attempt > 0) return;
    // Let all failed view leases release before retrying the shared source.
    retryTimer.current = setTimeout(() => setAttempt(1), 100);
  }, [attempt]);
  useEffect(() => () => clearTimeout(retryTimer.current), []);
  return <ResettableErrorBoundary resetKey={`${props.url}|${attempt}`} fallback={null} onError={handleError}>
    <SplatScene key={`${props.url}|${attempt}`} {...props} />
  </ResettableErrorBoundary>;
}

export default function SplatModel(props: { url: string; semantics: WorldSemantics }) {
  return <>
    <SplatRenderer generation={props.url} />
    <SplatSource key={props.url} url={props.url} semantics={props.semantics} />
  </>;
}
