import { applyEntityPlacement, type PlacementEntityLike } from "./panePlacement";
import { centerFromBounds, halfExtentsFromBounds, type LocalBounds } from "./physicsBodies";
import { worldPlacement, type WorldSemanticsLike } from "./worldPlacement";
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

export type SceneAssetKind = "model" | "splat" | "collider";

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
  /**
   * 世界的语义变换（只有 `kind:"world"` 的 splat 会带）。实体的最终摆放是
   * **语义 ∘ placement**（three 侧是"外层 group + 里层 SplatModel"的两级结构）。
   */
  worldSemantics?: WorldSemanticsLike | null;
}

/**
 * 用 **Render 资产**给世界碰撞网格建静态 mesh 碰撞体实体（每个 Render 资产一个实体）。
 *
 * ### 为什么必须走 Render 资产，而不是"给实例化出来的 render 组件挂 collision"
 * 引擎的 `createMeshShape` 读的是 `component._render.meshes`
 * （`build/playcanvas.mjs` 的 `createMeshShape`），而 GLB container **实例化**出来的
 * render 组件带的是 `meshInstances`、`meshes` 是 `undefined` —— 本机真机读数：
 * `{renderLinked: true, meshInstances: 1, meshesUndefined: true, hasShape: false}`，
 * 形状永远建不出来。
 * 走 `renderAsset` 时，引擎的 `loadMeshAsset` 会把 `component._render` 直接指到
 * **Render 资源**上（`GlbContainerResource` 造的 sub-asset，`resource.meshes` 是齐的），
 * 形状才建得出来。
 *
 * ### 两个细节
 * ① **不加 `render` 组件**：加了就会把这个几十万面的地形画出来；碰撞形状不需要它
 *    （`collision.renderAsset` 自己会把 `_render` 指到资源上），所以连"不可见层"都不需要。
 * ② `renderAsset` 收 Asset 或 id 都行（引擎的 setter 会归一化成 id）。
 *
 * 返回建了几套（便于测试与诊断断言"真的挂上了"，而不是"调了 addComponent"）。
 */
export function attachStaticMeshCollider(
  renderAssets: readonly unknown[],
  createEntity: () => unknown,
  addChild: (child: unknown) => void,
): number {
  let attached = 0;
  for (const asset of renderAssets) {
    const entity = createEntity() as {
      addComponent?(name: string, data?: unknown): unknown;
      rigidbody?: unknown;
      collision?: unknown;
    } | null;
    if (!entity?.addComponent) continue;
    entity.addComponent("collision", { type: "mesh", renderAsset: asset });
    entity.addComponent("rigidbody", { type: "static" });
    addChild(entity);
    attached += 1;
  }
  return attached;
}

/**
 * 给一个摆放资产挂上**动态盒体**（可推、会掉、能被抓）。
 *
 * 与 three 侧 `PhysicalAsset` 逐项对齐的取舍：盒体而不是 mesh（生成模型是百万面级）、
 * 阻尼 0.45 / 0.35、允许睡眠。半尺寸与中心都取自模型在**实体局部坐标系**下的包围盒
 * （loader 用引擎的 AABB + 节点变换算好带出来）。
 *
 * 拿不到包围盒时**显式跳过**并返回 false——挂一个零尺寸碰撞体比不挂更难查。
 */
export function attachDynamicBoxBody(
  entity: unknown,
  bounds: LocalBounds | null | undefined,
  makeVec3?: (x: number, y: number, z: number) => unknown,
): boolean {
  const halfExtents = halfExtentsFromBounds(bounds);
  const center = centerFromBounds(bounds);
  const node = entity as {
    addComponent?(name: string, data?: unknown): unknown;
    rigidbody?: unknown;
    collision?: unknown;
  } | null;
  if (!node?.addComponent || !halfExtents || !center || !makeVec3) return false;
  if (!node.rigidbody) {
    node.addComponent("rigidbody", { type: "dynamic", linearDamping: 0.45, angularDamping: 0.35 });
  }
  if (!node.collision) {
    node.addComponent("collision", {
      type: "box",
      // 真 `Vec3` 实例，不是裸对象（见 LoadedAssetLike.vec3 的说明）
      halfExtents: makeVec3(halfExtents[0], halfExtents[1], halfExtents[2]),
      linearOffset: makeVec3(center[0], center[1], center[2]),
    });
  }
  return true;
}

