import { useThree } from "@react-three/fiber";
import { GaussianSplatRenderer, Splats, SplatMesh } from "gaussian-splat-lite";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ResettableErrorBoundary } from "../../shared/lib/ResettableErrorBoundary";
import type { WorldSemantics } from "../../shared/lib/libraryApi";
import { webgpuRenderer } from "../../shared/rendering/webgpu";
import { DeferredResource } from "../../shared/rendering/DeferredResource";
import { VIEW_LAYERS } from "./sharedPicking";
import { worldTransform } from "./worldTransform";

interface Resource { splats: Splats; refs: number; release?: ReturnType<typeof setTimeout> }
const resources = new Map<string, Resource>();
// Native WebGPU sorter compilation for a 1.9M-point world can exceed a minute
// after repeated create/dispose cycles. These four instances belong to the
// Splat surface, not a source URL or layout. Source replacement reuses the
// pipelines; removing the world/surface disposes each exactly once.
const WORLD_VIEW_LAYERS = Object.values(VIEW_LAYERS);

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

function SplatViewRenderer({ layer, active, generation }: { layer: number; active: boolean; generation: string }) {
  const gl = useThree((state) => state.gl);
  const invalidate = useThree((state) => state.invalidate);
  const [renderer, setRenderer] = useState<GaussianSplatRenderer | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const resource = useMemo(() => new DeferredResource(() => {
    const owned = new GaussianSplatRenderer({ renderer: webgpuRenderer(gl), onDirty: invalidate,
      renderDepth: false, autoStochastic: false, stochastic: false });
    owned.layers.set(layer);
    owned.name = `splat-view:${layer}`;
    return owned;
  }), [gl, invalidate, layer]);
  useEffect(() => {
    try {
      const lease = resource.acquire();
      setRenderer(lease.value);
      invalidate();
      return lease.release;
    } catch (cause) { setError(cause instanceof Error ? cause : new Error(String(cause))); }
  }, [resource, invalidate]);
  useLayoutEffect(() => {
    // Hidden views must also drop references to the previous source. Keep only
    // reusable capacity/pipelines, never a display mapping to disposed Splats.
    renderer?.clearSplats();
    invalidate();
  }, [renderer, generation, invalidate]);
  if (error) throw error;
  return renderer ? <primitive object={renderer} visible={active} dispose={null} /> : null;
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

/** Native WebGPU projection/sorting, with separate camera state for each view. */
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

export default function SplatModel(props: { url: string; semantics: WorldSemantics; viewLayers: number[] }) {
  return <>
    {WORLD_VIEW_LAYERS.map((layer) => <SplatViewRenderer key={layer} layer={layer} active={props.viewLayers.includes(layer)} generation={props.url} />)}
    <SplatSource key={props.url} url={props.url} semantics={props.semantics} />
  </>;
}
