import { expect, test, mock } from "bun:test";
import { RendererSession } from "./session";
import type { DeviceLike } from "./device";
import type { AppHandle } from "./app";

const canvas = () => ({ width: 100, height: 100 }) as unknown as HTMLCanvasElement;
const flush = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); };
const settle = async (ms = 5) => { await new Promise((r) => setTimeout(r, ms)); await flush(); };

interface Counters { devices: number; apps: number; stops: number; appDestroys: number; deviceDestroys: number }

function harness() {
  const counters: Counters = { devices: 0, apps: 0, stops: 0, appDestroys: 0, deviceDestroys: 0 };
  const device = (): DeviceLike => ({
    isWebGPU: true, isWebGL2: false, samples: 1,
    initWebGpu: async () => null,
    destroy: () => { counters.deviceDestroys += 1; },
  });
  const handle = (): AppHandle => ({
    app: { destroy: () => { counters.appDestroys += 1; } } as unknown as AppHandle["app"],
    stopLoop: () => { counters.stops += 1; },
  });
  return {
    counters,
    factories: {
      createDevice: mock(async (_canvas: HTMLCanvasElement, _options: unknown) => { counters.devices += 1; return device(); }),
      createApp: mock(async (_canvas: HTMLCanvasElement, _device: unknown, _app: unknown) => { counters.apps += 1; return handle(); }),
    },
  };
}

const session = (h: ReturnType<typeof harness>, teardownDelayMs = 20) =>
  new RendererSession({ canvas: canvas(), teardownDelayMs, factories: h.factories });

test("建立会话后状态为 ready，并暴露命令式入口", async () => {
  const h = harness();
  const s = session(h);
  s.start();
  expect(s.getSnapshot().status).toBe("loading");
  await settle();
  const snap = s.getSnapshot();
  expect(snap.status).toBe("ready");
  expect(snap.error).toBeNull();
  expect(snap.device).not.toBeNull();
  expect(snap.app).not.toBeNull();
  expect(h.counters).toMatchObject({ devices: 1, apps: 1 });
  await s.dispose();
});

test("重复 start 不会建第二个设备", async () => {
  const h = harness();
  const s = session(h);
  s.start(); s.start(); s.start();
  await settle();
  expect(h.counters.devices).toBe(1);
  await s.dispose();
});

test("StrictMode：卸载后立刻重新认领，不释放也不重建", async () => {
  const h = harness();
  const s = session(h);
  s.start();
  await settle();
  const device = s.getSnapshot().device;

  s.release();            // React 19 StrictMode 的模拟卸载
  await settle(2);        // 仍在 teardownDelayMs 窗口内
  s.claim();              // 立刻重挂

  await settle(40);       // 越过窗口
  expect(h.counters).toMatchObject({ devices: 1, apps: 1, stops: 0, appDestroys: 0, deviceDestroys: 0 });
  expect(s.getSnapshot().status).toBe("ready");
  expect(s.getSnapshot().device).toBe(device);
  await s.dispose();
});

test("真正卸载（窗口期过后）恰好释放一次", async () => {
  const h = harness();
  const s = session(h);
  s.start();
  await settle();
  s.release();
  await settle(40);
  expect(h.counters).toMatchObject({ stops: 1, appDestroys: 1, deviceDestroys: 1 });
  expect(s.getSnapshot().status).toBe("idle");
  // 再 release / dispose 不应重复释放
  s.release();
  await s.dispose();
  await settle(10);
  expect(h.counters).toMatchObject({ stops: 1, appDestroys: 1, deviceDestroys: 1 });
});

test("初始化还没结束就被释放：落地后立刻收掉，不泄漏", async () => {
  let releaseDevice!: () => void;
  const counters = { stops: 0, appDestroys: 0, deviceDestroys: 0 };
  const s = new RendererSession({
    canvas: canvas(),
    teardownDelayMs: 1,
    factories: {
      createDevice: () => new Promise<DeviceLike>((resolve) => {
        releaseDevice = () => resolve({
          isWebGPU: true, isWebGL2: false, samples: 1,
          initWebGpu: async () => null,
          destroy: () => { counters.deviceDestroys += 1; },
        });
      }),
      createApp: async () => ({ app: { destroy: () => { counters.appDestroys += 1; } } as unknown as AppHandle["app"],
        stopLoop: () => { counters.stops += 1; } }),
    },
  });
  s.start();
  await settle();
  s.release();                 // 仍在 loading：标记待释放
  expect(s.getSnapshot().status).toBe("loading");
  releaseDevice();             // 晚到的初始化
  await settle(20);
  expect(counters).toMatchObject({ stops: 1, appDestroys: 1, deviceDestroys: 1 });
  await s.dispose();
  await settle(10);
  expect(counters).toMatchObject({ stops: 1, appDestroys: 1, deviceDestroys: 1 });
});

test("初始化失败进入 error 状态并带上原始错误", async () => {
  const s = new RendererSession({
    canvas: canvas(),
    factories: {
      createDevice: async () => { throw new Error("WebGPU is unavailable."); },
      createApp: mock(async () => { throw new Error("should not be called"); }),
    },
  });
  s.start();
  await settle();
  expect(s.getSnapshot().status).toBe("error");
  expect(s.getSnapshot().error?.message).toBe("WebGPU is unavailable.");
  await s.dispose();
});

