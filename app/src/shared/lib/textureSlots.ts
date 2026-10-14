/**
 * 贴图通道的**纯数据契约**与缩略图生成。这里刻意不导入 three / playcanvas。
 *
 * 为什么切出来：`modelTextures.ts` 原本一半是"遍历引擎场景图"（引擎相关）、一半是
 * "通道表 + 缩略图 + 数据类型"（完全引擎无关）。渲染层从 three 迁到 PlayCanvas 时，
 * 只有遍历那一半需要重写；通道表、缩略图缓存与数据类型必须共享，否则右侧栏的
 * "当前贴图"面板要跟着引擎换一遍。
 *
 * ⚠️ **不要与 `materialSchema.ts` 的 `MATERIAL_TEXTURE_SLOTS` 混淆**——两者用途不同：
 *  - 本文件的 `TEXTURE_SLOTS`（18 项）是**发现**：模型自带的材质可能填了哪些通道，用于预览。
 *  - `materialSchema` 的 `MATERIAL_TEXTURE_SLOTS`（7 项）是**覆盖**：用户能手动换图的通道。
 *   它更窄是刻意的：只保留各材质类型普遍认得的槽位（见 `materialOverrides.ts` 的说明）。
 */

/**
 * 材质上的贴图槽位 → 展示名；覆盖 glTF PBR 与 OBJ/FBX 常见的 phong 槽位。
 * 展示名刻意用短写（Metal/Rough 而非 Metallic/Roughness）：一图两槽合并后要塞进
 * 96px 宽的缩略图标注里，全称会被截断。
 *
 * `key` 是**引擎侧材质属性名**。三个引擎里同名率很高（`map`/`normalMap`/`aoMap`…），
 * 但 PlayCanvas 的 base color 叫 `diffuseMap`、金属度叫 `metalnessMap` 但挂在
 * `StandardMaterial` 上——所以适配器负责把本表映射到各自的属性名，本表本身保持中立。
 */
export const TEXTURE_SLOTS: readonly { key: string; label: string }[] = [
  { key: "map", label: "Base Color" },
  { key: "normalMap", label: "Normal" },
  { key: "bumpMap", label: "Bump" },
  { key: "metalnessMap", label: "Metal" },
  { key: "roughnessMap", label: "Rough" },
  { key: "aoMap", label: "AO" },
  { key: "emissiveMap", label: "Emissive" },
  { key: "alphaMap", label: "Alpha" },
  { key: "specularMap", label: "Specular" },
  { key: "displacementMap", label: "Disp" },
  { key: "lightMap", label: "Lightmap" },
  { key: "clearcoatMap", label: "CC" },
  { key: "clearcoatRoughnessMap", label: "CC Rough" },
  { key: "clearcoatNormalMap", label: "CC Normal" },
  { key: "sheenColorMap", label: "Sheen" },
  { key: "transmissionMap", label: "Transmit" },
  { key: "thicknessMap", label: "Thickness" },
  { key: "iridescenceMap", label: "Irid" },
];

export const TEXTURE_SLOT_KEYS: readonly string[] = TEXTURE_SLOTS.map((slot) => slot.key);

export interface TextureEntry {
  /** 贴图在引擎里的稳定标识（three 用 `texture.uuid`，PlayCanvas 用 `texture.id`）；多处复用时只出一条 */
  id: string;
  /** 命中的槽位合并名，如 glTF 的 metallicRoughness 一图两槽 → "Metal/Rough" */
  label: string;
  /** 用到这张贴图的材质名：同名通道（多个材质各有 Base Color）靠它区分 */
  materials: string[];
  width: number;
  height: number;
  /** 缩略图 data URL；压缩纹理（KTX2/Basis）等无法绘制的贴图为 null */
  dataUrl: string | null;
}

