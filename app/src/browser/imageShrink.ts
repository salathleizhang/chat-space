import type { InlineImageShrinker } from "../../../chat/src/services/assetStorage";

/**
 * 浏览器侧的图片瘦身：把要塞进请求体的大图缩到 1024px 的 JPEG。
 *
 * 背景见 `assetStorage.ts` 的 `InlineImageShrinker`：请求体要走两跳，而
 * `Vercel(美东) → 火山(北京)` 那一跳实测只有 ~12 KB/s，3MB 的手机照片要 4 分钟，
 * 正好撞满 Vercel 的 300 秒函数上限（504）。缩到 1024px / JPEG q80 之后典型只有
 * 100~200KB，传输和供应商侧的视觉 token 一起降一个量级。
 *
 * 三条纪律：
 * ① **失败一律回退原图**——瘦身是优化，不能因为它让本来能跑的请求挂掉；
 * ② **有缓存**——同一个资产在一轮对话里最多要被内联 12 次（agent 每一步都要重发
 *    完整上下文），每次重新解码+编码就是白白烧 CPU；
 * ③ **小图不碰**——解码重编码本身有成本，收益为负时直接返回 undefined。
 */
const MAX_EDGE = 1024;
const JPEG_QUALITY = 0.8;
/** 小于这个体积的图不值得解码重编码（典型 1024px JPEG 也在这个量级） */
const SHRINK_THRESHOLD_BYTES = 128 * 1024;
/** 缓存上限：一轮对话里出现的图片数量级；超出按插入顺序淘汰最旧的。 */
const CACHE_LIMIT = 24;

const cache = new Map<string, { bytes: Uint8Array; mime: string }>();

/** 浏览器能力探测：缺任何一项就完全不装瘦身器，行为与改造前一致。 */
export const canShrinkInlineImages =
  typeof OffscreenCanvas !== "undefined" && typeof createImageBitmap === "function";

export const shrinkInlineImage: InlineImageShrinker = async ({ bytes, mime, logicalPath }) => {
  if (!canShrinkInlineImages) return undefined;
  if (bytes.byteLength < SHRINK_THRESHOLD_BYTES) return undefined;
  const key = `${logicalPath}:${bytes.byteLength}`;
  const cached = cache.get(key);
  if (cached) return cached;
  try {
    const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type: mime }));
    try {
      const longest = Math.max(bitmap.width, bitmap.height);
      const scale = Math.min(1, MAX_EDGE / longest);
      if (scale >= 1) return undefined;
      const width = Math.max(1, Math.round(bitmap.width * scale));
      const height = Math.max(1, Math.round(bitmap.height * scale));
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext("2d");
      if (!context) return undefined;
      context.drawImage(bitmap, 0, 0, width, height);
      const blob = await canvas.convertToBlob({ type: "image/jpeg", quality: JPEG_QUALITY });
      const shrunk = new Uint8Array(await blob.arrayBuffer());
      // 重编码反而更大（小尺寸高压缩图）时不动它
      if (shrunk.byteLength >= bytes.byteLength) return undefined;
      const result = { bytes: shrunk, mime: "image/jpeg" };
      if (cache.size >= CACHE_LIMIT) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(key, result);
      return result;
    } finally {
      bitmap.close();
    }
  } catch {
    return undefined;
  }
};