test("retry 会重新建立会话（旧的已释放）", async () => {
  const h = harness();
  let attempt = 0;
  const s = new RendererSession({
    canvas: canvas(),
    teardownDelayMs: 5,
    factories: {
      createDevice: async () => { attempt += 1; if (attempt === 1) throw new Error("first try failed"); return h.factories.createDevice(canvas(), {}); },
      createApp: h.factories.createApp,
    },
  });
  s.start();
  await settle();
  expect(s.getSnapshot().status).toBe("error");
  s.retry();
  await settle();
  expect(s.getSnapshot().status).toBe("ready");
  expect(attempt).toBe(2);
  await s.dispose();
});

test("设备已建好但应用装配失败时，设备也要被释放（不泄漏）", async () => {
  let deviceDestroys = 0;
  const s = new RendererSession({
    canvas: canvas(),
    factories: {
      createDevice: async () => ({
        isWebGPU: true, isWebGL2: false, samples: 1,
        initWebGpu: async () => null,
        destroy: () => { deviceDestroys += 1; },
      }),
      createApp: async () => { throw new Error("app wiring failed"); },
    },
  });
  s.start();
  await settle();
  expect(s.getSnapshot().status).toBe("error");
  expect(s.getSnapshot().error?.message).toBe("app wiring failed");
  expect(deviceDestroys).toBe(1);
  await s.dispose();
  await settle(10);
  expect(deviceDestroys).toBe(1);
});

/** 可手动触发 devicelost / devicerestored 的假设备（PlayCanvas 的设备是 EventHandler）。 */
function eventfulDevice() {
  const handlers = new Map<string, Set<(...args: unknown[]) => void>>();
  let destroys = 0;
  const device: DeviceLike = {
    isWebGPU: true, isWebGL2: false, samples: 1,
    initWebGpu: async () => null,
    destroy: () => { destroys += 1; },
    on: (event, handler) => { (handlers.get(event) ?? handlers.set(event, new Set()).get(event)!).add(handler); },
    off: (event, handler) => { handlers.get(event)?.delete(handler); },
  };
  const fire = (event: string) => { for (const h of handlers.get(event) ?? []) h(); };
  return { device, fire, counts: () => ({ destroys, subscribers: [...handlers.values()].reduce((n, s) => n + s.size, 0) }) };
}

test("devicelost 只置位不判死，devicerestored 由引擎自愈后清除", async () => {
  const e = eventfulDevice();
  const s = new RendererSession({
    canvas: canvas(), teardownDelayMs: 5,
    factories: { createDevice: async () => e.device, createApp: async () => ({ app: { destroy: () => {} } as unknown as AppHandle["app"], stopLoop: () => {} }) },
  });
  s.start();
  await settle();
  expect(s.getSnapshot()).toMatchObject({ status: "ready", deviceLost: false });

  e.fire("devicelost");
  // 关键：引擎会自己重建设备，所以这里**不能**变成 error、也不能丢掉会话
  expect(s.getSnapshot()).toMatchObject({ status: "ready", deviceLost: true });
  expect(s.getSnapshot().app).not.toBeNull();

  e.fire("devicerestored");
  expect(s.getSnapshot()).toMatchObject({ status: "ready", deviceLost: false });
  await s.dispose();
});

test("释放时退订设备事件（否则销毁后回调仍持有会话）", async () => {
  const e = eventfulDevice();
  const s = new RendererSession({
    canvas: canvas(), teardownDelayMs: 1,
    factories: { createDevice: async () => e.device, createApp: async () => ({ app: { destroy: () => {} } as unknown as AppHandle["app"], stopLoop: () => {} }) },
  });
  s.start();
  await settle();
  expect(e.counts().subscribers).toBe(2);
  await s.dispose();
  expect(e.counts().subscribers).toBe(0);
  expect(e.counts().destroys).toBe(1);
  e.fire("devicelost"); // 退订后不应再影响已释放的会话
  expect(s.getSnapshot()).toMatchObject({ status: "idle", deviceLost: false });
});

test("设备丢失后 retry 会先释放旧的再重建（不泄漏）", async () => {
  const first = eventfulDevice();
  const second = eventfulDevice();
  let made = 0;
  const s = new RendererSession({
    canvas: canvas(), teardownDelayMs: 5,
    factories: {
      createDevice: async () => (++made === 1 ? first.device : second.device),
      createApp: async () => ({ app: { destroy: () => {} } as unknown as AppHandle["app"], stopLoop: () => {} }),
    },
  });
  s.start();
  await settle();
  first.fire("devicelost");
  s.retry();
  await settle();
  expect(s.getSnapshot()).toMatchObject({ status: "ready", deviceLost: false });
  expect(made).toBe(2);
  // 旧设备必须已经被销毁，否则就是"新设备建好、旧设备还挂着"
  expect(first.counts().destroys).toBe(1);
  expect(first.counts().subscribers).toBe(0);
  await s.dispose();
  expect(second.counts().destroys).toBe(1);
});
