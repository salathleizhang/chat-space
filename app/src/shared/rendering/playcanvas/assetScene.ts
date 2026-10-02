import { applyEntityPlacement, type PlacementEntityLike } from "./panePlacement";
import type { Placement } from "./selectionTransform";

/**
 * 把**项目资产**挂进 PlayCanvas 场景：一件资产一个实体，摆放按 three 约定写回。
 * 这是 §五.5（把渲染层接进应用）缺的第一块可复用件——此前"加载 GLB / 加载 splat"的写法
 * 只存在于 dev 探针 `panes.browser.ts` 里。
 *
 * ### 三条来自既有踩坑记录的约束
 * ① **GLB 用 `assets.loadFromUrlAndFilename(url, "model.glb", "container", cb)`**：
 *    引擎自带示例（`viewer.example.mjs:450`）就是这么写的；而 `new Asset(name, "container", {url})`
 *    + `AssetListLoader` 拿到的 `instantiateRenderEntity()` 返回**空树**（`hasRender:false`）。
 *    **别只监听 `error` 事件**——失败在回调的 `err` 参数里，只监听事件会漏掉。
 * ② **splat 资产必须是 SPZ v4**（解析器只认 version 4；legacy 的 `.spz` 头是 `1f8b`＝gzip），
 *    并且拾取要 `scene.gsplat.enableIds = true`（`gsplat.enableIds` 默认 false）。
 * ③ **摆放只走四元数**（`panePlacement`）：引擎的欧拉 API 是**角度 + ZYX**，而摆放是 three 的
 *    **弧度 + XYZ**，直接互喂会静默转错朝向。
 */

export type SceneAssetKind = "model" | "splat";

/**
 * 单件资产的加载超时。**必须要有**：真机上引擎的 container 加载在某些响应（例如 SPA 回退返回
 * `index.html`、或服务端不响应）下**既不回调也不报错**，于是 `await loadFromUrlAndFilename` 永不返回、
 * `sync()` 悬死——症状是"什么都没挂上，而且连一条错误都没有"（本机踩过）。
 * 超时按 `onError` 报出来，`sync` 才能继续处理其它资产。
 */
export const LOAD_TIMEOUT_MS = 8_000;