/** 模型自带材质在某个通道上的贴图；右侧栏的"当前贴图"缩略图就是它 */
export interface ChannelTexture {
  /** 模型里第一个真的填了这个通道的材质名（可能为空串，OBJ 的材质常常没有名字） */
  materialName: string;
  width: number;
  height: number;
  /** 无法绘制的压缩纹理为 null，此时右侧栏只显示"Compressed format"占位 */
  dataUrl: string | null;
}

const THUMB_SIZE = 96;
/** 缩略图缓存上限：单条是 96px PNG dataURL（约几 KB），长会话高频导入/删除也不无界累积 */
const MAX_THUMB_CACHE = 256;

/** 缩略图按贴图 id 缓存：同一份 loader 缓存里 id 稳定，反复 hover 不重画 */
const thumbCache = new Map<string, string | null>();

function cacheThumb(id: string, dataUrl: string | null): void {
  thumbCache.set(id, dataUrl);
  // Map 保持插入顺序，超限时淘汰最旧条目（FIFO），防模块级缓存随 id 数量无界增长
  while (thumbCache.size > MAX_THUMB_CACHE) {
    const oldest = thumbCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    thumbCache.delete(oldest);
  }
}

/** 只看缓存，不生成。测试与"是否已算过"的判断用。 */
export function peekThumbCache(id: string): string | null | undefined {
  return thumbCache.get(id);
}

export function thumbCacheSize(): number {
  return thumbCache.size;
}

/** DataTexture、压缩纹理的 image 不是 canvas 可直接绘制的源 */
export function isDrawableImage(image: unknown): image is CanvasImageSource {
  if (!image) return false;
  return (
    (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap) ||
    (typeof HTMLImageElement !== "undefined" && image instanceof HTMLImageElement) ||
    (typeof HTMLCanvasElement !== "undefined" && image instanceof HTMLCanvasElement)
  );
}

/**
 * 从贴图的 image 读原始尺寸。
 *
 * `image` 可能是 `ImageBitmap`（有 `width`/`height`）或 `HTMLImageElement`
 * （**`naturalWidth` 才是原始尺寸**，`width` 是 CSS 显示尺寸，常为 0）。两者都要认。
 */
export function imageSize(image: unknown): { width: number; height: number } {
  const candidate = image as { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number } | null;
  return {
    width: candidate?.naturalWidth ?? candidate?.width ?? 0,
    height: candidate?.naturalHeight ?? candidate?.height ?? 0,
  };
}

/** 把贴图画进 96px 缩略图并编码成 data URL；无法绘制时返回 null（并缓存该结果）。 */
export function textureThumbnail(id: string, image: unknown): string | null {
  const cached = thumbCache.get(id);
  if (cached !== undefined) return cached;

  let dataUrl: string | null = null;
  if (isDrawableImage(image)) {
    const canvas = document.createElement("canvas");
    canvas.width = THUMB_SIZE;
    canvas.height = THUMB_SIZE;
    const context = canvas.getContext("2d");
    if (context) {
      // 贴图本身可能是非正方形，缩略图统一按正方形拉伸——预览的是内容不是比例，
      // 真实尺寸在标注里给出
      context.drawImage(image, 0, 0, THUMB_SIZE, THUMB_SIZE);
      dataUrl = canvas.toDataURL("image/png");
    }
  }
  cacheThumb(id, dataUrl);
  return dataUrl;
}

/** 按 `TEXTURE_SLOTS` 的顺序把一组命中的槽位 key 合成展示名（`Metal/Rough`）。 */
export function combineSlotLabels(keys: readonly string[]): string {
  const order = new Map(TEXTURE_SLOTS.map((slot, index) => [slot.key, index]));
  return [...keys]
    .sort((a, b) => (order.get(a) ?? Number.MAX_SAFE_INTEGER) - (order.get(b) ?? Number.MAX_SAFE_INTEGER))
    .map((key) => TEXTURE_SLOTS.find((slot) => slot.key === key)?.label ?? key)
    .join("/");
}

