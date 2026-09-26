import { describe, expect, test } from "bun:test";
import { placePopover } from "./popoverPosition";

/** 造一个视口矩形；只用到 top/bottom/left/width */
function rect(top: number, height: number, left = 100, width = 120): DOMRect {
  return {
    top,
    bottom: top + height,
    left,
    width,
    right: left + width,
    height,
    x: left,
    y: top,
    toJSON: () => ({}),
  } as DOMRect;
}

/** 测试环境没有真实视口，按需钉住视口尺寸 */
function withViewport(width: number, height: number, run: () => void) {
  const originalWidth = window.innerWidth;
  const originalHeight = window.innerHeight;
  Object.defineProperty(window, "innerWidth", { value: width, configurable: true });
  Object.defineProperty(window, "innerHeight", { value: height, configurable: true });
  try {
    run();
  } finally {
    Object.defineProperty(window, "innerWidth", { value: originalWidth, configurable: true });
    Object.defineProperty(window, "innerHeight", { value: originalHeight, configurable: true });
  }
}

describe("placePopover", () => {
  test("上方装得下就向上开，位置与锚点之间留出间隙", () => {
    withViewport(1600, 900, () => {
      const placement = placePopover(rect(600, 40), { preferredHeight: 200 });
      expect(placement.openUp).toBe(true);
      expect(placement.bottom).toBe(900 - 600 + 6);
      expect(placement.top).toBeUndefined();
      expect(placement.maxHeight).toBe(200);
    });
  });

  test("贴着屏幕顶部的锚点改为向下开，否则前面的选项会排到视口外", () => {
    withViewport(1600, 900, () => {
      // 右侧栏的 shader 选择器就是这个处境：上方 324px、下方 530px
      const placement = placePopover(rect(330, 40), { preferredHeight: 502, minWidth: 176 });
      expect(placement.openUp).toBe(false);
      expect(placement.top).toBe(370 + 6);
      expect(placement.bottom).toBeUndefined();
      expect(placement.maxHeight).toBe(502);
    });
  });

  test("两侧都装不下时选更宽裕的一侧，并把高度夹进余量", () => {
    withViewport(1600, 400, () => {
      // 上方 156px、下方 198px：向下，高度夹到 198
      const placement = placePopover(rect(162, 34), { preferredHeight: 502 });
      expect(placement.openUp).toBe(false);
      expect(placement.maxHeight).toBe(198);
    });
  });

  test("余量再小也留一个可点的高度下限", () => {
    withViewport(1600, 200, () => {
      // 上方 44px、下方 104px：向下，但 104 低于下限，抬到 120 让弹层仍可滚动
      const placement = placePopover(rect(50, 40), { preferredHeight: 502 });
      expect(placement.openUp).toBe(false);
      expect(placement.maxHeight).toBe(120);
    });
  });

  test("贴右边缘的锚点把弹层推回视口内，右侧那一列不会被切掉", () => {
    withViewport(1600, 900, () => {
      // 换图按钮就在右侧栏右边缘：left 1468、宽 28，弹层最小 232 宽
      const placement = placePopover(rect(500, 28, 1468, 28), {
        preferredHeight: 288,
        minWidth: 232,
      });
      expect(placement.minWidth).toBe(232);
      expect(placement.left).toBe(1600 - 232 - 8);
      expect(placement.left + placement.minWidth).toBeLessThanOrEqual(1600);
    });
  });

  test("左侧空间够时保持与锚点左对齐", () => {
    withViewport(1600, 900, () => {
      const placement = placePopover(rect(500, 28, 400, 28), {
        preferredHeight: 288,
        minWidth: 232,
      });
      expect(placement.left).toBe(400);
    });
  });

  test("视口比弹层还窄时退到左边距，不产生负坐标", () => {
    withViewport(200, 900, () => {
      const placement = placePopover(rect(500, 28, 120, 28), {
        preferredHeight: 288,
        minWidth: 232,
      });
      expect(placement.left).toBe(8);
    });
  });
});
