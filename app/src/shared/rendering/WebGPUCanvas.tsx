import { Canvas, useFrame, type CanvasProps } from "@react-three/fiber";
import { useCallback, useEffect, useRef, useState } from "react";
import { ResettableErrorBoundary } from "../lib/ResettableErrorBoundary";
import { NativeWebGPURenderer } from "./webgpu";
import { captureQueue } from "./CaptureQueue";
import { initializeRenderer } from "./initializeRenderer";

type Props = Omit<CanvasProps, "gl"> & { onFailure?: (error: Error) => void };
const pendingForever = () => new Promise<NativeWebGPURenderer>(() => {});

/** Clear once before the View/HUD passes, including with frameloop=demand. */
function ClearFrame() {
  useFrame(({ gl }) => {
    gl.setRenderTarget(null);
    gl.setScissorTest(false);
    const { width, height } = gl.domElement;
    const dpr = gl.getPixelRatio();
    gl.setViewport(0, 0, width / dpr, height / dpr);
    gl.clear(true, true, true);
  }, 0);
  return null;
}

function Session({ onFailure, children, ...props }: Props & { onFailure: (error: Error) => void }) {
  const fail = useRef(onFailure);
  fail.current = onFailure;
  const lifetime = useRef({ active: true, renderers: new Set<NativeWebGPURenderer>(), timer: undefined as ReturnType<typeof setTimeout> | undefined });
  const factories = useRef(new WeakMap<HTMLCanvasElement, Promise<NativeWebGPURenderer>>());

  useEffect(() => {
    const lease = lifetime.current;
    lease.active = true;
    clearTimeout(lease.timer);
    return () => {
      lease.active = false;
      // StrictMode's simulated unmount is immediately reclaimed. R3F delays its
      // scene cleanup by 500ms, so release the device after that cleanup.
      lease.timer = setTimeout(() => {
        for (const renderer of lease.renderers) void renderer.dispose();
        lease.renderers.clear();
      }, 600);
    };
  }, []);

  const createRenderer = useCallback((defaults: { canvas: HTMLCanvasElement | OffscreenCanvas }) => {
    const canvas = defaults.canvas as HTMLCanvasElement;
    const cached = factories.current.get(canvas);
    if (cached) return cached;
    const initialized = (async () => {
      let renderer: NativeWebGPURenderer | undefined;
      try {
        if (!window.isSecureContext || !("gpu" in navigator)) {
          throw new Error("WebGPU is unavailable. Use a supported browser over HTTPS or localhost.");
        }
        renderer = new NativeWebGPURenderer(canvas);
        const owned = renderer;
        renderer.onDeviceLost = (info) => {
          owned.lost = true;
          owned.lifetime.abort();
          if (lifetime.current.active) fail.current(new Error(`GPU connection lost: ${info.message}`));
        };
        renderer.onError = (info) => {
          if (lifetime.current.active) fail.current(new Error(`WebGPU rendering failed: ${typeof info === "string" ? info : JSON.stringify(info)}`));
        };
        await initializeRenderer(renderer);
        if (!lifetime.current.active) {
          await renderer.dispose();
          return pendingForever();
        }
        lifetime.current.renderers.add(renderer);
        canvas.dataset.renderer = "webgpu";
        return renderer;
      } catch (cause) {
        // initializeRenderer owns failed/late init cleanup. Disposing here on
        // timeout would race an uncancellable adapter/device request.
        if (lifetime.current.active) fail.current(cause instanceof Error ? cause : new Error(String(cause)));
        // R3F's async configure has no rejection handler. The error is shown in
        // the owning DOM boundary; this abandoned root must never mount children.
        return pendingForever();
      }
    })();
    factories.current.set(canvas, initialized);
    return initialized;
  }, []);

  return (
    <Canvas {...props} onPointerMove={(event) => { captureQueue.interaction(); props.onPointerMove?.(event); }}
      onPointerDown={(event) => { captureQueue.interaction(); props.onPointerDown?.(event); }}
      onWheel={(event) => { captureQueue.interaction(); props.onWheel?.(event); }}
      gl={createRenderer as unknown as NonNullable<CanvasProps["gl"]>}>
      <ClearFrame />
      {children}
    </Canvas>
  );
}

/** All 3D surfaces share the same capability gate, error UX and device lifecycle. */
export function WebGPUCanvas({ onFailure, ...props }: Props) {
  const [error, setError] = useState<Error | null>(null);
  const [attempt, setAttempt] = useState(0);
  const failed = useRef(false);
  const failure = useCallback((cause: Error) => {
    if (failed.current) return;
    failed.current = true;
    setError(cause);
    onFailure?.(cause);
  }, [onFailure]);
  const retry = () => { failed.current = false; setError(null); setAttempt((value) => value + 1); };
  const fallback = (
    <div className="pointer-events-auto flex h-full w-full flex-col items-center justify-center gap-3 bg-canvas p-6 text-center text-sm text-ink" role="alert">
      <span>3D rendering needs WebGPU</span>
      <span className="max-w-md text-xs text-ink-subtle">{error?.message ?? "The renderer could not continue. Please try again."}</span>
      <button type="button" className="rounded-lg border border-hairline px-3 py-2" onClick={retry}>Retry rendering</button>
    </div>
  );
  // Pane tracking divs sit above the canvas to receive pointer events. The
  // recovery panel must sit above those divs, but below the app's z-10 chrome.
  const failureView = <div className={`${props.className ?? ""} relative z-[1] h-full w-full`} style={props.style}>{fallback}</div>;
  return (
    <ResettableErrorBoundary resetKey={String(attempt)} fallback={failureView} onError={failure}>
      {error ? failureView : <Session key={attempt} {...props} onFailure={failure} />}
    </ResettableErrorBoundary>
  );
}
