import { Renderer, StandardNodeLibrary, WebGPUBackend } from "three/webgpu";
import type { WebGLRenderer } from "three";

/** Same node/material library as WebGPURenderer, with no WebGL fallback backend. */
export class NativeWebGPURenderer extends Renderer {
  readonly isWebGPURenderer = true;
  lost = false;
  readonly lifetime = new AbortController();
  private disposal: Promise<void> | undefined;
  private observesDevice = false;

  constructor(canvas: HTMLCanvasElement) {
    // antialias stays at Three's default (false). Gaussian Splat Lite documents
    // that MSAA does not improve splat rendering and significantly reduces
    // performance, so the explicit `antialias: true` here was paying for a 4x
    // sample target plus a per-frame resolve with no benefit.
    super(new WebGPUBackend({ canvas, alpha: true }), { antialias: false, alpha: true });
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
