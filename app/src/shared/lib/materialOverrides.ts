import * as THREE from "three";
import {
  MATERIAL_TEXTURE_SLOTS,
  type AssetMaterial,
  type MaterialTextureSlot,
} from "./libraryApi";

/**
 * 材质覆盖的展示名与判据，以及"模型自带材质到底认哪些通道"的探测。
 *
 * 覆盖本身只做一件事：把用户指定的通道换成工程里的另一张图（见
 * `widgets/Viewport/materialOverride.ts`）。**没有"换 shader"这回事**——早先版本提供过
 * 九个着色器档位，后来删掉了：这个面板的主要工作是换贴图，而那些档位要么与"保持原材质"
 * 逐像素相同（面板不暴露 clearcoat/transmission，Physical 与 Standard 等价），要么是把
 * 外观改成用户调不回来的样子（Phong/Lambert 往回退，Toon 没有 gradientMap 可调）。
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

/**
 * 一批候选通道里，模型自带材质**真正声明过**的那些。
 *
 * 为什么需要它：候选表是七个通道的并集（原材质可能是 glTF 的 standard/physical，也可能是
 * OBJ/FBX 的 phong/lambert），但 `MeshPhongMaterial` 上 `roughnessMap` 根本不存在——
 * 给一个不读这个槽位的材质换贴图，渲染上什么都不会发生。与其让用户以为功能坏了，
 * 不如把该材质不认的通道从列表里去掉。
 *
 * 判据是 `slot in material`：three 的材质属性挂在原型上，所以这条判断同时覆盖
 * 自身属性与继承属性，加通道不用改这里。
 */
export function collectSupportedSlots(
  root: THREE.Object3D,
  candidates: readonly MaterialTextureSlot[] = MATERIAL_TEXTURE_SLOTS,
): Set<MaterialTextureSlot> {
  const supported = new Set<MaterialTextureSlot>();
  root.traverse((node) => {
    if (supported.size === candidates.length) return;
    const material = (node as { material?: THREE.Material | THREE.Material[] }).material;
    if (!material) return;
    for (const mat of Array.isArray(material) ? material : [material]) {
      for (const slot of candidates) {
        if (!supported.has(slot) && slot in mat) supported.add(slot);
      }
    }
  });
  return supported;
}