/**
 * 在**摆放写上去之后**把物理同步过去（静态 mesh 地形必须走这一步）。
 *
 * 两个引擎事实叠在一起就会错位，真机症状是"角色一进第一人称就无限下落，而世界里明明有
 * 一块 `shape: mesh` 的地形"：
 *  ① loader 建形状时实体**还没进场景**（`sync` 是先 `loadCollider()` 再 `addChild`），
 *     那一刻 `entity.getWorldTransform()` 还是单位阵，顶点被按 scale=1 烘进 trimesh；
 *  ② 引擎的 `syncEntityToBody()` **只在刚体加入世界那一刻**调一次
 *     （`enableSimulation` 里），静态刚体此后**每帧都不再同步**——所以 `apply()` 之后
 *     移动实体会让物理体留在原地。
 *
 * 于是这里做两件事：把 body 变换同步成实体当前变换，并重新赋值 `renderAsset`
 * （走引擎 setter → `doRecreatePhysicalShape`）用**当前**世界缩放重烘一次形状。
 * 返回同步了几个，便于测试与诊断断言"真的同步了"。
 */
export function syncPhysicsToPlacement(root: unknown): number {
  const findComponents = (root as { findComponents?(name: string): unknown[] }).findComponents;
  if (typeof findComponents !== "function") return 0;
  const collisions = findComponents.call(root, "collision") as Array<{
    type?: string;
    renderAsset?: unknown;
    entity?: { rigidbody?: { syncEntityToBody?(): void } };
  }>;
  let synced = 0;
  for (const collision of collisions) {
    if (collision.type === "mesh" && collision.renderAsset !== undefined && collision.renderAsset !== null) {
      collision.renderAsset = collision.renderAsset;
    }
    collision.entity?.rigidbody?.syncEntityToBody?.();
    synced += 1;
  }
  return synced;
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
  /** 模型在**实体局部坐标系**下的包围盒；拿不到就不挂盒体碰撞体（见 halfExtentsFromBounds） */
  localBounds?: LocalBounds | null;
  /**
   * 造引擎 `Vec3` 的工厂。**必须由 loader 给**：碰撞组件的 `halfExtents` / `linearOffset`
   * 要的是 `Vec3` 实例，传裸对象 `{x,y,z}` 会被静默丢掉——真机读数
   * `collision.halfExtents === undefined`（组件建了、形状也建了，但盒体尺寸是空），
   * 表现就是"物体像没有碰撞体一样"。
   */
  vec3?: (x: number, y: number, z: number) => unknown;
  dispose(): void;
}

