import { MATERIAL_TEXTURE_SLOTS, type AssetMaterial, type MaterialTextureSlot } from "./libraryApi";

/** 材质相关的数据契约类型也从这里出，消费者只需要认这一个模块。 */
export type { AssetMaterial, MaterialTextureSlot };


/**
 * 材质覆盖的**纯数据契约**：展示名、默认值、判据、收敛。这里刻意不导入 three。
 *
 * 为什么从 `materialOverrides.ts` 切出来：那个文件里只有一个 `collectSupportedSlots` 真的需要
 * three（它要遍历 `THREE.Object3D` 的材质原型）。但撤销栈（`pages/AppDashboard/useSceneHistory.ts`）
 * 与 `Inspector` 只用 `DEFAULT_MATERIAL` / `normalizeMaterial` 这两个纯常量与纯函数——
 * 却因为同住一个文件而**把 three 拉进了编辑层**。渲染层迁移到 PlayCanvas 时，那会迫使编辑层跟着改。
 *
 * 探测"模型自带材质认哪些通道"是**渲染层的职责**（它要看真实的场景图），见
 * `materialOverrides.ts` 的 `collectSupportedSlots`；那个函数在迁移中要换成引擎中立的接口。
 */

export const SLOT_LABELS: Record<MaterialTextureSlot, string> = {
  map: "Base color",
  normalMap: "Normal",
  roughnessMap: "Roughness",
  metalnessMap: "Metalness",
  aoMap: "Ambient occlusion",
  emissiveMap: "Emissive",
  alphaMap: "Alpha",
};

/** 没有覆盖记录时的语义默认值：一张贴图都不换 */
export const DEFAULT_MATERIAL: AssetMaterial = { textures: {} };

/**
 * 这个材质记录是否等于"什么都不改"。等于默认值时视口直接跳过覆盖，
 * 因此不需要额外的开关，也不需要把记录从 scene.json 里删掉。
 */
export function isDefaultMaterial(material: AssetMaterial | undefined): boolean {
  if (!material) return true;
  return Object.values(material.textures).every((path) => path == null);
}

/** 把可能来自旧版本/手写文件的记录收敛成完整值，避免下游到处做 undefined 判断 */
export function normalizeMaterial(material: AssetMaterial | undefined): AssetMaterial {
  if (!material) return DEFAULT_MATERIAL;
  return { textures: material.textures ?? {} };
}

/** 七个候选通道的并集，供渲染层探测用。纯数据，与引擎无关。 */
export const CANDIDATE_SLOTS = MATERIAL_TEXTURE_SLOTS;
