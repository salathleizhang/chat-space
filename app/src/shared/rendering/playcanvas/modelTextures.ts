import {
  bindingFor,
  combineSlotLabels,
  imageSize,
  isDrawableImage,
  PLAYCANVAS_SLOTS,
  PLAYCANVAS_UNSUPPORTED,
  TEXTURE_SLOTS,
  textureThumbnail,
  type ChannelTexture,
  type TextureEntry,
} from "../../../shared/lib/textureSlots";

/**
 * PlayCanvas 侧的"模型描述"生产者：遍历引擎场景图，产出**纯数据**。
 *
 * 这是 Inspector 那处待消除破口的另一半（纯数据契约在 `shared/lib/textureSlots.ts`）。
 * 迁移完成后 Inspector 只消费这里产出的 `TextureEntry[]` / `ChannelTexture`，
 * 不再需要自己挂载 loader 组件、也不再需要 three 类型。
 *
 * ### 为什么用窄结构接口而不是 `Entity` / `MeshInstance` / `StandardMaterial` 类型
 *  1. 这样遍历逻辑能在**不加载 3.6MB 引擎**的前提下被单测覆盖（本仓库的测试环境没有 GPU）。
 *  2. 引擎的属性名（`render.meshInstances`、`material`、贴图取图像的那个方法）在类型声明里
 *     并不完整——`StandardMaterial` 在 d.ts 里是 `@property` 注释风格，`Texture` 的取源入口
 *     也不止一个。用窄接口 + **防御式读取**比写死一条路径更稳，真实字段名由探针在真实浏览器里确认。
 *
 * ### 三处语义映射（照搬属性名会得到错误标注，见 `textureSlots.ts` 的旗标）
 *  - `roughnessMap` → `glossMap`，**取反**
 *  - `displacementMap` → `heightMap`，仅近似
 *  - `clearcoat*` → `clearCoat*`，大小写不同
 */

/** `StandardMaterial` 上可能挂着贴图的属性（用字符串索引，因为引擎类型里不是 TS 属性）。 */
export interface PcMaterialLike {
  name?: string;
  [property: string]: unknown;
}

/**
 * `getSource()` 的返回值。**注意它通常就是 `ImageBitmap` 本身**（见 `textureImage`），
 * 所以下面这些字段只是"某些来源可能用"的兜底，不能当成主路径。
 */
export interface PcTextureSourceLike {
  source?: unknown;
  /** 有些来源把图像放在 `img` 上。 */
  img?: unknown;
  /** 有些来源（DataTexture 等）把像素放在 `data` 上。 */
  data?: unknown;
  width?: number;
  height?: number;
}

export interface PcTextureLike {
  id?: number;
  name?: string;
  getSource?(): PcTextureSourceLike | null;
  /** 兜底：引擎内部层级。防御式读取，不依赖它一定存在。 */
  _levels?: { data?: unknown }[];
  [key: string]: unknown;
}

export interface PcMeshInstanceLike {
  material?: PcMaterialLike;
}

export interface PcEntityLike {
  name?: string;
  enabled?: boolean;
  render?: { meshInstances?: PcMeshInstanceLike[] };
  children?: PcEntityLike[];
}

const isTextureLike = (value: unknown): value is PcTextureLike =>
  !!value && typeof value === "object" && (typeof (value as PcTextureLike).getSource === "function" || "_levels" in (value as object));

/** 贴图的稳定标识：优先引擎 id，退到 name，再退到属性名 + 材质名（保证同一次遍历内稳定）。 */
function textureId(texture: PcTextureLike, fallback: string): string {
  if (typeof texture.id === "number") return `pc-texture-${texture.id}`;
  if (typeof texture.name === "string" && texture.name) return `pc-name-${texture.name}`;
  return `pc-fallback-${fallback}`;
}

/**
 * 从贴图取出可绘制的图像。
 *
 * ⚠️ **关键**：`Texture.getSource(mipLevel = 0)` 返回的就是 `this._levels[mipLevel]`，
 * 而对 GLB 贴图来说**这个 level 本身就是 `ImageBitmap`**——引擎的 `releaseImageSources()`
 * 里直接判 `level instanceof ImageBitmap` 就是证据（因此它的原型只有 `width`/`height`/`close`）。
 * 图像**不在** `level.source` 上。
 *
 * 本机实测过的弯路：先按 `level.source` / `level.img` / `level.data` 找，三条全落空，
 * 表现为"尺寸读得到（256/512/1024）、缩略图全是 null"——因为尺寸走的是 level 自己的
 * `width`/`height`，而图像那一步找错了地方。
 *
 * 顺带澄清一个**错误假设**：GLB 贴图**不会**释放 CPU 图像。`releaseSourceAfterUpload`
 * 默认 false，且全库只有 `gsplat-sog-resource.js` 打开它（那是 SOG splat 的纹理，不是模型贴图）。
 */
function textureImage(texture: PcTextureLike): unknown {
  const level = texture.getSource?.() ?? null;
  const candidates = [level, level?.source, level?.img, level?.data, texture._levels?.[0]?.data];
  return candidates.find(isDrawableImage) ?? null;
}

