import { createWebGPUDevice, type DeviceLike, type WebGPUDeviceOptions } from "./device";
import { createPlayCanvasApp, type AppHandle, type CreateAppOptions } from "./app";

/**
 * 渲染会话的**租约与生命周期**。刻意不依赖 React —— 这里全是容易出错的状态机
 * （StrictMode 的挂载→卸载→再挂载、卸载后才完成的异步初始化、设备丢失自愈、重试、
 * 恰好一次的清理），写成纯对象才能被单测真正覆盖；React 侧只做一层薄适配。
 *
 * 四条不变式：
 *  ① **恰好一次清理**：无论走卸载、重试还是初始化失败，`stopLoop` / `app.destroy` /
 *     `device.destroy` 每样都只发生一次。释放路径只有 `teardownResources()` 一条。
 *  ② **StrictMode 的模拟卸载不真的释放**：卸载时只**预约**释放；窗口期内被重新认领就取消。
 *     不这样做，React 19 的开发模式会把设备连建两次、并把第一次的设备泄漏掉。
 *  ③ **晚到的初始化也要收尾**：如果初始化还没结束就被释放/取代，等它落地后立刻释放。
 *  ④ **设备丢失不是终态**：PlayCanvas 自己会重建设备（`webgpu-graphics-device.js:333-343`），
 *     这里只如实暴露 `deviceLost`，自愈由引擎完成。
 */

export type SessionStatus = "idle" | "loading" | "ready" | "error";

export interface SessionSnapshot {
  status: SessionStatus;
  error: Error | null;
  /** 会话建立后才有值；命令式访问引擎的唯一入口。 */
  device: DeviceLike | null;
  app: AppHandle["app"] | null;
  /**
   * 设备处于丢失状态。**不是终态**：引擎会重建设备并发 `devicerestored`，所以 UI 应当把它
   * 当作"可能自愈中"的提示而不是失败面板。真正的失败是收不到 `devicerestored`
   * （引擎恢复过程抛错）——那时 `retry()` 仍然可用。
   */
  deviceLost: boolean;
}

export interface SessionFactories {
  createDevice: (canvas: HTMLCanvasElement, options: WebGPUDeviceOptions) => Promise<DeviceLike>;
  createApp: (canvas: HTMLCanvasElement, device: unknown, options: CreateAppOptions) => Promise<AppHandle>;
}

export interface SessionOptions {
  canvas: HTMLCanvasElement;
  device?: WebGPUDeviceOptions;
  app?: CreateAppOptions;
  /** 卸载后延迟释放的窗口。默认 600ms：覆盖 React 19 StrictMode 的"卸载后立刻重挂"。 */
  teardownDelayMs?: number;
  factories?: Partial<SessionFactories>;
}

const IDLE: SessionSnapshot = { status: "idle", error: null, device: null, app: null, deviceLost: false };
const DEFAULTS: SessionFactories = { createDevice: createWebGPUDevice, createApp: createPlayCanvasApp };

export class RendererSession {
  private snapshot: SessionSnapshot = IDLE;
  private readonly listeners = new Set<() => void>();
  private readonly factories: SessionFactories;
  private teardownTimer: ReturnType<typeof setTimeout> | undefined;
  /** 本次建立尝试的世代号：晚到的完成只对得上自己那一代才生效。 */
  private generation = 0;
  private disposed = false;
  private tornDown = false;
  private pendingRelease = false;
  private resources: { device: DeviceLike; app: AppHandle } | null = null;
  private deviceLost = false;
  private deviceSubscriptions: (() => void)[] = [];

  constructor(private readonly options: SessionOptions) {
    this.factories = { ...DEFAULTS, ...options.factories };
  }

  subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): SessionSnapshot => this.snapshot;

  /** 开始（或重新开始）建立会话。重复调用是幂等的：正在加载或已就绪时不重复建。 */
  start(): void {
    if (this.disposed || this.snapshot.status === "loading" || this.snapshot.status === "ready") return;
    const generation = ++this.generation;
    this.emit({ ...IDLE, status: "loading" });

    void (async () => {
      let device: DeviceLike | undefined;
      let app: AppHandle | undefined;
      try {
        device = await this.factories.createDevice(this.options.canvas, this.options.device ?? {});
        app = await this.factories.createApp(this.options.canvas, device, this.options.app ?? {});
      } catch (cause) {
        // 设备可能已经建好、而应用装配失败：**必须显式释放**，否则会留下一个没人持有的 GPU 设备
        // （StrictMode 下会累积）。清理失败也不能掩盖原始错误。
        try { app?.stopLoop(); app?.app.destroy(); } catch { /* 忽略 */ }
        try { device?.destroy(); } catch { /* 忽略 */ }
        if (generation === this.generation) {
          this.emit({ ...IDLE, status: "error", error: cause instanceof Error ? cause : new Error(String(cause)) });
        }
        return;
      }
      if (generation !== this.generation) {
        // 这一代已被取代（重试或释放）：建出来的东西没人要，立刻收掉。
        app.stopLoop();
        app.app.destroy();
        device.destroy();
        return;
      }
      this.resources = { device, app };
      this.subscribeDeviceEvents(device);
      this.deviceLost = false;
      this.emit({ status: "ready", error: null, device, app: app.app, deviceLost: false });
      // 初始化期间收到过释放请求：现在就补上。
      if (this.pendingRelease) this.release();
    })();
  }

  /** 新一次挂载认领租约：取消尚未到期的释放。 */
  claim(): void {
    this.pendingRelease = false;
    if (this.teardownTimer !== undefined) {
      clearTimeout(this.teardownTimer);
      this.teardownTimer = undefined;
    }
    this.start();
  }

  /** 卸载：**预约**释放。窗口期内被 `claim()` 认领就不释放。 */
  release(): void {
    if (this.disposed) return;
    if (this.snapshot.status === "loading") {
      // 初始化还没落地：标记待释放，等它完成后由 start() 的收尾补上。
      this.pendingRelease = true;
      return;
    }
    if (this.teardownTimer !== undefined) return;
    const delay = this.options.teardownDelayMs ?? 600;
    this.teardownTimer = setTimeout(() => { this.teardownTimer = undefined; void this.dispose(); }, delay);
  }

  /** 立即释放整个会话。幂等：多次调用只真正执行一次。 */
  async dispose(): Promise<void> {
    if (this.tornDown) return;
    this.tornDown = true;
    this.disposed = true;
    if (this.teardownTimer !== undefined) { clearTimeout(this.teardownTimer); this.teardownTimer = undefined; }
    this.generation += 1; // 让晚到的初始化失配并被自己收掉
    this.teardownResources();
    this.emit(IDLE);
  }

  /**
   * 用户点重试：**先释放旧的再重建**。释放走同一条 `teardownResources()`，
   * 所以不存在"新设备建好了、旧设备还挂着"这种泄漏。
   */
  retry(): void {
    if (this.disposed) return;
    if (this.snapshot.status !== "error" && !this.deviceLost) return;
    this.generation += 1; // 让在飞的初始化失配
    this.teardownResources();
    this.emit(IDLE);
    this.start();
  }

  /** 唯一的释放路径。幂等地拆掉设备、应用与订阅。 */
  private teardownResources(): void {
    for (const unsubscribe of this.deviceSubscriptions) unsubscribe();
    this.deviceSubscriptions = [];
    const resources = this.resources;
    this.resources = null;
    this.deviceLost = false;
    if (!resources) return;
    resources.app.stopLoop();
    resources.app.app.destroy();
    resources.device.destroy();
  }

  /**
   * 订阅设备丢失/恢复。引擎自己重建设备，这里只如实反映状态。
   * 必须在 teardown 时退订，否则设备销毁后回调仍持有会话（StrictMode 下会累积）。
   */
  private subscribeDeviceEvents(device: DeviceLike): void {
    const onLost = () => { this.deviceLost = true; this.republish(); };
    const onRestored = () => { this.deviceLost = false; this.republish(); };
    device.on?.("devicelost", onLost);
    device.on?.("devicerestored", onRestored);
    this.deviceSubscriptions.push(() => {
      device.off?.("devicelost", onLost);
      device.off?.("devicerestored", onRestored);
    });
  }

  /** 只更新 `deviceLost`，其余字段不动（引擎恢复期间会话本身仍然有效）。 */
  private republish(): void {
    this.emit({ ...this.snapshot, deviceLost: this.deviceLost });
  }

  private emit(next: SessionSnapshot): void {
    this.snapshot = next;
    for (const listener of this.listeners) listener();
  }
}
