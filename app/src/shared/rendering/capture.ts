import { Color, RenderTarget, UnsignedByteType, Vector4, type Camera, type Scene } from "three";
import type { NativeWebGPURenderer } from "./webgpu";
import { captureBudget, captureBytes } from "./ResourceBudget";

/** Render into a private target. Never resize or read the displayed swapchain. */
export async function captureScene(renderer: NativeWebGPURenderer, scene: Scene, camera: Camera, size: number): Promise<HTMLCanvasElement> {
  if (renderer.lost) throw new Error("GPU connection lost during capture.");
  const release = captureBudget.reserve(captureBytes(size, renderer.samples));
  // The output pass already encodes sRGB. Keep an unorm (not sRGB) attachment
  // to avoid a second hardware sRGB conversion during readback.
  let target: RenderTarget | undefined;
  try {
    target = new RenderTarget(size, size, { type: UnsignedByteType, samples: renderer.samples });
    const previous = {
      output: renderer.getOutputRenderTarget(),
      target: renderer.getRenderTarget(), viewport: renderer.getViewport(new Vector4()),
      scissor: renderer.getScissor(new Vector4()), scissorTest: renderer.getScissorTest(),
      autoClear: renderer.autoClear, color: renderer.getClearColor(new Color()), alpha: renderer.getClearAlpha(),
    };
    // No await between setting and restoring renderer state: the visible frame
    // loop may run while readback is pending.
    try {
      // Mark as final output, so tone mapping and output color conversion match
      // the displayed canvas (ordinary intermediate targets omit tone mapping).
      renderer.setOutputRenderTarget(target);
      renderer.setRenderTarget(target);
      renderer.setScissorTest(false);
      renderer.autoClear = true;
      renderer.render(scene, camera);
    } finally {
      renderer.setOutputRenderTarget(previous.output);
      renderer.setRenderTarget(previous.target);
      renderer.setViewport(previous.viewport);
      renderer.setScissor(previous.scissor);
      renderer.setScissorTest(previous.scissorTest);
      renderer.autoClear = previous.autoClear;
      renderer.setClearColor(previous.color, previous.alpha);
    }
    const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, size, size);
    if (renderer.lost) throw new Error("GPU connection lost during capture.");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = size;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image encoding is unavailable.");
    // Native WebGPU readback uses top-left row order.
    const rgba = unpackRGBA(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), size, size);
    context.putImageData(new ImageData(rgba, size, size), 0, 0);
    return canvas;
  } finally {
    target?.dispose();
    release();
  }
}

/** WebGPU buffer copies pad each row to 256 bytes (except the last row). */
export function unpackRGBA(bytes: Uint8Array, width: number, height: number): Uint8ClampedArray<ArrayBuffer> {
  const rowBytes = width * 4;
  const stride = bytes.length === rowBytes * height ? rowBytes : Math.ceil(rowBytes / 256) * 256;
  if (bytes.length < stride * (height - 1) + rowBytes) throw new Error("Incomplete GPU image readback.");
  const rgba = new Uint8ClampedArray(rowBytes * height);
  for (let y = 0; y < height; y++) rgba.set(bytes.subarray(y * stride, y * stride + rowBytes), y * rowBytes);
  return rgba;
}