/**
 * 规范通道 → 各引擎材质属性名。
 *
 * 为什么需要它：本表的 `key` 用的是 three 的属性名，而 PlayCanvas 并不相同
 * （base color 叫 `diffuseMap`、透明度叫 `opacityMap`、清漆叫 `clearCoatMap`…）。
 * 少了这层映射，PlayCanvas 侧会**静默地一个通道都发现不到**。
 *
 * `inverted` 与 `approximate` 是两张必须显式声明的语义旗标——它们对应的是
 * "照搬属性名会得到错误标注"这类静默错误：
 */
export interface EngineSlotBinding {
  /** 该引擎材质上的属性名。 */
  property: string;
  /**
   * `true` 表示该属性与规范通道**语义相反**，即数值越大代表的意义相反。
   * 典型：three 的 `roughnessMap`（越白越粗糙）对应 PlayCanvas 的 `glossMap`（越白越光滑）。
   * 预览可以照常显示这张图，但**标注必须说明**，否则用户会以为自己在调粗糙度而实际在调光泽。
   */
  inverted?: boolean;
  /**
   * `true` 表示只是近似对应（两者语义不同），UI 应当弱化标注而不是当成同一个通道。
   * 典型：three 的 `displacementMap`（顶点位移）与 PlayCanvas 的 `heightMap`（视差高度）。
   */
  approximate?: boolean;
}

/** PlayCanvas `StandardMaterial` 上的对应属性（属性名取自引擎 d.ts 的 `@property {Texture}` 列表）。 */
export const PLAYCANVAS_SLOTS: Readonly<Record<string, EngineSlotBinding>> = {
  map: { property: "diffuseMap" },
  normalMap: { property: "normalMap" },
  // PlayCanvas 没有 bump map —— 显式不映射，而不是随便指一个属性
  metalnessMap: { property: "metalnessMap" },
  roughnessMap: { property: "glossMap", inverted: true },
  aoMap: { property: "aoMap" },
  emissiveMap: { property: "emissiveMap" },
  alphaMap: { property: "opacityMap" },
  specularMap: { property: "specularMap" },
  displacementMap: { property: "heightMap", approximate: true },
  lightMap: { property: "lightMap" },
  clearcoatMap: { property: "clearCoatMap" },
  clearcoatRoughnessMap: { property: "clearCoatGlossMap", inverted: true },
  clearcoatNormalMap: { property: "clearCoatNormalMap" },
  sheenColorMap: { property: "sheenMap", approximate: true },
  transmissionMap: { property: "refractionMap", approximate: true },
  thicknessMap: { property: "thicknessMap" },
  iridescenceMap: { property: "iridescenceMap" },
};

/** 该引擎**不支持**的规范通道 → 原因。显式列出，避免"忘了映射"与"引擎没有"混为一谈。 */
export const PLAYCANVAS_UNSUPPORTED: Readonly<Record<string, string>> = {
  bumpMap: "PlayCanvas has no bump map (only normalMap)",
};

/**
 * 解析某个引擎下、某个规范通道该读哪个属性。
 * 返回 null 表示该引擎没有对应物（而不是"忘了配"——那由 `missingBindings` 兜住）。
 */
export function bindingFor(
  table: Readonly<Record<string, EngineSlotBinding>>,
  unsupported: Readonly<Record<string, string>>,
  slotKey: string,
): EngineSlotBinding | null {
  if (unsupported[slotKey]) return null;
  return table[slotKey] ?? null;
}

/**
 * 找出既没有映射、也没有显式声明不支持的规范通道。
 * 用途是把"新加了一个通道但忘了配映射"变成一条测试失败，而不是运行时静默漏报。
 */
export function missingBindings(
  table: Readonly<Record<string, EngineSlotBinding>>,
  unsupported: Readonly<Record<string, string>>,
): string[] {
  return TEXTURE_SLOT_KEYS.filter((key) => !table[key] && !unsupported[key]);
}
