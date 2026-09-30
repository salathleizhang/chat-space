import { describe, expect, test } from "bun:test";
import type { ObjectBox } from "../dto/library";
import type { ModelBounds } from "./modelBounds";
import {
  computePlacement,
  DEFAULT_PLACEMENT_CAMERA,
  MAX_PLACEMENT_DEPTH,
  resolvePlacementCamera,
} from "./scenePlacement";

/**
 * 默认相机（高 1.5 m、竖直视场角 60°）下的归一化焦距：
 * f = 0.5 / tan(30°) ≈ 0.8660。接地行 0.9、地平线 0.5 → 纵深 = 1.5×f/0.4。
 */
const FOCAL = 0.5 / Math.tan((60 * Math.PI) / 360);
const CENTERED: ObjectBox = [0.4, 0.6, 0.6, 0.9];

function bounds(min: [number, number, number], max: [number, number, number]): ModelBounds {
  return {
    min,
    max,
    size: [max[0] - min[0], max[1] - min[1], max[2] - min[2]],
  };
}

describe("resolvePlacementCamera", () => {
  test("缺项用安全默认值补齐，给了就用给的值", () => {
    expect(resolvePlacementCamera()).toEqual(DEFAULT_PLACEMENT_CAMERA);
    expect(resolvePlacementCamera({ horizonRow: 0.42 })).toEqual({
      ...DEFAULT_PLACEMENT_CAMERA,
      horizonRow: 0.42,
    });
  });
});

describe("computePlacement 单目反投影", () => {
  test("画面中央、接地行 0.9：纵深 = 相机高 × 焦距 / 行距，横向为 0", () => {
    const placement = computePlacement(
      { box: CENTERED },
      { camera: DEFAULT_PLACEMENT_CAMERA, aspect: 4 / 3 },
    );
    expect(placement.depth).toBeCloseTo((1.5 * FOCAL) / 0.4, 6);
    expect(placement.position[0]).toBeCloseTo(0, 6);
    // 相机看 −Z，正前方就是负 z。
    expect(placement.position[2]).toBeCloseTo(-(1.5 * FOCAL) / 0.4, 6);
    expect(placement.position[1]).toBe(0);
    expect(placement.scale).toEqual([1, 1, 1]);
    expect(placement.grounded).toBe(false);
    expect(placement.clamped).toBe(false);
  });

  test("横向位置按视场角换算：同样的行距下，右移半格 = 纵深 × 0.25 × aspect / f", () => {
    const depth = (1.5 * FOCAL) / 0.4;
    const placement = computePlacement(
      { box: [0.65, 0.6, 0.85, 0.9] },
      { camera: DEFAULT_PLACEMENT_CAMERA, aspect: 4 / 3 },
    );
    expect(placement.position[0]).toBeCloseTo((depth * 0.25 * (4 / 3)) / FOCAL, 6);
    // 物体正面朝向相机（+Z 指向原点）。
    expect(placement.rotation[1]).toBeCloseTo(
      Math.atan2(-placement.position[0], depth),
      6,
    );
  });

  test("宽高比影响横向：同样的框在 3:2 图上摆得更靠外", () => {
    const box: ObjectBox = [0.6, 0.6, 0.8, 0.9];
    const wide = computePlacement({ box }, { camera: DEFAULT_PLACEMENT_CAMERA, aspect: 1.5 });
    const square = computePlacement({ box }, { camera: DEFAULT_PLACEMENT_CAMERA, aspect: 1 });
    expect(wide.position[0]).toBeGreaterThan(square.position[0]);
    expect(wide.position[0] / square.position[0]).toBeCloseTo(1.5, 6);
  });

  test("贴在/高于地平线时纵深夹到上限，而不是趋于无穷", () => {
    const placement = computePlacement(
      { box: [0.4, 0.2, 0.6, 0.5] },
      { camera: DEFAULT_PLACEMENT_CAMERA, aspect: 4 / 3 },
    );
    expect(placement.clamped).toBe(true);
    expect(placement.depth).toBe(MAX_PLACEMENT_DEPTH);
    expect(Number.isFinite(placement.position[2])).toBe(true);
  });

  test("给了真实高度就按包围盒归一到现实尺寸，并把脚底贴到地面", () => {
    const placement = computePlacement(
      { box: CENTERED, heightMeters: 1, bounds: bounds([0, -1, 0], [1, 1, 1]) },
      { camera: DEFAULT_PLACEMENT_CAMERA, aspect: 4 / 3 },
    );
    // 量到 2 m 高、目标 1 m → 缩放 0.5；包围盒最低点 −1 缩到 −0.5，抬回 0.5 才贴地。
    expect(placement.scale).toEqual([0.5, 0.5, 0.5]);
    expect(placement.position[1]).toBeCloseTo(0.5, 6);
  });

  test("有地形数据时脚底落在真实地面上", () => {
    const placement = computePlacement(
      { box: CENTERED, bounds: bounds([0, 0, 0], [1, 1, 1]) },
      {
        camera: DEFAULT_PLACEMENT_CAMERA,
        aspect: 4 / 3,
        sampleGround: (x, z) => (Math.abs(x) < 0.01 ? 0.35 : null),
      },
    );
    expect(placement.grounded).toBe(true);
    expect(placement.position[1]).toBeCloseTo(0.35, 6);
  });

  test("退化包围盒（量到 0 高）不缩放模型，避免比例炸掉", () => {
    const placement = computePlacement(
      { box: CENTERED, heightMeters: 1, bounds: bounds([0, 0, 0], [1, 0, 1]) },
      { camera: DEFAULT_PLACEMENT_CAMERA, aspect: 4 / 3 },
    );
    expect(placement.scale).toEqual([1, 1, 1]);
    expect(placement.position[1]).toBe(0);
  });
});