/** 给一个 promise 套超时；原始错误照原样透传，只有"一直没动静"才报超时。 */
export function withTimeout<T>(promise: Promise<T>, label: string, ms = LOAD_TIMEOUT_MS): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${label} 超过 ${ms} ms 没有回调（引擎既不成功也不报错）`)), ms);
    promise.then(
      (value) => { clearTimeout(timer); resolve(value); },
      (error) => { clearTimeout(timer); reject(error); },
    );
  });
}

export interface SceneAssetSpec {
  /** 稳定 id（应用里就是 `asset.id`；`live`/撤销栈都按它索引） */
  id: string;
  kind: SceneAssetKind;
  /** 模型 `.glb` 或点云 `.spz` 的 URL（带 `?revision=N` 时由调用方拼好） */
  url: string;
  /** 初始摆放（three 约定：位置 / **弧度 XYZ** / 缩放） */
  placement: Placement;
  /** 材质覆盖（右侧栏改过的）；形状由 `modelTextures` 决定，本模块只透传 */
  materials?: unknown;
}

/** 一件已挂载的资产。实体由本模块创建，销毁也归本模块。 */
export interface SceneAssetEntry {
  readonly id: string;
  readonly kind: SceneAssetKind;
  readonly entity: unknown;
  placement(): Placement;
  setPlacement(placement: Placement): void;
  /** 立即把当前摆放写进实体（拖动结束时用；拖动中走 `setPlacement` 也一样） */
  apply(): void;
  setVisible(visible: boolean): void;
  visible(): boolean;
  setMaterials(materials: unknown): void;
  /** 当前生效的材质覆盖（本模块只透传，真正应用在材质覆盖那一层） */
  materials(): unknown;
  dispose(): void;
}

export interface LoadedAssetLike {
  entity: unknown;
  dispose(): void;
}

export interface SceneAssetsOptions {
  addChild(child: unknown): void;
  removeChild?(child: unknown): void;
  /** 加载模型（测试注入点）。默认实现用 `loadFromUrlAndFilename` + `instantiateRenderEntity`。 */
  loadModel?(url: string): Promise<LoadedAssetLike>;
  /** 加载点云（测试注入点）。默认实现建 `gsplat` 组件实体。 */
  createSplat?(url: string): Promise<LoadedAssetLike>;
  /** 单件资产加载失败：不打断其它资产（调用方决定怎么提示） */
  onError?(spec: SceneAssetSpec, error: unknown): void;
  onLoaded?(entry: SceneAssetEntry): void;
}

export interface SceneAssetsHandle {
  /** 与期望的资产集合对齐：新增的加载、缺的销毁、已有的更新摆放与材质。返回是否全部就绪。 */
  sync(specs: readonly SceneAssetSpec[]): Promise<boolean>;
  ids(): string[];
  entry(id: string): SceneAssetEntry | undefined;
  /** 正在加载中的 id（用于"还没好"的 UI 提示） */
  loading(): string[];
  dispose(): void;
}

const entityOf = (entry: { entity: unknown }): PlacementEntityLike => entry.entity as PlacementEntityLike;

/**
 * 建一个"资产 → 实体"的挂载器。
 *
 * ### 为什么 `sync` 是幂等的
 * React 每次渲染都会给一份**新数组**，逐项比对 `id` 才能避免"每帧重建整个场景"。
 * 摆放变化只写实体（不重建），URL 变了才重建。
 */
export function createSceneAssets(options: SceneAssetsOptions): SceneAssetsHandle {
  interface Internal {
    spec: SceneAssetSpec;
    entry: SceneAssetEntry;
  }
  const mounted = new Map<string, Internal>();
  const pending = new Set<string>();
  let disposed = false;

  const loaders = {
    loadModel: options.loadModel,
    createSplat: options.createSplat,
  };

  const makeEntry = (spec: SceneAssetSpec, loaded: LoadedAssetLike): SceneAssetEntry => {
    let placement = spec.placement;
    let visible = true;
    let materials = spec.materials;
    const entity = loaded.entity;
    const apply = () => applyEntityPlacement(entityOf({ entity }), placement);
    apply();
    return {
      id: spec.id,
      kind: spec.kind,
      entity,
      placement: () => placement,
      setPlacement(next) {
        placement = next;
        apply();
      },
      apply,
      setVisible(next) {
        visible = next;
        (entity as { enabled?: boolean }).enabled = next;
      },
      visible: () => visible,
      setMaterials(next) {
        materials = next;
      },
      materials: () => materials,
      dispose() {
        loaded.dispose();
      },
    };
  };

  const disposeEntry = (internal: Internal) => {
    options.removeChild?.(internal.entry.entity);
    internal.entry.dispose();
    /*
      **实体也要销毁**：`LoadedAssetLike.dispose` 的契约是"释放加载器持有的资源"，
      真机上 `instantiateRenderEntity()` 出来的实体它不会顺手 `destroy()`——只摘不销毁
      就是每换一次代次泄漏一棵实体树（测试的假 dispose 是空实现，所以这条不写就报
      "destroyed 计数 0"）。已经销毁过的再调一次是幂等的，不额外判断。
    */
    (internal.entry.entity as { destroy?(): void } | undefined)?.destroy?.();
  };

  return {
    async sync(specs) {
      if (disposed) return false;
      const wanted = new Map(specs.map((spec) => [spec.id, spec]));
      // 1) 移除不再需要的
      for (const [id, internal] of [...mounted]) {
        if (!wanted.has(id)) {
          disposeEntry(internal);
          mounted.delete(id);
        }
      }
      // 2) 新增 / 更新
      let allReady = true;
      for (const spec of specs) {
        const existing = mounted.get(spec.id);
        if (existing) {
          // 同一个 id：URL 变了要重建（换资产代次），否则只更新摆放与材质（**不重建**）
          if (existing.spec.url !== spec.url || existing.spec.kind !== spec.kind) {
            disposeEntry(existing);
            mounted.delete(spec.id);
          } else {
            existing.spec = spec;
            existing.entry.setPlacement(spec.placement);
            existing.entry.setMaterials(spec.materials);
            continue;
          }
        }
        pending.add(spec.id);
        try {
          const loaded = spec.kind === "splat"
            ? await loaders.createSplat!(spec.url)
            : await loaders.loadModel!(spec.url);
          if (disposed) {
            loaded.dispose();
            return false;
          }
          options.addChild(loaded.entity);
          const entry = makeEntry(spec, loaded);
          mounted.set(spec.id, { spec, entry });
          options.onLoaded?.(entry);
        } catch (error) {
          allReady = false;
          options.onError?.(spec, error);
        } finally {
          pending.delete(spec.id);
        }
      }
      return allReady && pending.size === 0;
    },
    ids: () => [...mounted.keys()],
    entry: (id) => mounted.get(id)?.entry,
    loading: () => [...pending],
    dispose() {
      disposed = true;
      for (const internal of mounted.values()) disposeEntry(internal);
      mounted.clear();
      pending.clear();
    },
  };
}

/** 引擎侧默认加载器（与本模块同文件，避免再开一层薄适配）。 */
export async function createEngineSceneLoaders(app: unknown): Promise<{
  loadModel(url: string): Promise<LoadedAssetLike>;
  createSplat(url: string): Promise<LoadedAssetLike>;
}> {
  const pc = await import("playcanvas");
  const { Asset, AssetListLoader, Entity } = pc;
  const assets = (app as { assets: unknown }).assets as {
    loadFromUrlAndFilename(
      url: string, filename: string, type: string,
      callback: (err: unknown, asset: unknown) => void,
    ): void;
  };
  return {
    async loadModel(url) {
      const loaded = await withTimeout(new Promise<{ resource?: { instantiateRenderEntity(): unknown } }>((resolve, reject) => {
        assets.loadFromUrlAndFilename(url, "model.glb", "container", (err, asset) => {
          // **回调的 err 才是权威**：只监听 error 事件会漏掉失败
          if (err) reject(new Error(`container 加载失败: ${err instanceof Error ? err.message : JSON.stringify(err)}`));
          else resolve(asset as { resource?: { instantiateRenderEntity(): unknown } });
        });
      }), `container ${url}`);
      const instantiate = loaded.resource?.instantiateRenderEntity?.bind(loaded.resource);
      if (!instantiate) throw new Error("container 没有 instantiateRenderEntity（GLB 未加载成功）");
      const entity = instantiate();
      return { entity, dispose: () => (entity as { destroy(): void }).destroy() };
    },
    async createSplat(url) {
      const asset = new Asset(`gsplat:${url}`, "gsplat", { url });
      await withTimeout(new Promise<void>((resolve, reject) => {
        asset.on("error", (err: unknown) => reject(err instanceof Error ? err : new Error(String(err))));
        new AssetListLoader([asset], (app as { assets: unknown }).assets as never).load(() => resolve());
      }), `gsplat ${url}`);
      const entity = new Entity(`splat:${url}`);
      entity.addComponent("gsplat", { asset });
      return { entity, dispose: () => entity.destroy() };
    },
  };
}
