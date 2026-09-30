import { expect, test, mock } from "bun:test";
import { createWebGPUDevice, deviceParams, readAdapterIdentity, type DeviceLike } from "./device";

/**
 * 这些测试只覆盖"引导层自己的逻辑"：WebGPU-only 的参数、三条失败分支、以及**拒绝回退**的断言。
 * 真正的 GPU 行为只能在可见窗口里验证（见 PLAYCANVAS_MIGRATION.md §三）。
 */

const flush = async () => { await Promise.resolve(); await Promise.resolve(); await Promise.resolve(); };

/** 在一段代码执行期间把 `navigator.gpu` 设成给定值（或删掉）。 */
async function withGpu<T>(value: unknown, run: () => Promise<T>): Promise<T> {
  const target = globalThis.navigator as unknown as Record<string, unknown>;
  const had = "gpu" in target;
  const original = target.gpu;
  Object.defineProperty(target, "gpu", { value, configurable: true, writable: true });
  try {
    return await run();
  } finally {
    if (had) Object.defineProperty(target, "gpu", { value: original, configurable: true, writable: true });
    else delete target.gpu;
  }
}

const canvas = () => ({ width: 100, height: 100 }) as unknown as HTMLCanvasElement;

type FakeDevice = DeviceLike & { initCalls: number; destroyed: number };

function fakeDevice(overrides: Partial<DeviceLike> = {}): FakeDevice {
  // 显式标注类型：否则 `initWebGpu` 返回 `device` 会形成自引用推断环（TS7022/7023）。
  const device: FakeDevice = {
    isWebGPU: true,
    isWebGL2: false,
    samples: 1,
    initCalls: 0,
    destroyed: 0,
    async initWebGpu(): Promise<unknown> { device.initCalls += 1; return device; },
    destroy() { device.destroyed += 1; },
    ...overrides,
  };
  return device;
}

test("默认参数是 WebGPU-only 且与既有画质决策一致", () => {
  expect(deviceParams()).toEqual({
    alpha: false,
    antialias: false,
    depth: true,
    stencil: false,
    powerPreference: "high-performance",
    // 装了 WebXR 的 Chrome 默认会设 true，可能挑到"XR 友好"而非最强的适配器
    xrCompatible: false,
  });
});

test("把 WebGPU-only 的参数原样交给引擎工厂，并返回已初始化的设备", async () => {
  await withGpu({}, async () => {
    const seen: unknown[] = [];
    const device = fakeDevice();
    const result = await createWebGPUDevice(canvas(), {
      createDevice: (_canvas, params) => { seen.push(params); return device; },
    });
    expect(seen).toEqual([deviceParams()]);
    expect(device.initCalls).toBe(1);
    expect(device.destroyed).toBe(0);
    expect(result).toBe(device);
  });
});

test("浏览器没有 WebGPU 时给出可展示的错误，且根本不构造设备", async () => {
  const target = globalThis.navigator as unknown as Record<string, unknown>;
  const had = "gpu" in target;
  const original = target.gpu;
  delete target.gpu;
  try {
    const createDevice = mock(() => fakeDevice());
    await expect(createWebGPUDevice(canvas(), { createDevice })).rejects.toThrow(/WebGPU is unavailable/);
    expect(createDevice).not.toHaveBeenCalled();
  } finally {
    if (had) Object.defineProperty(target, "gpu", { value: original, configurable: true, writable: true });
  }
});

test("引擎返回 null（拿不到 adapter / Imagination PowerVR）时失败并释放设备", async () => {
  await withGpu({}, async () => {
    const device = fakeDevice({ initWebGpu: async () => null });
    await expect(createWebGPUDevice(canvas(), { createDevice: () => device })).rejects.toThrow(/adapter is unavailable/);
    await flush();
    expect(device.destroyed).toBe(1);
  });
});

test("引擎初始化抛错（例如 adapter 为 null 触发的 TypeError）时原样上抛并释放设备", async () => {
  await withGpu({}, async () => {
    const device = fakeDevice({ initWebGpu: async () => { throw new TypeError("Cannot read properties of null (reading 'features')"); } });
    await expect(createWebGPUDevice(canvas(), { createDevice: () => device })).rejects.toThrow(/reading 'features'/);
    await flush();
    expect(device.destroyed).toBe(1);
  });
});

test("拿到非 WebGPU 设备时拒绝继续（没有 WebGL 回退），并销毁它", async () => {
  await withGpu({}, async () => {
    const device = fakeDevice({ isWebGPU: false, isWebGL2: true });
    await expect(createWebGPUDevice(canvas(), { createDevice: () => device })).rejects.toThrow(/different backend/);
    // 这条断言是这个文件存在的理由：宁可失败，也不能带着 WebGL 设备往下跑
    expect(device.destroyed).toBe(1);
  });
});

test("适配器身份从私有字段读出（仅用于展示），取不到时返回 null", () => {
  expect(readAdapterIdentity({ gpuAdapter: { info: { vendor: "apple", architecture: "metal-3" } } }))
    .toEqual({ vendor: "apple", architecture: "metal-3", device: "", description: "" });
  expect(readAdapterIdentity({})).toBeNull();
  expect(readAdapterIdentity(null)).toBeNull();
});
