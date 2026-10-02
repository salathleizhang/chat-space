import { describe, expect, test } from "bun:test";
import {
  BOX_PADDING_RATIO, boundsCenter, boundsFromCenterHalfExtents, boundsSize, highlightAppearance,
  HOVER_OPACITY, paddedBounds, unionBounds, UNIT_CUBE_EDGE_POSITIONS, wireframePositions,
} from "./selectionBounds";

const box = (min: [number, number, number], max: [number, number, number]) => ({ min, max });

describe("包围盒数学", () => {
  test("中心 + 半长 → min/max（拾取模块给的就是这个形状）", () => {
    expect(boundsFromCenterHalfExtents([1, 2, 3], [0.5, 1, 2])).toEqual({
      min: [0.5, 1, 1], max: [1.5, 3, 5],
    });
  });

  test("中心/尺寸；尺寸取绝对值", () => {
    const bounds = box([-1, 2, 3], [5, 2, -3]);
    expect(boundsCenter(bounds)).toEqual([2, 2, 0]);
    expect(boundsSize(bounds)).toEqual([6, 0, 6]);
  });

  test("合并多个盒（多选）；空列表没有盒", () => {
    const merged = unionBounds([box([0, 0, 0], [1, 1, 1]), box([-2, 0.5, 3], [0, 2, 4])])!;
    expect(merged.min).toEqual([-2, 0, 0]);
    expect(merged.max).toEqual([1, 2, 4]);
    expect(unionBounds([])).toBeNull();
  });

  test("外扩按**最大边长**的 2%（三轴同量，避免非等比变形）", () => {
    const padded = paddedBounds(box([0, 0, 0], [10, 2, 4]));
    const pad = 10 * BOX_PADDING_RATIO;
    expect(padded.min[0]).toBeCloseTo(-pad, 9);
    expect(padded.max[0]).toBeCloseTo(10 + pad, 9);
    expect(padded.min[1]).toBeCloseTo(-pad, 9);
    expect(padded.max[2]).toBeCloseTo(4 + pad, 9);
    // 退化盒（尺寸 0）不产生 NaN
    const degenerate = paddedBounds(box([1, 1, 1], [1, 1, 1]));
    expect(degenerate.min.every(Number.isFinite)).toBe(true);
    expect(degenerate.max.every(Number.isFinite)).toBe(true);
  });

  test("三态：none 不画、hover 淡（0.35）、selected 实（1）", () => {
    expect(highlightAppearance("none")).toEqual({ visible: false, opacity: 0 });
    expect(highlightAppearance("hover")).toEqual({ visible: true, opacity: HOVER_OPACITY });
    expect(highlightAppearance("selected")).toEqual({ visible: true, opacity: 1 });
  });
});

describe("线框顶点（12 条棱 / 24 个顶点）", () => {
  test("单位立方体：24 个顶点，每个顶点都在 ±0.5 上", () => {
    expect(UNIT_CUBE_EDGE_POSITIONS.length).toBe(24 * 3);
    for (const value of UNIT_CUBE_EDGE_POSITIONS) expect(Math.abs(value)).toBeCloseTo(0.5, 9);
    // 12 条棱：每两个顶点构成一条，且两端只在一个坐标上不同
    for (let edge = 0; edge < 12; edge += 1) {
      const a = UNIT_CUBE_EDGE_POSITIONS.slice(edge * 6, edge * 6 + 3);
      const b = UNIT_CUBE_EDGE_POSITIONS.slice(edge * 6 + 3, edge * 6 + 6);
      const differing = a.filter((value, axis) => Math.abs(value - b[axis]!) > 1e-9).length;
      expect(differing).toBe(1);
    }
  });

  test("任意盒的顶点 = 单位立方体按尺寸缩放、按中心平移（引擎侧的参照）", () => {
    const bounds = box([1, 2, 3], [3, 4, 9]);
    const positions = wireframePositions(bounds);
    expect(positions.length).toBe(24 * 3);
    for (let i = 0; i < positions.length; i += 3) {
      const expected = [
        boundsCenter(bounds)[0] + UNIT_CUBE_EDGE_POSITIONS[i]! * boundsSize(bounds)[0],
        boundsCenter(bounds)[1] + UNIT_CUBE_EDGE_POSITIONS[i + 1]! * boundsSize(bounds)[1],
        boundsCenter(bounds)[2] + UNIT_CUBE_EDGE_POSITIONS[i + 2]! * boundsSize(bounds)[2],
      ];
      expect([positions[i], positions[i + 1], positions[i + 2]]).toEqual(expected);
    }
    // 所有顶点都落在盒内
    for (let i = 0; i < positions.length; i += 3) {
      expect(positions[i]!).toBeGreaterThanOrEqual(bounds.min[0] - 1e-9);
      expect(positions[i]!).toBeLessThanOrEqual(bounds.max[0] + 1e-9);
    }
  });
});