/** 尺寸：优先贴图来源自带，其次从图像本身读。 */
function textureDimensions(texture: PcTextureLike, image: unknown): { width: number; height: number } {
  const source = texture.getSource?.() ?? null;
  if (typeof source?.width === "number" && typeof source?.height === "number" && source.width > 0) {
    return { width: source.width, height: source.height };
  }
  return imageSize(image);
}

/**
 * 诊断用：按生产者**自己那条路径**（读原型 getter，而不是 `Object.keys` 给的实例后备字段
 * `_diffuseMap`）找出第一张贴图，并报告 `getSource()` 返回的 level 的字段形状。
 * 存在的理由：贴图取图像那一环是唯一无法靠单测确认的引擎细节，只能实测。
 */
export function describeFirstTexture(root: PcEntityLike): Record<string, unknown> {
  for (const material of collectMaterials(root)) {
    for (const slot of TEXTURE_SLOTS) {
      const binding = bindingFor(PLAYCANVAS_SLOTS, PLAYCANVAS_UNSUPPORTED, slot.key);
      if (!binding) continue;
      const texture = material[binding.property];
      if (!isTextureLike(texture)) continue;
      const level = (texture.getSource?.() ?? null) as Record<string, unknown> | null;
      const proto = level ? Object.getPrototypeOf(level) : null;
      return {
        slot: slot.key,
        property: binding.property,
        textureKeys: Object.keys(texture).slice(0, 20),
        levelKeys: level ? Object.keys(level).slice(0, 20) : [],
        levelProtoKeys: proto ? Object.getOwnPropertyNames(proto).slice(0, 20) : [],
        levelFieldTypes: level
          ? Object.fromEntries(Object.keys(level).slice(0, 12).map((k) => [k, typeof level[k]]))
          : {},
        sourceIsDrawable: isDrawableImage(level?.source),
        imgIsDrawable: isDrawableImage(level?.img),
        dataIsDrawable: isDrawableImage(level?.data),
      };
    }
  }
  return {};
}

/** 收集场景树里所有材质的去重列表（同一材质被多个 meshInstance 引用时只处理一次）。 */
export function collectMaterials(root: PcEntityLike): PcMaterialLike[] {
  const materials: PcMaterialLike[] = [];
  const seen = new Set<PcMaterialLike>();
  const walk = (entity: PcEntityLike) => {
    for (const instance of entity.render?.meshInstances ?? []) {
      const material = instance.material;
      if (material && !seen.has(material)) {
        seen.add(material);
        materials.push(material);
      }
    }
    for (const child of entity.children ?? []) walk(child);
  };
  walk(root);
  return materials;
}

/**
 * 遍历模型全部材质，按贴图去重收集——与 three 侧 `collectTextureEntries` 语义一致：
 * 预览问的是"这个模型用了哪些贴图"，不是材质清单。
 */
export function collectTextureEntries(root: PcEntityLike): TextureEntry[] {
  const textures = new Map<string, PcTextureLike>();
  const slotKeys = new Map<string, string[]>();
  const materialNames = new Map<string, string[]>();

  for (const material of collectMaterials(root)) {
    const materialName = typeof material.name === "string" ? material.name : "";
    for (const slot of TEXTURE_SLOTS) {
      const binding = bindingFor(PLAYCANVAS_SLOTS, PLAYCANVAS_UNSUPPORTED, slot.key);
      if (!binding) continue;
      const texture = material[binding.property];
      if (!isTextureLike(texture)) continue;
      const id = textureId(texture, `${materialName}:${binding.property}`);
      textures.set(id, texture);
      const keys = slotKeys.get(id) ?? [];
      if (!keys.includes(slot.key)) keys.push(slot.key);
      slotKeys.set(id, keys);
      const names = materialNames.get(id) ?? [];
      if (materialName && !names.includes(materialName)) names.push(materialName);
      materialNames.set(id, names);
    }
  }

  const entries: TextureEntry[] = [];
  for (const [id, texture] of textures) {
    const image = textureImage(texture);
    const { width, height } = textureDimensions(texture, image);
    entries.push({
      id,
      label: combineSlotLabels(slotKeys.get(id) ?? []),
      materials: materialNames.get(id) ?? [],
      width,
      height,
      dataUrl: textureThumbnail(id, image),
    });
  }
  return entries;
}

/**
 * 按**通道**收集模型自带贴图（右侧栏的"当前贴图"）。
 * 每个通道取第一个填了它的材质：多材质模型在右侧栏只呈现主材质那一份，
 * 逐个材质各列一行会把面板撑成材质清单。
 */
export function collectChannelTextures(root: PcEntityLike, slots: readonly string[]): Map<string, ChannelTexture> {
  const found = new Map<string, ChannelTexture>();
  const materials = collectMaterials(root);
  for (const slotKey of slots) {
    if (found.has(slotKey)) continue;
    const binding = bindingFor(PLAYCANVAS_SLOTS, PLAYCANVAS_UNSUPPORTED, slotKey);
    if (!binding) continue;
    for (const material of materials) {
      const texture = material[binding.property];
      if (!isTextureLike(texture)) continue;
      const image = textureImage(texture);
      const { width, height } = textureDimensions(texture, image);
      found.set(slotKey, {
        materialName: typeof material.name === "string" ? material.name : "",
        width,
        height,
        dataUrl: textureThumbnail(textureId(texture, slotKey), image),
      });
      break;
    }
  }
  return found;
}
