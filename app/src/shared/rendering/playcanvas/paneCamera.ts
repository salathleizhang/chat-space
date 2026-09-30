/**
 * 窗格视口 → PlayCanvas 相机参数的换算。
 *
 * 这里把**本机核实过的四条约束**固化成代码与测试，因为它们在运行时都是静默失败：
 * 不会报错、不会崩，只是画面不对（整格黑、上下颠倒、或整个画布落到验证失败面板）。
 *
 * ### ① `camera.rect` 是归一化、**左下原点**，而 DOM 测量是左上原点
 * `Camera._rect` 默认 `new Vec4(0, 0, 1, 1)`，`(x, y)` 从**左下**量
 * （`playcanvas/src/scene/camera.js:107`）。而 `viewRect()` 输出的是左上原点。
 * 所以必须翻：`y = 1 - (top + height) / canvasHeight`。
 *
 * ### ② 只能填 rect，**不要自己再翻一次 y**
 * 归一化→像素只有一处（`renderer.js:426-448` 的 `setupViewport`），随后 WebGPU 后端自己
 * 把左下翻成左上（`webgpu-graphics-device.js:1867-1891`：`y = height - y - h`）。
 * WebGL 后端**不翻**。也就是说 rect 的语义是**后端无关**的；应用侧手动翻 y 会在 WebGPU 下反成颠倒。
 *
 * ### ③ 单位：用**画布 CSS 尺寸**做分母，DPR 自然抵消
 * `viewRect()` 给的是 CSS px。归一化之后，`CSS px / CSS 尺寸` 与
 * `buffer px / buffer 尺寸` 是同一个值，所以 DPR 与 `maxPixelRatio` 都不需要参与计算。
 * 传错分母（把 CSS px 除以 drawingBuffer 尺寸）会让窗格缩到 DPR 分之一。
 *
 * ### ④ 每格都必须清深度，否则那一格**整格黑**
 * 多个窗格共享同一个深度附件。只清第一个窗格时，其余窗格的深度区域保留未定义的残留值，
 * 它们的深度测试会全部失败——一个像素都不写，表现为纯黑（而不是清屏色）。
 * 本机二分定位：同机位无效、每格只清深度即可恢复。
 * 注意**每格清屏并不阻断 pass 合并**：非满尺寸 rect 的清屏是 pass 内被 viewport 裁剪的
 * 全屏 quad，不是 `loadOp: clear`。实测 1/2/4 窗格下 `startRenderPass` 恒为 1。
 */

export interface PixelViewport {
  /** 相对**画布左上角**的 CSS px（即 `viewRect()` 的输出）。 */
  left: number;
  top: number;
  width: number;
  height: number;
}

export interface CameraRect {
  x: number;
  y: number;
  /** 宽（归一化）。命名跟随 PlayCanvas 的 `Vec4(x, y, z, w)`。 */
  z: number;
  w: number;
}

export interface SizeLike {
  width: number;
  height: number;
}

const clamp01 = (value: number) => (value < 0 ? 0 : value > 1 ? 1 : value);

/**
 * 把左上原点的像素视口换算成 `camera.rect`（归一化、左下原点）。
 *
 * 结果会**钳到 [0,1]**：WebGPU 的 `setViewport` **不做钳制**，越界即验证错误把整块画布打到
 * 失败面板（`setScissor` 才钳制）。窗格是从 DOM 量出来的，四舍五入偶尔会差一个像素，
 * 所以这里防御性钳制；真的越界属于布局 bug，由 `isRectInBounds` 让调用方看见。
 */
export function toCameraRect(viewport: PixelViewport, canvasCssSize: SizeLike): CameraRect {
  if (canvasCssSize.width <= 0 || canvasCssSize.height <= 0) return { x: 0, y: 0, z: 0, w: 0 };
  const x = viewport.left / canvasCssSize.width;
  const width = viewport.width / canvasCssSize.width;
  const height = viewport.height / canvasCssSize.height;
  // ① 左上原点 → 左下原点
  const y = 1 - (viewport.top + viewport.height) / canvasCssSize.height;
  return { x: clamp01(x), y: clamp01(y), z: clamp01(width), w: clamp01(height) };
}

/** 换算前的像素视口是否完全落在画布内（诊断用：钳制会掩盖布局 bug）。 */
export function isRectInBounds(viewport: PixelViewport, canvasCssSize: SizeLike, tolerance = 1): boolean {
  return viewport.left >= -tolerance
    && viewport.top >= -tolerance
    && viewport.left + viewport.width <= canvasCssSize.width + tolerance
    && viewport.top + viewport.height <= canvasCssSize.height + tolerance;
}

export interface PaneClearFlags {
  clearColorBuffer: boolean;
  clearDepthBuffer: boolean;
}

/**
 * 每格相机的清屏标志。
 *
 * `clearDepthBuffer` **恒为 true**——这是硬约束，不是默认值（见文件头 ④）。
 * 颜色默认也逐格清（让每格有确定的背景色）；若想只由全局清一次颜色，传
 * `{ clearColorPerPane: false }`，但**不要**因此关掉深度。
 */
export function paneClearFlags(_index: number, options: { clearColorPerPane?: boolean } = {}): PaneClearFlags {
  return { clearColorBuffer: options.clearColorPerPane ?? true, clearDepthBuffer: true };
}

/**
 * 窗格相机的 `priority`。PlayCanvas 按相机优先级排序渲染，
 * 逐窗格递增即得到稳定的窗格顺序（与 DOM 顺序一致）。
 */
export function panePriority(index: number): number {
  return index;
}
