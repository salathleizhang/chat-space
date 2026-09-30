import * as THREE from "three";
import { CANDIDATE_SLOTS, type MaterialTextureSlot } from "./materialSchema";

/**
 * **渲染层**的材质探测：从真实的场景图里问出"模型自带材质认哪些通道"。
 *
 * ⚠️ 本文件里只有 `collectSupportedSlots` 是渲染相关的。展示名、默认值、判据与收敛这四样
 * 是纯数据，已搬到 `./materialSchema`——撤销栈与 Inspector 从那里导入，**不要**让编辑层
 * 再从本文件取它们（会把 three 拉进编辑层，`pages/editingLayerBoundary.test.ts` 会拦下来）。
 *
 * 迁移到 PlayCanvas 时，`collectSupportedSlots` 要换成引擎中立的接口（例如由渲染层在加载后
 * 产出一份"支持的通道"描述，Inspector 只消费数据），本文件随 three 一起删除。
 */

// 兼容性再导出：现有导入方（widgets/Viewport/materialOverride.ts 等）暂不受影响，
// 但编辑层的新代码请直接指向 ./materialSchema。
export { CANDIDATE_SLOTS, DEFAULT_MATERIAL, SLOT_LABELS, isDefaultMaterial, normalizeMaterial } from "./materialSchema";

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
  candidates: readonly MaterialTextureSlot[] = CANDIDATE_SLOTS,
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
