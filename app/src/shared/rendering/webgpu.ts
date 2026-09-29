import { Renderer, StandardNodeLibrary, WebGPUBackend } from "three/webgpu";
import type { WebGLRenderer } from "three";

/** Same node/material library as WebGPURenderer, with no WebGL fallback backend. */
export class NativeWebGPURenderer extends Renderer {
  readonly isWebGPURenderer = true;
  lost = false;
  readonly lifetime = new AbortController();
  private disposal: Promise<void> | undefined;
  private observesDevice = false;

  /**
   * Opt-in GPU timestamp tracking. Three reads this when the WebGPUBackend is
   * constructed, so it cannot be enabled later without rebuilding the backend.
   * Off by default: the query pool is diagnostic overhead we do not want to
   * carry in the shipped renderer. `?gpuTimestamps=1` turns it on for a
   * measurement session, and `startGpuFrameProbe` requires it.
   */
  static trackTimestamp = typeof location !== "undefined"
    && new URLSearchParams(location.search).has("gpuTimestamps");

  /**
   * Opt-in MSAA, so the claim below can be **measured** instead of asserted.
   *
   * Off by default and off in the shipped renderer: MSAA buys nothing for splats
   * and costs a 4x sample target plus a per-frame resolve. This flag exists only
   * so `bun run probe:gpu -- --msaa 1` can produce the real-asset on/off
   * comparison — which, as of 2026-09-30, had never been taken with the fixed
   * probe. Mirrors `?gpuTimestamps=1`: a URL flag for a measurement session,
   * never a user-facing setting.
   */
  static antialias = typeof location !== "undefined"
    && new URLSearchParams(location.search).has("msaa");

  constructor(canvas: HTMLCanvasElement, options?: { antialias?: boolean; trackTimestamp?: boolean }) {
    // antialias defaults to Three's own default (false). Gaussian Splat Lite
    // documents that MSAA does not improve splat rendering and significantly
    // reduces performance. The option (and the `?msaa=1` flag above) exists so a
    // probe can measure that claim instead of asserting it.
    super(new WebGPUBackend({
      canvas,
      alpha: true,
      trackTimestamp: options?.trackTimestamp ?? NativeWebGPURenderer.trackTimestamp,
    }), { antialias: options?.antialias ?? NativeWebGPURenderer.antialias, alpha: true });
    this.library = new StandardNodeLibrary();
  }

  override async init(): Promise<this> {
    await super.init();
    if (!this.observesDevice) {
      this.observesDevice = true;
      // Three intentionally ignores 'destroyed'. Ignore our own teardown too,
      // but surface unexpected external destruction instead of a blank canvas.
      const backend = this.backend as typeof this.backend & { device: { lost: Promise<{ reason: string; message: string }> } };
      void backend.device.lost.then((info) => {
        if (info.reason === "destroyed" && !this.lifetime.signal.aborted) {
          this.onDeviceLost({ api: "WebGPU", message: info.message || "GPU device was destroyed.", reason: info.reason, originalEvent: info });
        }
      });
    }
    return this;
  }

  override dispose(): Promise<void> {
    this.lifetime.abort();
    // Renderer.dispose() calls setAnimationLoop(), which would retry init after
    // a failed adapter request. Release the partial backend directly instead.
    // @types/three r186 omits Backend.dispose(), present in the pinned runtime.
    const backend = this.backend as typeof this.backend & { dispose(): Promise<void> };
    return this.disposal ??= this.initialized ? super.dispose() : backend.dispose();
  }
}

/** R3F 9's store is still typed as WebGLRenderer even when using its custom renderer API. */
export function webgpuRenderer(renderer: WebGLRenderer): NativeWebGPURenderer {
  if (!(renderer instanceof NativeWebGPURenderer)) throw new Error("A native WebGPU renderer is required.");
  return renderer;
}
