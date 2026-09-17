/**
 * 构建产物换代后，仍开着旧页面的标签页会去取已经不存在的旧 chunk：懒加载失败
 * 会让整个工作台落进 errorElement（用户看到的是「场景崩了」，报错形如
 * Failed to fetch dynamically imported module: /assets/ModelPreviewWindow-<hash>.js）。
 *
 * Vite 的模块预加载失败会派发 `vite:preloadError`。这里自动重载一次去取新入口，
 * 并用 sessionStorage 标记兜底：万一新页面仍取不到 chunk，也不会陷入重载循环。
 */
const RELOAD_FLAG = "chatspace:chunk-reload";

export interface StaleChunkReloadDeps {
  addEventListener: (type: string, listener: (event: Event) => void) => void;
  reload: () => void;
  storage: Pick<Storage, "getItem" | "setItem" | "removeItem">;
}

export function installStaleChunkReload(deps: StaleChunkReloadDeps): void {
  deps.addEventListener("vite:preloadError", (event) => {
    event.preventDefault();
    if (deps.storage.getItem(RELOAD_FLAG) === "1") return;
    deps.storage.setItem(RELOAD_FLAG, "1");
    deps.reload();
  });
}

/** 入口脚本这次真的跑起来了 = 重载成功；清掉标记，让下一次构建换代仍能自愈。 */
export function clearStaleChunkReloadFlag(
  storage: Pick<Storage, "removeItem"> = sessionStorage,
): void {
  storage.removeItem(RELOAD_FLAG);
}
