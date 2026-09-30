import type { AppBase } from "playcanvas";

/**
 * PlayCanvas 应用的装配：把**已经建好的** graphicsDevice 接到一个 `AppBase` 上。
 *
 * 刻意**不传** `AppOptions.componentSystems` / `resourceHandlers` 白名单：
 * 白名单能显著瘦身（SuperSplat 的 `src/pc-app.ts:90-157` 只留了自己用到的十来个），
 * 但那是**打包体积优化**，前提是确知需要哪些系统。Phase 1 先用引擎默认集合把链路跑通，
 * 白名单留到 Phase 6 按实际用到的系统收窄——过早收窄会以"某个组件静默不工作"的形式炸。
 *
 * 这里也不注册 SPZ parser：它需要额外的 ZSTD wasm，属于 splat 那一步（Phase 4），
 * 见 `PLAYCANVAS_MIGRATION.md` §二.3。
 */

export interface AppHandle {
  app: AppBase;
  /** 停掉引擎自己的 rAF 循环。2.22.6 **没有** `app.stop()`，只能取消它持有的 rAF 句柄。 */
  stopLoop(): void;
}

export interface CreateAppOptions {
  /** 画布填充模式。默认铺满窗口并由引擎自动改分辨率（等价 `FILLMODE_FILL_WINDOW` + `RESOLUTION_AUTO`）。 */
  fillWindow?: boolean;
  /** 测试注入点。 */
  createApp?: (canvas: HTMLCanvasElement, device: unknown) => Promise<AppBase>;
  /** 测试注入点：订阅窗口 resize。 */
  addResizeListener?: (handler: () => void) => () => void;
}

/**
 * 必需注册的组件系统。
 *
 * ⚠️ **这不是优化，是必需的**：`AppOptions` 的 `componentSystems` 默认是**空数组**
 * （`app-options.js:16-17`），而 `AppBase.init` 只注册你列进来的
 * （`app-base.js:228` 的 `componentSystems.forEach`）。漏了某个系统的后果是
 * **静默失败**——`entity.addComponent("camera", ...)` 什么也不做、`entity.camera` 是 undefined，
 * 没有任何报错（本机实测踩到过）。
 *
 * 这也是为什么引擎自带的 `AppBase` 示例（`simple-spz` / `editor`）都要显式列出这一串，
 * 而 `Application`（不是 `AppBase`）才自带默认集合。用 `Application` 会拉进整套编辑器外壳，
 * 与本项目"只注册用到的"取向不符，所以这里继续用 `AppBase` + 显式清单。
 */
const REQUIRED_SYSTEMS = [
  "render", "camera", "light", "script", "anim", "gsplat",
  "collision", "rigidbody", "element", "screen", "sprite", "layoutgroup", "layoutchild",
] as const;

async function defaultCreateApp(canvas: HTMLCanvasElement, device: unknown): Promise<AppBase> {
  const pc = await import("playcanvas");
  const { AppBase, AppOptions, Mouse, TouchDevice, FILLMODE_FILL_WINDOW, RESOLUTION_AUTO } = pc;
  const app = new AppBase(canvas);
  const options = new AppOptions();
  options.graphicsDevice = device as never;
  // 指针/触摸输入：PlayCanvas 自己接，不经过 React 的合成事件。
  options.mouse = new Mouse(document.body);
  options.touch = new TouchDevice(document.body);
  options.componentSystems = [
    pc.RenderComponentSystem, pc.CameraComponentSystem, pc.LightComponentSystem, pc.ScriptComponentSystem,
    pc.AnimComponentSystem, pc.GSplatComponentSystem,
    pc.CollisionComponentSystem, pc.RigidBodyComponentSystem,
    pc.ElementComponentSystem, pc.ScreenComponentSystem, pc.SpriteComponentSystem,
    pc.LayoutGroupComponentSystem, pc.LayoutChildComponentSystem,
  ];
  options.resourceHandlers = [
    pc.TextureHandler, pc.ContainerHandler, pc.ScriptHandler, pc.GSplatHandler,
    pc.AnimClipHandler, pc.AnimStateGraphHandler, pc.CubemapHandler, pc.RenderHandler,
    pc.MaterialHandler, pc.SpriteHandler, pc.TextureAtlasHandler, pc.FontHandler,
  ];
  app.init(options);

  // 把"漏注册系统"这类静默失败变响：缺谁就明确报谁，而不是等到某个组件诡异地为空。
  const systems = app.systems as unknown as Record<string, unknown>;
  const missing = REQUIRED_SYSTEMS.filter((name) => !systems[name]);
  if (missing.length) {
    app.destroy();
    throw new Error(`PlayCanvas app is missing component systems: ${missing.join(", ")}`);
  }
  app.setCanvasFillMode(FILLMODE_FILL_WINDOW);
  app.setCanvasResolution(RESOLUTION_AUTO);
  return app;
}

export async function createPlayCanvasApp(canvas: HTMLCanvasElement, device: unknown, options: CreateAppOptions = {}): Promise<AppHandle> {
  const app = await (options.createApp ?? defaultCreateApp)(canvas, device);
  const detachResize = (options.addResizeListener ?? defaultAddResizeListener)(() => app.resizeCanvas());
  return {
    app,
    stopLoop() {
      detachResize();
      /*
        `app.start()` 会无条件排一个 rAF，而 2.22.6 的 `AppBase` **没有 `stop()`**。
        但 `frameRequestId` 是公开可写字段，取消它即可停掉循环（本机核实过：取消后 60ms 内
        0 次新 rAF 请求、`app.frame` 冻结）。置 null 避免重复取消。
      */
      const holder = app as AppBase & { frameRequestId?: number | null };
      if (holder.frameRequestId != null) {
        cancelAnimationFrame(holder.frameRequestId);
        holder.frameRequestId = null;
      }
    },
  };
}

function defaultAddResizeListener(handler: () => void): () => void {
  window.addEventListener("resize", handler);
  return () => window.removeEventListener("resize", handler);
}
