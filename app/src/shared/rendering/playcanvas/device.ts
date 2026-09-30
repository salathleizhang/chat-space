import { initializeRenderer } from "../initializeRenderer";

/**
 * WebGPU-only 的设备创建。
 *
 * **为什么不用 `createGraphicsDevice()`**（本机核实，2.22.6 与 2.23.0-beta.24 都一样）：
 * 它无条件把 `WEBGL2` 与 `NULL` 追加进 `deviceTypes`，并**就地修改调用方传入的数组**——
 *
 * ```js
 * // playcanvas/build/playcanvas/src/platform/graphics/graphics-device-create.js:6-12
 * const deviceTypes = options.deviceTypes ?? [];
 * if (!deviceTypes.includes(DEVICETYPE_WEBGL2)) { deviceTypes.push(DEVICETYPE_WEBGL2); }
 * if (!deviceTypes.includes(DEVICETYPE_NULL))   { deviceTypes.push(DEVICETYPE_NULL); }
 * ```
 *
 * 也就是说 `createGraphicsDevice(canvas, { deviceTypes: ['webgpu'] })` 在 WebGPU 不可用时会
 * **静默返回一个 WebGL2 设备**。本项目的硬约束是"WebGPU-only、没有 WebGL 回退"，所以必须
 * 直接构造 `WebgpuGraphicsDevice`：这条路径没有任何回退。
 *
 * ⚠️ 顺带一处对参考实现的纠正：`playcanvas/supersplat` 的 `src/main.ts:128` 注释写着
 * "the graphics device requests webgpu only"，但它就是这么调的，**且全仓库没有任何 `isWebGPU` 断言**
 * （`src/index.ts:22` 只用 `navigator.gpu` 是否存在决定提示文案——那是前置探测，不是设备保证）。
 * 所以这条路**不能照抄**。
 *
 * 另外三条本机核实的失败分支，都要变成能给人看的信息（引擎自己给的不清楚）：
 *  ① `!navigator.gpu` → 引擎 `throw`，信息尚可；
 *  ② `requestAdapter` 返回 null → 引擎会在 `this.gpuAdapter.features` 上 **TypeError**；
 *  ③ adapter 是 Imagination PowerVR（`info.vendor === 'img-tec'`）→ `createDevice()` **返回 null 而不抛**。
 */

export type PowerPreference = "high-performance" | "low-power" | "default";

export interface WebGPUDeviceOptions {
  /**
   * 画布是否保留 alpha 通道。默认 **false（不透明）**：`alpha: true` 会让 Chrome 用
   * `alphaMode: 'premultiplied'` 配置交换链，合成器每帧都要把画布混合到页面上，而这份开销
   * **不进任何 GPU 计时**（`AGENTS.md` §二 记录过这条）。代价是页面背景不再透出——
   * 天空盒加载失败时看到的是清屏色而不是页面底色，属已知取舍。
   */
  alpha?: boolean;
  /** 默认 **false**。GSL 文档与 PlayCanvas 自己都说明 MSAA 对 splat 无收益且显著更贵。 */
  antialias?: boolean;
  /**
   * 默认 `'high-performance'`。注意引擎源码里 `GraphicsDevice` 的默认值**本来就是**它
   * （`graphics-device.js:734`），而 `graphics-device-create.js` 的 JSDoc 却写 `'default'`
   * ——文档与实现不一致，以实现为准。这里显式传，把意图写下来。
   */
  powerPreference?: PowerPreference;
  /** 传给 `initializeRenderer` 的初始化超时，默认沿用它的 15s。 */
  timeoutMs?: number;
  /** 测试注入点：返回一个待初始化的设备。默认动态 import `playcanvas` 并 `new WebgpuGraphicsDevice`。 */
  createDevice?: (canvas: HTMLCanvasElement, options: DeviceParams) => DeviceLike;
}

/** 实际交给引擎构造函数的参数，单独成型以便单测断言"确实是 WebGPU-only"。 */
export interface DeviceParams {
  alpha: boolean;
  antialias: boolean;
  depth: boolean;
  stencil: boolean;
  powerPreference: PowerPreference;
  /** 装了 WebXR 的 Chrome 默认会设为 true，可能挑到"XR 友好"而非最强的适配器。显式关掉。 */
  xrCompatible: boolean;
}

