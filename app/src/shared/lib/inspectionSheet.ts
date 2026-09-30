/**
 * "视觉自检"四视角检查图的**纯数据与合成器**。不得导入 three / playcanvas。
 *
 * 这里只有两样东西，都不依赖引擎：
 *  ① `INSPECTION_VIEWS`：四个视角的**语义**（标签、朝向、上方向、投影方式）；
 *  ② `composeInspectionSheet`：把四张图拼成 2×2 并加标签——纯 canvas 工作。
 *
 * 引擎相关的只有"把相机摆到某个视角"这一步（three 见 `inspectionViews.ts`，
 * PlayCanvas 见 `shared/rendering/playcanvas/inspectionCapture.ts`）。
 * 把合成器抽出来是为了**两个引擎共用同一份版式**，而不是各写一遍。
 */

export interface InspectionView {
  label: string;
  dir: [number, number, number];
  up: [number, number, number];
  projection: "perspective" | "orthographic";
}

/** 与检查图提示词一致：ISO/前/右/顶；轴向视图不添加俯角。 */
export const INSPECTION_VIEWS: readonly InspectionView[] = [
  { label: "ISO", dir: [1, 0.8, 1], up: [0, 1, 0], projection: "perspective" },
  { label: "FRONT", dir: [0, 0, 1], up: [0, 1, 0], projection: "orthographic" },
  { label: "RIGHT", dir: [1, 0, 0], up: [0, 1, 0], projection: "orthographic" },
  // 俯视沿 -Y 看，屏幕上方为 -Z，与主视口一致。
  // 不能沿用 Y-up 再偏移 X/Z 来避开共线，否则会产生约 45° 的滚转。
  { label: "TOP", dir: [0, 1, 0], up: [0, 0, -1], projection: "orthographic" },
];

/** 每格的边长；检查图整体是 2×2 格。 */
export const SHEET_TILE = 512;

export interface SheetTileSource {
  /** 可绘制来源（canvas / ImageBitmap / 已经画好的图）。 */
  image: CanvasImageSource;
  /** 覆盖写在该格左上角的标注；不传则用 `INSPECTION_VIEWS[i].label`。 */
  label?: string;
}

/**
 * 把四张图拼成 2×2 检查图并加标注。返回的 canvas 由调用方决定怎么编码。
 *
 * 版式与 three 侧原先的内联实现逐项一致（同样的 14/32 偏移、22px 粗体、0.9 白字、
 * 0.25 的边框与十字线），所以两个引擎出来的检查图**长得一样**。
 */
export function composeInspectionSheet(tiles: readonly SheetTileSource[], tile = SHEET_TILE): HTMLCanvasElement {
  const sheet = document.createElement("canvas");
  sheet.width = tile * 2;
  sheet.height = tile * 2;
  const context = sheet.getContext("2d");
  if (!context) return sheet;

  for (const [index, entry] of tiles.entries()) {
    const x = (index % 2) * tile;
    const y = Math.floor(index / 2) * tile;
    // 少于四格时按实际数量画，不补空白格——缺图时上层会整体判失败，
    // 但合成器本身不该因为"只有三张"就崩。
    context.drawImage(entry.image, x, y, tile, tile);
    const label = entry.label ?? INSPECTION_VIEWS[index]?.label;
    if (!label) continue;
    context.fillStyle = "rgba(255,255,255,0.9)";
    context.font = "bold 22px system-ui, sans-serif";
    context.fillText(label, x + 14, y + 32);
  }

  context.strokeStyle = "rgba(255,255,255,0.25)";
  context.lineWidth = 2;
  context.strokeRect(0, 0, sheet.width, sheet.height);
  context.beginPath();
  context.moveTo(tile, 0);
  context.lineTo(tile, sheet.height);
  context.moveTo(0, tile);
  context.lineTo(sheet.width, tile);
  context.stroke();
  return sheet;
}

/** 把检查图编码成 base64（**不含** `data:` 前缀）——agent 回传要的就是这个形态。 */
export function sheetToBase64(sheet: HTMLCanvasElement): string {
  const dataUrl = sheet.toDataURL("image/png");
  // 防御"没有逗号"的情况：`slice(-1 + 1)` 会把**整串**（含 `data:image/png;base64`）
  // 当 base64 返回，上层会把一段非 base64 文本当图片上传。没有逗号就返回空串。
  const comma = dataUrl.indexOf(",");
  return comma < 0 ? "" : dataUrl.slice(comma + 1);
}
