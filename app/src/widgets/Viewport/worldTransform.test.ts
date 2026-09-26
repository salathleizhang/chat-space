import { describe, expect, test } from "bun:test";
import { DEFAULT_WORLD_SEMANTICS } from "../../shared/lib/libraryApi";
import { worldTransform } from "./worldTransform";

/**
 * World Labs 的 +Y 朝下，这三个参数是泼溅与 collider **共同**的对齐契约。
 * 这个函数的唯一职责就是把它们翻成 three.js 的 group 变换，所以断言写死数值。
 */
describe("worldTransform", () => {
  test("flipY 为真时绕 X 轴转 π，把 −Y 变成「上」", () => {
    expect(worldTransform(DEFAULT_WORLD_SEMANTICS).rotation).toEqual([Math.PI, 0, 0]);
  });

  test("flipY 为假时不旋转", () => {
    const transform = worldTransform({
      flipY: false,
      metricScaleFactor: 1,
      groundPlaneOffset: 0,
    });
    expect(transform.rotation).toEqual([0, 0, 0]);
  });

  test("缩放落在 scale、地面偏移落在 Y 平移，X/Z 不平移", () => {
    const transform = worldTransform({
      flipY: true,
      metricScaleFactor: 2.6222534,
      groundPlaneOffset: 1.5924374,
    });
    expect(transform.scale).toBeCloseTo(2.6222534, 6);
    expect(transform.position).toEqual([0, 1.5924374, 0]);
  });

  test("缺省值不会引入任何变换", () => {
    const transform = worldTransform(DEFAULT_WORLD_SEMANTICS);
    expect(transform.scale).toBe(1);
    expect(transform.position).toEqual([0, 0, 0]);
  });
});
