import type { Material, Object3D, Texture } from "three";
import {
  combineSlotLabels,
  imageSize,
  TEXTURE_SLOTS,
  textureThumbnail,
  type ChannelTexture,
  type TextureEntry,
} from "./textureSlots";

/**
 * ⚠️ **本文件是渲染层**（依赖 three 的场景图），不是共享数据。
 *
 * 它只做一件事：遍历引擎的场景图，把模型自带材质上的贴图抽成**纯数据**
 * （`TextureEntry` / `ChannelTexture`）。通道表、缩略图生成与缓存、数据类型都在
 * `./textureSlots`——那一半是引擎无关的，迁移到 PlayCanvas 时**不动**。
 *
 * 这个访问路径本身是**待消除的破口**（见 `pages/editingLayerBoundary.test.ts` 的 SEAMS）：
 * Inspector 今天靠"自己挂载视口那份 loader 组件、再遍历 three 对象"来回答
 * "这个模型支持哪些贴图通道、每通道是什么图"。迁移后 three 对象不存在，
 * 正确形态是渲染层产出一份纯数据的"模型描述"，Inspector 只消费数据。
 *
 * 因此本文件在 PlayCanvas 版适配器就位后**随 three 一起删除**。
 */

// 类型原先定义在本文件，现已搬到纯模块。这里再导出一次，避免迁移期引用方断掉；
// 新代码请直接从 `./textureSlots` 导入。
export type { ChannelTexture, TextureEntry } from "./textureSlots";

function textureId(texture: Texture): string {
  return texture.uuid;
}

function materialName(material: Material): string {
  return material.name ?? "";
}

/**
 * 遍历模型全部材质，按贴图去重收集。
 * 跨材质共用同一张贴图时也只出一条——预览的是"这个模型用了哪些贴图"，不是材质清单。
 */
export function collectTextureEntries(root: Object3D): TextureEntry[] {
  /** id → 该贴图命中的全部槽位 key（展示名在最后统一合成，保证顺序稳定） */
  const slotKeys = new Map<string, string[]>();
  /** id → 用到这张贴图的材质名 */
  const materialNames = new Map<string, string[]>();
  const textures = new Map<string, Texture>();

  root.traverse((node) => {
    const material = (node as { material?: Material | Material[] }).material;
    if (!material) return;
    for (const mat of Array.isArray(material) ? material : [material]) {
      for (const slot of TEXTURE_SLOTS) {
        const texture = (mat as unknown as Record<string, unknown>)[slot.key] as Texture | null | undefined;
        if (!texture?.isTexture) continue;
        const id = textureId(texture);
        textures.set(id, texture);
        const keys = slotKeys.get(id) ?? [];
        if (!keys.includes(slot.key)) keys.push(slot.key);
        slotKeys.set(id, keys);
        const names = materialNames.get(id) ?? [];
        const name = materialName(mat);
        if (name && !names.includes(name)) names.push(name);
        materialNames.set(id, names);
      }
    }
  });

  const entries: TextureEntry[] = [];
  for (const [id, texture] of textures) {
    const { width, height } = imageSize(texture.image);
    entries.push({
      id,
      label: combineSlotLabels(slotKeys.get(id) ?? []),
      materials: materialNames.get(id) ?? [],
      width,
      height,
      dataUrl: textureThumbnail(id, texture.image),
    });
  }
  return entries;
}

/**
 * 按**通道**收集模型自带贴图，与 `collectTextureEntries` 的"按贴图去重"正好相反：
 * 悬浮卡问的是"这个模型用了哪些贴图"，右侧栏问的是"base color 这一格现在是谁"。
 * 因此这里按传入的槽位顺序逐个查，每个槽位取第一个填了它的材质——多材质模型在
 * 右侧栏里只呈现主材质那一份，逐个材质各列一行会把面板撑成材质清单。
 */
export function collectChannelTextures(root: Object3D, slots: readonly string[]): Map<string, ChannelTexture> {
  const found = new Map<string, ChannelTexture>();
  root.traverse((node) => {
    if (found.size === slots.length) return;
    const material = (node as { material?: Material | Material[] }).material;
    if (!material) return;
    for (const mat of Array.isArray(material) ? material : [material]) {
      for (const slot of slots) {
        if (found.has(slot)) continue;
        const texture = (mat as unknown as Record<string, unknown>)[slot] as Texture | null | undefined;
        if (!texture?.isTexture) continue;
        const { width, height } = imageSize(texture.image);
        found.set(slot, {
          materialName: materialName(mat),
          width,
          height,
          dataUrl: textureThumbnail(textureId(texture), texture.image),
        });
      }
    }
  });
  return found;
}