export interface DeviceLike {
  readonly isWebGPU: boolean;
  readonly isWebGL2: boolean;
  readonly samples: number;
  initWebGpu(glslangUrl?: string, twgslUrl?: string): Promise<unknown>;
  destroy(): void;
  /**
   * `EventHandler` 的订阅接口，用于 `devicelost` / `devicerestored`。
   *
   * **与 three 侧的关键差别**：PlayCanvas **自己会恢复**设备——
   * `webgpu-graphics-device.js:333-343` 的 `handleDeviceLost` 是
   * `fire('devicelost')` → `await this.createDevice()` → `fire('devicerestored')`，
   * 并且 `info.reason === 'destroyed'`（主动销毁）被忽略。所以应用侧**不该**在 `devicelost` 时
   * 直接判死，而要把它当成"可能马上自愈"的状态如实暴露给 UI；硬失败面板留给真正没恢复的情况
   * （例如引擎自己的 `createDevice()` 抛错，那样永远等不到 `devicerestored`）。
   */
  on?(event: string, handler: (...args: unknown[]) => void): void;
  off?(event: string, handler: (...args: unknown[]) => void): void;
}

/** 适配器身份，只用于诊断展示。 */
export interface AdapterIdentity {
  vendor: string;
  architecture: string;
  device: string;
  description: string;
}

/**
 * 读出适配器身份。`gpuAdapter` 在 d.ts 里标了 `private`（运行时存在），所以这里必須类型断言。
 * 只用它做展示，**不要**拿它做功能分支——功能分支走设备自己的 `supports*` 标志。
 */
export function readAdapterIdentity(device: unknown): AdapterIdentity | null {
  const adapter = (device as { gpuAdapter?: { info?: Partial<AdapterIdentity> } } | null)?.gpuAdapter;
  const info = adapter?.info;
  if (!info) return null;
  return {
    vendor: info.vendor ?? "",
    architecture: info.architecture ?? "",
    device: info.device ?? "",
    description: info.description ?? "",
  };
}

export function deviceParams(options: WebGPUDeviceOptions = {}): DeviceParams {
  return {
    alpha: options.alpha ?? false,
    antialias: options.antialias ?? false,
    depth: true,
    // 本项目的渲染路径不用模板缓冲（三栈侧同样未启用），少一个附件。
    stencil: false,
    powerPreference: options.powerPreference ?? "high-performance",
    xrCompatible: false,
  };
}

async function defaultCreateDevice(canvas: HTMLCanvasElement, params: DeviceParams): Promise<DeviceLike> {
  // 动态导入：把 3.6MB 的引擎挡在首屏之外（与仓库既有的懒加载风格一致），
  // 也让单测可以在不加载引擎的情况下覆盖全部分支。
  const { WebgpuGraphicsDevice } = await import("playcanvas");
  return new WebgpuGraphicsDevice(canvas, params) as unknown as DeviceLike;
}

/**
 * 创建一个**保证是 WebGPU** 的图形设备。失败时抛出可以直接展示给用户的错误。
 *
 * 复用 `initializeRenderer`：它已经解决了"adapter/device 请求不可取消、超时后仍要保留所有权
 * 到初始化真正结束才释放"这套语义（有回归测试）。这里只负责"造 WebGPU 设备 + 校验它真的是"。
 */
export async function createWebGPUDevice(
  canvas: HTMLCanvasElement,
  options: WebGPUDeviceOptions = {},
): Promise<DeviceLike> {
  if (typeof navigator === "undefined" || !("gpu" in navigator)) {
    throw new Error("WebGPU is unavailable. Use a supported browser over HTTPS or localhost.");
  }
  const params = deviceParams(options);
  const device = await (options.createDevice ?? defaultCreateDevice)(canvas, params);

  await initializeRenderer(
    {
      init: async () => {
        // 两个 URL 都不传：引擎内置 shader 已是 WGSL，不需要 GLSL→WGSL 转译器
        // （`webgpu-graphics-device.js:182` 只在两者都为真时才去加载）。
        const result = await device.initWebGpu();
        // adapter 拿不到、或 adapter 是 Imagination PowerVR 时，引擎**返回 null 而不抛**。
        if (!result) throw new Error("WebGPU adapter is unavailable on this device or driver.");
        return result;
      },
      // 引擎的 destroy() 是同步的，这里包成 Promise 以符合 initializeRenderer 的契约。
      dispose: async () => { device.destroy(); },
    },
    options.timeoutMs,
  );

  // 硬断言：拿到非 WebGPU 设备就立刻失败，绝不带着一个 WebGL 设备继续往下跑。
  if (device.isWebGPU !== true || device.isWebGL2 !== false) {
    device.destroy();
    throw new Error("A WebGPU graphics device was required, but the engine produced a different backend.");
  }
  return device;
}
