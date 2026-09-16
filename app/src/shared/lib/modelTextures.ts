import type { Material, Object3D, Texture } from "three";

/**
 * 从已加载的模型对象里抽出贴图缩略图，供模型栏悬浮卡预览各通道（base color / normal / MR …）。
 *
 * 为什么在前端做：生成/导入的 glb 把贴图内嵌在 bufferView 里，磁盘上没有独立 PNG 文件，
 * `<img src>` 拿不到。而 Viewport 已经把项目全部资产渲染进场景，同一个 URL 的
 * `useGLTF`/`useLoader` 缓存里已经躺着解析好的 THREE.Texture——直接读 `texture.image`
 * 画进 canvas 即可，命中缓存时零网络请求、零解码。
 */

/**
 * three 材质上的贴图槽位 → 展示名；覆盖 glTF PBR 与 OBJ/FBX 常见的 phong 槽位。
 * 展示名刻意用短写（Metal/Rough 而非 Metallic/Roughness）：一图两槽合并后要塞进
 * 96px 宽的缩略图标注里，全称会被截断。
 */
const TEXTURE_SLOTS: { key: string; label: string }[] = [
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

export interface TextureEntry {
  /** texture.uuid，同一张贴图在多个材质/槽位复用时只出一条 */
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

const THUMB_SIZE = 96;
/** 缩略图缓存上限：单条是 96px PNG dataURL（约几 KB），长会话高频导入/删除也不无界累积 */
const MAX_THUMB_CACHE = 256;

/** 缩略图按 texture.uuid 缓存：同一份 loader 缓存里 uuid 稳定，反复 hover 不重画 */
const thumbCache = new Map<string, string | null>();

function cacheThumb(uuid: string, dataUrl: string | null): void {
  thumbCache.set(uuid, dataUrl);
  // Map 保持插入顺序，超限时淘汰最旧条目（FIFO），防模块级缓存随 uuid 数量无界增长
  while (thumbCache.size > MAX_THUMB_CACHE) {
    const oldest = thumbCache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    thumbCache.delete(oldest);
  }
}

/** DataTexture、压缩纹理的 image 不是 canvas 可直接绘制的源 */
function isDrawable(image: unknown): image is CanvasImageSource {
  if (!image) return false;
  return (
    (typeof ImageBitmap !== "undefined" && image instanceof ImageBitmap) ||
    image instanceof HTMLImageElement ||
    image instanceof HTMLCanvasElement
  );
}

function renderThumb(texture: Texture): string | null {
  const cached = thumbCache.get(texture.uuid);
  if (cached !== undefined) return cached;

  let dataUrl: string | null = null;
  const image = texture.image as unknown;
  if (isDrawable(image)) {
    const canvas = document.createElement("canvas");
    canvas.width = THUMB_SIZE;
    canvas.height = THUMB_SIZE;
    const ctx = canvas.getContext("2d");
    if (ctx) {
      // 贴图本身可能是非正方形，缩略图统一按正方形拉伸——预览的是内容不是比例，
      // 真实尺寸在标注里给出
      ctx.drawImage(image, 0, 0, THUMB_SIZE, THUMB_SIZE);
      dataUrl = canvas.toDataURL("image/png");
    }
  }
  cacheThumb(texture.uuid, dataUrl);
  return dataUrl;
}

/** image 可能是 ImageBitmap（有 width/height）或 HTMLImageElement（naturalWidth 才是原始尺寸） */
function textureSize(texture: Texture): { width: number; height: number } {
  const image = texture.image as { width?: number; height?: number; naturalWidth?: number; naturalHeight?: number } | null;
  return {
    width: image?.naturalWidth ?? image?.width ?? 0,
    height: image?.naturalHeight ?? image?.height ?? 0,
  };
}

/**
 * 遍历模型全部材质，按 texture.uuid 去重收集贴图。
 * 跨材质共用同一张贴图时也只出一条——预览的是"这个模型用了哪些贴图"，不是材质清单。
 */
export function collectTextureEntries(root: Object3D): TextureEntry[] {
  /** uuid → 该贴图命中的全部槽位展示名（按 TEXTURE_SLOTS 顺序累积） */
  const slotLabels = new Map<string, string[]>();
  /** uuid → 用到这张贴图的材质名 */
  const materialNames = new Map<string, string[]>();
  const textures = new Map<string, Texture>();

  root.traverse((node) => {
    const material = (node as { material?: Material | Material[] }).material;
    if (!material) return;
    for (const mat of Array.isArray(material) ? material : [material]) {
      for (const slot of TEXTURE_SLOTS) {
        const texture = (mat as unknown as Record<string, unknown>)[slot.key] as Texture | null | undefined;
        if (!texture?.isTexture) continue;
        textures.set(texture.uuid, texture);
        const labels = slotLabels.get(texture.uuid) ?? [];
        if (!labels.includes(slot.label)) labels.push(slot.label);
        slotLabels.set(texture.uuid, labels);
        const names = materialNames.get(texture.uuid) ?? [];
        if (mat.name && !names.includes(mat.name)) names.push(mat.name);
        materialNames.set(texture.uuid, names);
      }
    }
  });

  const entries: TextureEntry[] = [];
  for (const [uuid, texture] of textures) {
    const { width, height } = textureSize(texture);
    entries.push({
      id: uuid,
      label: (slotLabels.get(uuid) ?? []).join("/"),
      materials: materialNames.get(uuid) ?? [],
      width,
      height,
      dataUrl: renderThumb(texture),
    });
  }
  return entries;
}
