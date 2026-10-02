/**
 * 线框着色：把「模型资产」的 mesh instance 切成线框画法，关掉时再切回来。
 *
 * ⚠️ **PlayCanvas 的线框不是材质标志位**：`StandardMaterial` 上**没有** `wireframe`，正确做法是
 * `meshInstance.renderStyle = RENDERSTYLE_WIREFRAME`（引擎为每个 mesh 备了一份线框索引缓冲，
 * `prepareRenderState` 会挑对那份）。三条约束：
 * ① **只切模型资产**：泼溅世界/天空盒/地面网格/HUD 一律照旧；
 * ② **记账表由调用方持有**，且**已经切过的不要覆盖原值**——否则第二次 apply 会把"线框"记成原值，
 *    关掉后就永远回不去（只在开关两次后显形，所以有一条专门单测）；
 * ③ 切/还是**纯逻辑**（本文件），引擎常量由调用方传入，于是它能单测。
 *
 * 本文件只放**纯逻辑**（遍历 + 记账 + 换/还），引擎材质由调用方建好传进来——这样它能单测。
 */

export interface ShadingMeshInstanceLike {
  /** 引擎的 `RENDERSTYLE_*` 常量（0 = SOLID，1 = WIREFRAME） */
  renderStyle?: number;
}

export interface ShadingEntityLike {
  render?: { meshInstances?: ShadingMeshInstanceLike[] };
  children?: ShadingEntityLike[];
}

/** 递归收集一个实体树里的 mesh instance（探针/测试都用假数据走同一条路）。 */
export function collectMeshInstances(entities: Iterable<unknown>): ShadingMeshInstanceLike[] {
  const found: ShadingMeshInstanceLike[] = [];
  const visit = (node: unknown) => {
    if (!node || typeof node !== "object") return;
    const entity = node as ShadingEntityLike;
    const instances = entity.render?.meshInstances;
    if (Array.isArray(instances)) {
      for (const instance of instances) if (instance && instance.renderStyle !== undefined) found.push(instance);
    }
    if (Array.isArray(entity.children)) for (const child of entity.children) visit(child);
  };
  for (const entity of entities) visit(entity);
  return found;
}

/**
 * 换成线框材质。**记账表由调用方持有**（`Map` 而不是 `WeakMap`：要在还原时遍历，
 * 而且显式清空比等 GC 可靠）。**已经换过的不要覆盖原值**——否则第二次 apply 会把线框材质
 * 当成"原材质"记下来，还原后就永远回不去了（这类"记错原值"的 bug 只在开关两次后才显形）。
 */
export function applyWireframeShading(
  entities: Iterable<unknown>,
  wireframeStyle: number,
  saved: Map<ShadingMeshInstanceLike, number | undefined>,
): number {
  let changed = 0;
  for (const instance of collectMeshInstances(entities)) {
    if (!saved.has(instance)) saved.set(instance, instance.renderStyle);
    if (instance.renderStyle !== wireframeStyle) { instance.renderStyle = wireframeStyle; changed += 1; }
  }
  return changed;
}

/** 还原并清空记账。返回还原了几个。 */
export function restoreWireframeShading(saved: Map<ShadingMeshInstanceLike, number | undefined>): number {
  let restored = 0;
  for (const [instance, original] of saved) {
    instance.renderStyle = original;
    restored += 1;
  }
  saved.clear();
  return restored;
}