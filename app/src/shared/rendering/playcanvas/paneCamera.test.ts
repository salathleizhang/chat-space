import { expect, test } from "bun:test";
import { isRectInBounds, paneClearFlags, panePriority, toCameraRect } from "./paneCamera";

/**
 * 这些换算在运行时**全是静默失败**：不报错、不崩，只是画面不对（整格黑、上下颠倒、
 * 或整块画布落到 "3D rendering needs WebGPU" 失败面板）。所以每一条约束都钉一个测试。
 */

const CANVAS = { width: 1000, height: 800 };

test("1 窗格：铺满整张画布 → (0,0,1,1)", () => {
  expect(toCameraRect({ left: 0, top: 0, width: 1000, height: 800 }, CANVAS)).toEqual({ x: 0, y: 0, z: 1, w: 1 });
});

test("左右分屏：右格 x=0.5，且**左格与右格都不动 y**", () => {
  const left = toCameraRect({ left: 0, top: 0, width: 500, height: 800 }, CANVAS);
  const right = toCameraRect({ left: 500, top: 0, width: 500, height: 800 }, CANVAS);
  expect(left).toEqual({ x: 0, y: 0, z: 0.5, w: 1 });
  expect(right).toEqual({ x: 0.5, y: 0, z: 0.5, w: 1 });
});

test("上下分屏：**上面那格 y=0.5**（这是最容易写反的一条）", () => {
  // 左上原点里 top=0 的那格在**上方**；换算到左下原点后它应当是 y=0.5。
  const top = toCameraRect({ left: 0, top: 0, width: 1000, height: 400 }, CANVAS);
  const bottom = toCameraRect({ left: 0, top: 400, width: 1000, height: 400 }, CANVAS);
  expect(top).toEqual({ x: 0, y: 0.5, z: 1, w: 0.5 });
  expect(bottom).toEqual({ x: 0, y: 0, z: 1, w: 0.5 });
});

test("2x2 四格：四块互不重叠且并集铺满（面积守恒）", () => {
  const rects = [
    toCameraRect({ left: 0, top: 0, width: 500, height: 400 }, CANVAS),
    toCameraRect({ left: 500, top: 0, width: 500, height: 400 }, CANVAS),
    toCameraRect({ left: 0, top: 400, width: 500, height: 400 }, CANVAS),
    toCameraRect({ left: 500, top: 400, width: 500, height: 400 }, CANVAS),
  ];
  expect(rects[0]).toEqual({ x: 0, y: 0.5, z: 0.5, w: 0.5 });   // 左上
  expect(rects[1]).toEqual({ x: 0.5, y: 0.5, z: 0.5, w: 0.5 }); // 右上
  expect(rects[2]).toEqual({ x: 0, y: 0, z: 0.5, w: 0.5 });     // 左下
  expect(rects[3]).toEqual({ x: 0.5, y: 0, z: 0.5, w: 0.5 });   // 右下
  expect(rects.reduce((sum, r) => sum + r.z * r.w, 0)).toBeCloseTo(1, 10);
});

test("分母用画布 CSS 尺寸：同一物理布局在 DPR=2 下得到同一个 rect", () => {
  // 归一化之后 CSS px / CSS 尺寸 与 buffer px / buffer 尺寸 是同一个值，
  // 所以调用方**不需要**知道 DPR。传错分母（拿 CSS px 去除 buffer 尺寸）会得到 0.25 而不是 0.5。
  const css = toCameraRect({ left: 500, top: 0, width: 500, height: 800 }, CANVAS);
  const buffer = toCameraRect({ left: 1000, top: 0, width: 1000, height: 1600 }, { width: 2000, height: 1600 });
  expect(css).toEqual(buffer);
  expect(css.z).toBe(0.5);
});

test("越界会被钳到 [0,1]（WebGPU 的 setViewport 不钳制，越界即验证错误）", () => {
  const overflow = toCameraRect({ left: -20, top: -20, width: 1200, height: 900 }, CANVAS);
  expect(overflow.x).toBe(0);
  expect(overflow.y).toBe(0);
  expect(overflow.z).toBe(1);
  expect(overflow.w).toBe(1);
  // 钳制会掩盖布局 bug，所以另给一个判据让调用方看得见
  expect(isRectInBounds({ left: -20, top: -20, width: 1200, height: 900 }, CANVAS)).toBe(false);
  expect(isRectInBounds({ left: 0, top: 0, width: 1000, height: 800 }, CANVAS)).toBe(true);
});

test("画布尺寸为 0（首帧、隐藏的分页）时返回全零而不是 NaN", () => {
  expect(toCameraRect({ left: 0, top: 0, width: 10, height: 10 }, { width: 0, height: 0 })).toEqual({ x: 0, y: 0, z: 0, w: 0 });
});

test("**每一格都必须清深度**，否则该格整格黑", () => {
  for (const index of [0, 1, 2, 3]) {
    expect({ index, ...paneClearFlags(index) }).toEqual({ index, clearColorBuffer: true, clearDepthBuffer: true });
  }
  // 即便调用方决定颜色只全局清一次，深度也必须逐格清
  expect(paneClearFlags(2, { clearColorPerPane: false })).toEqual({ clearColorBuffer: false, clearDepthBuffer: true });
});

test("窗格优先级按索引递增，保证渲染顺序与 DOM 顺序一致", () => {
  expect([0, 1, 2, 3].map(panePriority)).toEqual([0, 1, 2, 3]);
});
