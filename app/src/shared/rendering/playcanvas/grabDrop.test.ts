import { describe, expect, test } from "bun:test";
import { dropPlacementMoved, dropSettled } from "./grabDrop";
import type { Placement } from "./selectionTransform";

/**
 * 假数据用**摆放的形状**（位置 / 弧度 XYZ / 缩放）。
 * 关键用例与 three 侧 `grabCommit.test.ts` 一一对应：两个引擎的判据必须同口径，
 * 否则"抓一下"在两条渲染路径上的行为会不一样。
 */
const placed = (over: Partial<Placement> = {}): Placement => ({
  position: [1, 0, 2],
  rotation: [0, 0, 0],
  scale: [1, 1, 1],
  ...over,
});

describe("dropSettled", () => {
  test("两个速度都小：停下了", () => {
    expect(dropSettled({ x: 0.01, y: 0, z: 0.01 }, { x: 0.02, y: 0, z: 0 })).toBe(true);
  });

  test("还在滑（线速度 0.5）：没停", () => {
    expect(dropSettled({ x: 0.5, y: 0, z: 0 }, { x: 0, y: 0, z: 0 })).toBe(false);
  });

  test("原地打转（角速度 0.5）：没停——只转不走的陀螺也是没停", () => {
    expect(dropSettled({ x: 0, y: 0, z: 0 }, { x: 0.5, y: 0, z: 0 })).toBe(false);
  });
});

describe("dropPlacementMoved", () => {
  test("一动没动：不提交", () => {
    expect(dropPlacementMoved(placed(), placed())).toBe(false);
  });

  test("同一姿态的另一种欧拉写法不算动过（(0,π,0) 与 (π,0,π) 是同一个朝向）", () => {
    const before = placed({ rotation: [0, Math.PI, 0] });
    const after = placed({ rotation: [Math.PI, 0, Math.PI] });
    expect(dropPlacementMoved(before, after)).toBe(false);
  });

  test("位置挪过 1 cm：算动过", () => {
    expect(dropPlacementMoved(placed(), placed({ position: [1.01, 0, 2] }))).toBe(true);
  });

  test("只转过 1 弧度：算动过（位置没变也要提交）", () => {
    expect(dropPlacementMoved(placed(), placed({ rotation: [0, 1, 0] }))).toBe(true);
  });

  test("只转过 0.0001 弧度（物理解算抖动）：不算动过", () => {
    expect(dropPlacementMoved(placed(), placed({ rotation: [0, 0.0001, 0] }))).toBe(false);
  });
});
