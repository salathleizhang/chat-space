import type { AppBase } from "playcanvas";

/**
 * PlayCanvas 侧的离屏截图：渲染进**私有 render target**、读回像素。
 *
 * ### 与 three 侧的三个差别
 *  1. **不需要手工解行填充**。three 的 `readRenderTargetPixelsAsync` 返回带 256 字节行对齐的
 *     buffer，所以 `capture.ts` 里有 `unpackRGBA()`；PlayCanvas 的 `Texture.read` **自己**做对齐
 *     与解包（`webgpu-texture.js` 的 `read` 里 `roundUp(bytesPerRow, 256)` 后逐行 `subarray` 拷贝），
 *     应用侧只给紧凑的 `Uint8Array(width * height * 4)`。**不要**把 three 那份 `unpackRGBA` 搬过来，
 *     那会把已经紧凑的数据再解一遍。
 *  2. **`RenderTarget` 没有 `width`/`height`/`colorFormat` 选项**：尺寸与格式来自你给的纹理
 *     （`render-target.js` 只看 `colorBuffer` / `colorBuffers` / `depthBuffer` / `samples` / `depth`）。
 *  3. **读回必须 `immediate: true`**。帧外没有东西会 submit 共享的 command encoder，
 *     延迟读会在拷贝真正执行前就 map staging buffer，读回零值。
 *     SuperSplat 在 `render.ts` / `picker.ts` / `equirect-renderer.ts` 三处都写了这条注释。
 *
 * ### 为什么不改全局相机状态
 * 相机上的 `renderTarget` 是它自己的字段，改它只影响这一台相机——比"改全局目标尺寸再还原"安全得多。
 * 这里仍然遵守 three 侧那条纪律：**设置与还原之间不 await**，免得可见帧循环在中间插进来。
 *
 * ⚠️ 本文件对引擎 API 的调用**只在真实浏览器里才算验证过**。
 */

export interface CapturePixels {
  width: number;
  height: number;
  /** 紧凑排布（无行填充）的 RGBA 字节。 */
  rgba: Uint8Array;
}

export interface CaptureSceneOptions {
  /** 输出边长（正方形）。截图用途允许被上层降到更小的尺寸。 */
  size: number;
  /** 用哪台相机拍。不传则用场景里第一台启用的相机。 */
  camera?: unknown;
  /** 强制不透明清屏色；不传则沿用相机原本的 clearColor。 */
  clearColor?: [number, number, number];
}

/**
 * 把场景渲染进一张私有 render target 并读回像素。
 *
 * 调用者负责准入与预算（见 `shared/rendering/CaptureQueue.ts` 与 `ResourceBudget.ts`——
 * 那两个模块是纯 TS、与引擎无关，**迁移时不要重写**）。
 */
export async function captureScenePixels(app: AppBase, options: CaptureSceneOptions): Promise<CapturePixels> {
  const pc = await import("playcanvas");
  const { Texture, RenderTarget, PIXELFORMAT_RGBA8, ADDRESS_CLAMP_TO_EDGE, FILTER_LINEAR } = pc;
  const size = Math.max(1, Math.floor(options.size));
  const device = (app as unknown as { graphicsDevice: InstanceType<typeof pc.GraphicsDevice> }).graphicsDevice;

  const camera = (options.camera ?? findFirstCamera(app)) as
    | { renderTarget: unknown; rect: unknown }
    | undefined;
  if (!camera) throw new Error("captureScenePixels: 场景里没有可用的相机");

  /** 尺寸与格式来自这张纹理；`RenderTarget` 自身没有 width/colorFormat 选项。 */
  const colorTexture = new Texture(device, {
    name: "capture-color",
    width: size,
    height: size,
    format: PIXELFORMAT_RGBA8,
    mipmaps: false,
    minFilter: FILTER_LINEAR,
    magFilter: FILTER_LINEAR,
    addressU: ADDRESS_CLAMP_TO_EDGE,
    addressV: ADDRESS_CLAMP_TO_EDGE,
  });
  // depth/stencil 由引擎按 colorBuffer 的尺寸自动配一张（`options.depth`）。
  const target = new RenderTarget({ name: "capture-target", colorBuffer: colorTexture, depth: true, samples: 1 });

  const previous = { renderTarget: camera.renderTarget, rect: camera.rect };
  try {
    // —— 以下到还原为止不 await：可见帧循环可能在这中间跑，别让它看到半改的相机 ——
    camera.renderTarget = target;
    (camera as { rect?: unknown }).rect = new pc.Vec4(0, 0, 1, 1);
    // 一次完整提交（含所有相机）；只有这台相机被指向私有 target。
    app.render();
    camera.renderTarget = previous.renderTarget;
    camera.rect = previous.rect;

    // immediate：帧外没有东西会 submit，延迟读会拿到零值。
    const data = await colorTexture.read(0, 0, size, size, { renderTarget: target, immediate: true });
    // Texture.read 已经解完行填充，这里直接是紧凑 RGBA。
    return { width: size, height: size, rgba: new Uint8Array(data.buffer, data.byteOffset, data.byteLength) };
  } finally {
    camera.renderTarget = previous.renderTarget;
    camera.rect = previous.rect;
    target.destroy();
    colorTexture.destroy();
  }
}

function findFirstCamera(app: AppBase): unknown {
  const root = (app as unknown as { root: { findComponents(type: string): unknown[] } }).root;
  const cameras = root.findComponents("camera");
  return cameras.find((component) => (component as { enabled?: boolean }).enabled !== false) ?? cameras[0];
}
