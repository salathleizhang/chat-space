import { Color, RenderTarget, UnsignedByteType, Vector4, type Camera, type Scene } from "three";
import type { NativeWebGPURenderer } from "./webgpu";
import { MIN_CAPTURE_SIZE, captureBudget, type MemoryPressure } from "./ResourceBudget";
import { modelResources } from "./ModelResources";

/**
 * 截图准入要同时看模型缓存的驻留量：两本账抢的是同一块显存，只看截图自己那本会出现
 * "额度还有、显存已被模型占满"，分配 render target 时直接设备丢失。
 */
const modelPressure: MemoryPressure = {
  residentBytes: () => modelResources.memory.residentBytes,
  residentLimit: () => modelResources.memory.residentLimit,
};

/**
 * Render into a private target. Never resize or read the displayed swapchain.
 *
 * Under memory pressure the capture degrades instead of failing: idle model cache
 * entries are reclaimed, then the resolution halves down to a floor. The returned
 * canvas is sized to the resolution actually used, so a degraded capture is
 * smaller than `size` and is recorded in `captureBudget.downgrades`.
 */
export async function captureScene(renderer: NativeWebGPURenderer, scene: Scene, camera: Camera, size: number): Promise<HTMLCanvasElement> {
  if (renderer.lost) throw new Error("GPU connection lost during capture.");
  /*
    占用一直持到读回结束。reclaim 只为**这份差额**回收空闲模型条目——活动资源永远不动，
    因为抽走正在渲染的资源比降一张截图的分辨率糟得多。
  */
  const reservation = captureBudget.reserveCapture(
    size,
    renderer.samples,
    (needBytes) => { modelResources.trimToFit(needBytes); },
    MIN_CAPTURE_SIZE,
    modelPressure,
  );
  const edge = reservation.size;
  // The output pass already encodes sRGB. Keep an unorm (not sRGB) attachment
  // to avoid a second hardware sRGB conversion during readback.
  let target: RenderTarget | undefined;
  try {
    target = new RenderTarget(edge, edge, { type: UnsignedByteType, samples: renderer.samples });
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
    const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, edge, edge);
    if (renderer.lost) throw new Error("GPU connection lost during capture.");
    const canvas = document.createElement("canvas");
    canvas.width = canvas.height = edge;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Image encoding is unavailable.");
    // Native WebGPU readback uses top-left row order.
    const rgba = unpackRGBA(new Uint8Array(pixels.buffer, pixels.byteOffset, pixels.byteLength), edge, edge);
    context.putImageData(new ImageData(rgba, edge, edge), 0, 0);
    return canvas;
  } finally {
    target?.dispose();
    reservation.release();
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
