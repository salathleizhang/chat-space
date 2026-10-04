import { describe, expect, test } from "bun:test";
import { MIN_HALF_EXTENT, centerFromBounds, halfExtentsFromBounds } from "./physicsBodies";

describe("PC 盒体碰撞体：包围盒 → 半尺寸", () => {
  test("普通盒：半尺寸 = 尺寸的一半，中心 = min/max 中点", () => {
    const bounds = { min: [-1, 0, -2] as [number, number, number], max: [1, 3, 2] as [number, number, number] };
    expect(halfExtentsFromBounds(bounds)).toEqual([1, 1.5, 2]);
    expect(centerFromBounds(bounds)).toEqual([0, 1.5, 0]);
  });

  test("偏移盒：中心跟着走（PC 没有 three 的 `<Center>`，不补偏移碰撞体就会跟模型错开）", () => {
    const bounds = { min: [4, 5, 6] as [number, number, number], max: [5, 6, 7] as [number, number, number] };
    expect(centerFromBounds(bounds)).toEqual([4.5, 5.5, 6.5]);
    expect(halfExtentsFromBounds(bounds)).toEqual([0.5, 0.5, 0.5]);
  });

  test("退化盒（厚度为 0，例如贴地地毯）钳到最小半边，不产生零尺寸碰撞体", () => {
    const bounds = { min: [0, 0, 0] as [number, number, number], max: [2, 0, 2] as [number, number, number] };
    const half = halfExtentsFromBounds(bounds);
    expect(half?.[1]).toBe(MIN_HALF_EXTENT);
    expect(half?.[0]).toBe(1);
  });

  test("拿不到包围盒时显式返回 null（宁可跳过挂载，也不挂一个零尺寸碰撞体）", () => {
    expect(halfExtentsFromBounds(null)).toBeNull();
    expect(halfExtentsFromBounds(undefined)).toBeNull();
    expect(centerFromBounds(null)).toBeNull();
  });
});