export interface SceneAssetsOptions {
  addChild(child: unknown): void;
  removeChild?(child: unknown): void;
  /** 加载模型（测试注入点）。默认实现用 `loadFromUrlAndFilename` + `instantiateRenderEntity`。 */
  loadModel?(url: string): Promise<LoadedAssetLike>;
  /**
   * 加载**世界碰撞网格**（`kind:"collider"`）：返回一棵只做物理、不画任何东西的实体树。
   * 默认实现走 container 的 **Render 资产**（见 `attachStaticMeshCollider` 的说明）。
   */
  loadCollider?(url: string): Promise<LoadedAssetLike>;
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
    loadCollider: options.loadCollider,
  };

  const makeEntry = (spec: SceneAssetSpec, loaded: LoadedAssetLike): SceneAssetEntry => {
    let placement = spec.placement;
    let visible = true;
    let materials = spec.materials;
    const entity = loaded.entity;
    // 被 gizmo 改动的是 `placement`（用户摆放）；实体上写的是**合成后**的变换。
    // `WorldSemantics` 缺省时 `worldPlacement` 原样返回用户摆放，老数据不受影响。
    const apply = () => applyEntityPlacement(entityOf({ entity }), worldPlacement(spec.worldSemantics ?? null, placement));
    apply();
    /*
      逐物体刚体：每个摆放资产一个**动态盒体**（与 three 侧 `PhysicalAsset` 同一套取舍：
      生成模型是百万面级，绝不能用 mesh 形状）。
      `center` 必须补：PC 没有 three 那边的 `<Center>`，GLB 原点未必在几何中心。
    */
    if (spec.kind === "model") attachDynamicBoxBody(entity, loaded.localBounds, loaded.vec3);
    /*
      物理同步：**摆放写上去之后**做（见 `syncPhysicsToPlacement` 说明）。
      静态地形与刚建好的物体都必须走这一步，否则"移动实体"对物理来说等于没发生
      （静态体只在加入世界那一刻同步一次）。
    */
    if (spec.kind === "collider" || spec.kind === "model") syncPhysicsToPlacement(entity);
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
            : spec.kind === "collider"
              ? await loaders.loadCollider!(spec.url)
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
/**
 * 模型在**实体局部坐标系**下的包围盒（盒体碰撞体要用它）。
 *
 * 逐 `meshInstance` 用引擎的 `setFromTransformedAabb` 算：先把 `mesh.aabb`（网格局部）
 * 乘上 **`实体世界矩阵⁻¹ · 节点世界矩阵`**，得到的就是"网格盒在实体局部坐标系里的盒"，
 * 再逐个 `add` 合并。
 *
 * 两个踩过的点：
 * ① 实体此刻**还没进场景**（`addChild` 在 loader 之后），但相对矩阵不受影响——
 *    整体乘一个逆矩阵会把实体自己的变换约掉，所以算法对"挂着/没挂着"都成立；
 * ② 拿不到任何 mesh 时返回 `null`，调用方据此**跳过**挂载，而不是挂一个空盒。
 */
function computeLocalBounds(
  pc: {
    BoundingBox: new () => {
      add(other: unknown): void;
      copy(src: unknown): void;
      setFromTransformedAabb(aabb: unknown, matrix: unknown): void;
      center: { x: number; y: number; z: number };
      halfExtents: { x: number; y: number; z: number };
    };
    Mat4: new () => { mul2(a: unknown, b: unknown): unknown };
  },
  entity: unknown,
): LocalBounds | null {
  const node = entity as {
    findComponents?(name: string): Array<{ meshInstances?: Array<{ mesh?: { aabb?: unknown }; node?: { getWorldTransform(): unknown } }> }>;
    getWorldTransform(): { clone(): { invert(): unknown } };
  };
  const renders = node.findComponents?.("render") ?? [];
  if (!renders.length) return null;
  const inverse = node.getWorldTransform().clone().invert();
  const relative = new pc.Mat4();
  const temp = new pc.BoundingBox();
  const union = new pc.BoundingBox();
  let any = false;
  for (const render of renders) {
    for (const meshInstance of render.meshInstances ?? []) {
      const aabb = meshInstance.mesh?.aabb;
      const meshNode = meshInstance.node;
      if (!aabb || !meshNode) continue;
      relative.mul2(inverse, meshNode.getWorldTransform());
      temp.setFromTransformedAabb(aabb, relative);
      if (!any) {
        union.copy(temp);
        any = true;
      } else {
        union.add(temp);
      }
    }
  }
  if (!any) return null;
  const { center, halfExtents } = union;
  return {
    min: [center.x - halfExtents.x, center.y - halfExtents.y, center.z - halfExtents.z],
    max: [center.x + halfExtents.x, center.y + halfExtents.y, center.z + halfExtents.z],
  };
}

export async function createEngineSceneLoaders(app: unknown): Promise<{
  loadModel(url: string): Promise<LoadedAssetLike>;
  createSplat(url: string): Promise<LoadedAssetLike>;
  loadCollider(url: string): Promise<LoadedAssetLike>;
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
      return {
        entity,
        localBounds: computeLocalBounds(pc, entity),
        vec3: (x, y, z) => new pc.Vec3(x, y, z),
        dispose: () => (entity as { destroy(): void }).destroy(),
      };
    },
    /*
      世界碰撞网格：**不实例化任何可渲染的东西**，只用 container 里的 **Render 资产**建
      静态 mesh 碰撞体实体（理由见 `attachStaticMeshCollider`：实例化出来的 render 组件
      没有 `meshes`，形状永远建不出来）。每个 Render 资产一个实体，全部藏在
      `world-collider` 名下——它们没有 render 组件，所以一个像素都不画。
    */
    async loadCollider(url) {
      const loaded = await withTimeout(new Promise<{ resource?: { renders?: unknown[] } }>((resolve, reject) => {
        assets.loadFromUrlAndFilename(url, "world.glb", "container", (err, asset) => {
          if (err) reject(new Error(`碰撞网格加载失败: ${err instanceof Error ? err.message : JSON.stringify(err)}`));
          else resolve(asset as { resource?: { renders?: unknown[] } });
        });
      }), `碰撞网格 ${url}`);
      const renders = loaded.resource?.renders;
      if (!renders?.length) throw new Error("碰撞网格没有 Render 资产（GLB 未加载成功或没有网格）");
      const root = new Entity(`world-collider:${url}`);
      const attached = attachStaticMeshCollider(
        renders,
        () => new Entity("collider-mesh"),
        (child) => root.addChild(child as never),
      );
      if (!attached) throw new Error("碰撞网格没有可用的 Render 资产");
      return { entity: root, dispose: () => root.destroy() };
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
