import { expect, test } from "bun:test";
import {
  composeInspectionSheet,
  INSPECTION_VIEW_IDS,
  INSPECTION_VIEW_LIBRARY,
  INSPECTION_VIEWS,
  isInspectionViewId,
  resolveInspectionViews,
  SHEET_TILE,
  sheetToBase64,
} from "./inspectionSheet";

test("四个视角的定义：标签与投影方式固定，TOP 的上方向是 -Z", () => {
  expect(INSPECTION_VIEWS.map((view) => view.label)).toEqual(["ISO", "FRONT", "RIGHT", "TOP"]);
  expect(INSPECTION_VIEWS.map((view) => view.projection)).toEqual([
    "perspective", "orthographic", "orthographic", "orthographic",
  ]);
  // 俯视沿 -Y 看、屏幕上方向为 -Z。若沿用 Y-up 再偏移 X/Z 会产生约 45° 滚转——
  // 这条断言把这个约定钉住，免得后来人"顺手"改成 (0,1,0)。
  expect(INSPECTION_VIEWS.find((view) => view.label === "TOP")!.up).toEqual([0, 0, -1]);
});

test("合成器输出的画布是 2×2 格；少于四格也不崩", () => {
  const tile = 32; // 小尺寸：happy-dom 下画布能力有限，这里只验版式尺寸
  const source = { drawImage: () => {}, fillText: () => {}, strokeRect: () => {}, beginPath: () => {}, moveTo: () => {}, lineTo: () => {}, stroke: () => {} };
  const original = HTMLCanvasElement.prototype.getContext;
  // happy-dom 的 2d context 能力有限，这里注入一个最小 context 以验证版式路径
  HTMLCanvasElement.prototype.getContext = function () { return source; } as never;
  try {
    const full = composeInspectionSheet([{ image: {} as never }, { image: {} as never }, { image: {} as never }, { image: {} as never }], tile);
    expect({ w: full.width, h: full.height }).toEqual({ w: tile * 2, h: tile * 2 });
    const partial = composeInspectionSheet([{ image: {} as never }], tile);
    expect(partial.width).toBe(tile * 2);
  } finally {
    HTMLCanvasElement.prototype.getContext = original;
  }
});

test("base64 结果不含 data: 前缀（agent 回传要的就是裸 base64）", () => {
  const fake = { toDataURL: () => "data:image/png;base64,QUJD" } as unknown as HTMLCanvasElement;
  expect(sheetToBase64(fake)).toBe("QUJD");
  // 没有逗号时不能把整串当 base64 返回
  const noComma = { toDataURL: () => "data:image/png;base64" } as unknown as HTMLCanvasElement;
  expect(sheetToBase64(noComma)).toBe("");
});

test("默认每格边长是 512，整体 1024", () => {
  expect(SHEET_TILE).toBe(512);
});

test("视角库有七个面，默认四视角只是它的子集（用户点名看某个方向时按 id 取）", () => {
  expect(INSPECTION_VIEW_IDS).toEqual(["iso", "front", "right", "top", "left", "back", "bottom"]);
  // 左/后/底是给"用户点名要看这个方向"准备的，不在默认四视角里
  expect(INSPECTION_VIEW_LIBRARY.left.dir).toEqual([-1, 0, 0]);
  expect(INSPECTION_VIEW_LIBRARY.back.dir).toEqual([0, 0, -1]);
  expect(INSPECTION_VIEW_LIBRARY.bottom.dir).toEqual([0, -1, 0]);
  // 仰视的屏幕上方向取 +Z，否则底面图会相对俯视图左右翻转
  expect(INSPECTION_VIEW_LIBRARY.bottom.up).toEqual([0, 0, 1]);
});

test("resolveInspectionViews：省略回落四视角，指定子集时只给这些面且顺序不变", () => {
  expect(resolveInspectionViews().map((view) => view.label)).toEqual([
    "ISO", "FRONT", "RIGHT", "TOP",
  ]);
  expect(resolveInspectionViews([]).map((view) => view.label)).toEqual([
    "ISO", "FRONT", "RIGHT", "TOP",
  ]);
  expect(resolveInspectionViews(["bottom"]).map((view) => view.label)).toEqual(["BOTTOM"]);
  expect(resolveInspectionViews(["back", "left"]).map((view) => view.label)).toEqual(["BACK", "LEFT"]);
});

test("isInspectionViewId 只认名单里的 id（模型给错名字时不静默变成别的视角）", () => {
  expect(isInspectionViewId("top")).toBe(true);
  expect(isInspectionViewId("diagonal")).toBe(false);
  expect(isInspectionViewId(7)).toBe(false);
});
