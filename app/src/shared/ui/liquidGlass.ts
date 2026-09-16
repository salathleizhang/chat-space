/** liquid 档玻璃的内部实现(仅 Panel 使用):
    SVG 位移贴图生成 + Chromium 支持检测。
    贴图与滤镜结构移植自 opendesign-web 的液态玻璃导航
    (源头是 Inspira UI LiquidGlass.vue,参数 border 0.07 /
    lightness 50 / alpha 0.93 / blur 11 / blend difference)。 */

/** 位移贴图:横向红渐变控制 X 位移、纵向蓝渐变控制 Y 位移,
    中间一块模糊亮色让面板中心保持清晰、只有边缘折射。
    渐变 stop 用不透明黑而非透明色——透明 stop 以直通 alpha 插值,
    叠在黑底上 R 通道变成二次曲线,0.5 中性点偏移,折射会歪向一侧。 */
export function buildDisplacementMap(
  width: number,
  height: number,
  radius: number,
): string {
  const w = Math.max(1, Math.round(width));
  const h = Math.max(1, Math.round(height));
  const r = Math.min(Math.round(radius), Math.round(Math.min(w, h) / 2));
  const inset = Math.min(w, h) * 0.035;
  const svg =
    `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">` +
    "<defs>" +
    '<linearGradient id="red" x1="100%" y1="0%" x2="0%" y2="0%">' +
    '<stop offset="0%" stop-color="#000"/><stop offset="100%" stop-color="red"/>' +
    "</linearGradient>" +
    '<linearGradient id="blue" x1="0%" y1="0%" x2="0%" y2="100%">' +
    '<stop offset="0%" stop-color="#000"/><stop offset="100%" stop-color="blue"/>' +
    "</linearGradient>" +
    "</defs>" +
    `<rect width="${w}" height="${h}" fill="black"/>` +
    `<rect width="${w}" height="${h}" rx="${r}" fill="url(#red)"/>` +
    `<rect width="${w}" height="${h}" rx="${r}" fill="url(#blue)" style="mix-blend-mode:difference"/>` +
    `<rect x="${inset}" y="${inset}" width="${w - inset * 2}" height="${h - inset * 2}" rx="${r}" ` +
    'fill="hsl(0 0% 50% / 0.93)" style="filter:blur(11px)"/>' +
    "</svg>";
  return `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

let supported: boolean | null = null;

/** backdrop-filter 引用 SVG 滤镜只有 Chromium 支持;
    Safari/Firefox 能解析但不生效,所以 UA 排除后再做特性检测。 */
export function supportsLiquidGlass(): boolean {
  if (supported !== null) return supported;
  if (typeof window === "undefined" || typeof CSS === "undefined") {
    return (supported = false);
  }
  const ua = navigator.userAgent;
  const isSafari = /safari/i.test(ua) && !/chrom/i.test(ua);
  const isFirefox = /firefox/i.test(ua);
  if (isSafari || isFirefox) return (supported = false);
  supported =
    CSS.supports("backdrop-filter", "url(#gabo-liquid-probe)") ||
    CSS.supports("-webkit-backdrop-filter", "url(#gabo-liquid-probe)");
  return supported;
}
