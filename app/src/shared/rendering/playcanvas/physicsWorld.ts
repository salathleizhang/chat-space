/**
 * PlayCanvas 物理（Ammo）的引导。
 *
 * ### 为什么这件事必须自己做（本机核实，全在 npm 包之外）
 * `playcanvas@2.22.6` **只带了 Ammo 的绑定层**（`build/playcanvas/src/framework/physics/ammo/
 * ammo-physics-{world,body,shape,joint}.js`），**一个 `*.wasm` 都没有**（`files` 白名单只有
 * `build/playcanvas*` / `scripts` / `README*.md`）。所以 Bullet/Ammo 本体要从引擎仓库的
 * `examples/assets/wasm/ammo/` vendor 进 `vendor/`，与 zstd 同一套做法。
 *
 * ### 三个非显然的机制（每一条都会"静默失败"）
 * 1. **加载器会把全局清空**：`core/wasm-module.js` 拿到胶水工厂之后会执行
 *    `window[moduleName] = void 0`，而物理后端读的正是**裸全局**
 *    （`ammo-physics-world.js` 里的 `new Ammo.btVector3(...)`）。
 *    所以 `getInstance` 回调里必须**自己把实例装回 `globalThis.Ammo`**，
 *    否则 `addComponent("rigidbody")` 什么都不做、零报错。
 * 2. **注册靠 `WasmModule.setConfig('Ammo', …)`，没有 `AppOptions.ammoUrl` 这种字段**。
 * 3. **自动接线发生在 `app.start()`**（`app-base.js` 的 `onLibrariesLoaded` →
 *    `rigid-body/system.js` 的 `if (!this._world && typeof Ammo !== "undefined")`）。
 *    这里的做法是**显式**把 world 交给 `AppOptions.physicsWorld`，不赌时机：
 *    显式传参走的是另一条分支（`app-base.js:231-233`），与全局是否存在无关。
 *
 * ### 为什么不要 asm.js 兜底
 * 引擎仓库那份 `ammo.js`（2.0 MB）是给不支持 wasm 的环境的。本项目**只跑 WebGPU**
 * （设备层已经强断言 `isWebGPU === true`），没有 wasm 的环境连视口都起不来，
 * 所以不 vendor 那 2 MB，`fallbackUrl` 不传。
 */

// Vite 的 `?url`：胶水是 IIFE（靠 window.Ammo 注册），不能当模块打进来——与 zstd 同一理由。
import ammoGlueUrl from "./vendor/ammo.wasm.js?url";
import ammoWasmUrl from "./vendor/ammo.wasm.wasm?url";

export const AMMO_ASSETS = { glueUrl: ammoGlueUrl, wasmUrl: ammoWasmUrl } as const;

export interface AmmoPhysicsHandle {
  /** `new pc.AmmoPhysicsWorld()` 的实例，交给 `AppOptions.physicsWorld` */
  world: unknown;
  /** 拿到的那个 wasm 实例（同时已装回 `globalThis.Ammo`） */
  ammo: unknown;
}

/**
 * 初始化 Ammo 并把物理世界建出来。**必须在 `app.init()` 之前**调用。
 *
 * 幂等：`WasmModule.getInstance` 内部按 name 缓存胶水工厂，重复调用不会重复下载；
 * 每次调用都会重新 `setConfig`（同一个 URL，无副作用）。
 */
export async function createAmmoPhysicsWorld(): Promise<AmmoPhysicsHandle> {
  const { WasmModule, AmmoPhysicsWorld } = await import("playcanvas");
  const ammo = await new Promise<unknown>((resolve, reject) => {
    WasmModule.setConfig("Ammo", {
      ...AMMO_ASSETS,
      /*
        ⚠️ `WasmModule.getInstance` 的回调**只有一个参数**（`callback(instance)`），
        失败时它根本不调回调，只走 `config.errorHandler` 或 `console.error`
        （`core/wasm-module.js` 的 `Impl.initialize`）。不接这个钩子的话 Promise
        永远不会 settle——视口会一直挂在"物理在加载"上，而且一句报错都没有。
      */
      errorHandler: (error: string) => reject(new Error(`Ammo wasm failed: ${error}`)),
    });
    WasmModule.getInstance("Ammo", (instance: unknown) => resolve(instance));
  });

  // 见上面第 1 条：加载器刚刚把 window.Ammo 置空，后端读的是裸全局，必须自己装回去。
  (globalThis as unknown as Record<string, unknown>).Ammo = ammo;

  return { world: new AmmoPhysicsWorld(), ammo };
}
